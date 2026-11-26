import { NextResponse } from "next/server";
import { modelPackageInfo } from "@/lib/translation/model";
import { resolveRuntime, translationEngine } from "@/lib/translation/engine";
import { protectText, restoreText, leftoverPlaceholders, correctOutput } from "@/lib/translation/protect";
import { onlineConfig, translateOnline } from "@/lib/translation/online";
import { deeplConfig, translateWithDeepL } from "@/lib/translation/deepl";
import { sanitizeParagraph, decapitalizeForModel, SKIP_LABEL, type Sanitized } from "@/lib/translation/sanitize";
import { checkTranslation, QUALITY_LABEL, type QualityVerdict } from "@/lib/translation/quality";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type RequestBody = { texts?: string[]; mode?: string; provider?: string };

type Masked = { text: string; tokens: string[]; counts: number; use: boolean; density: number };

type ItemResult = {
  source: string;
  translation: string;
  ms: number;
  tokens?: number;
  protectedCount: number;
  unresolved: string[];
  skipped?: boolean;
  skipLabel?: string;
  protectionSkipped?: boolean;
  degraded?: boolean;
  qualityFailed?: boolean;
  qualityReason?: string;
};

/** 保护密度检查：整段都是型号/编号时，过度占位会把句子变成 [[Z0]] - [[Z1]]… 模型只能吐 ??。 */
function maskFor(text: string): Masked {
  const words = Math.max(1, text.split(/\s+/).length);
  const protectedItem = protectText(text);
  const density = protectedItem.counts / words;
  const use = protectedItem.counts > 0 && protectedItem.counts <= 40 && density <= 0.35;
  return { ...protectedItem, use, density };
}

function prepare(texts: string[]) {
  const sanitized: Sanitized[] = texts.map((text) => sanitizeParagraph(text));
  const targets = sanitized.map((item, index) => ({ item, index })).filter(({ item }) => !item.skip);
  return { sanitized, targets };
}

/** 还原占位符；如果模型把占位符吃掉了（输出里几乎找不到 [[Zn]]），标记为降级，改用无保护直译。 */
function restoreOrDegrade(masked: Masked, modelText: string) {
  const restored = restoreText(modelText, masked.tokens);
  const leftovers = leftoverPlaceholders(restored);
  const questionMarks = (restored.match(/\?\?/g) || []).length;
  const survived = masked.tokens.length === 0
    || (leftovers.length === 0 && questionMarks < Math.max(3, masked.tokens.length * 0.3));
  return { restored, leftovers, survived };
}

/**
 * strictQuality：重复/过短这类检查是为本机 OPUS-MT 卡循环设计的，只对离线引擎开启。
 * 在线引擎（DeepL、智谱）不会卡循环，但型号密集的正常译文（STM32F101xx、STM32F102xx…）
 * 不同字符占比很低，会被“字符重复度”误判清空；在线引擎只在完全没返回时才算失败。
 */
function assemble(
  texts: string[],
  sanitized: Sanitized[],
  translated: { text: string; ms: number; tokens?: number }[],
  masks: Masked[],
  strictQuality = true,
) {
  let cursor = 0;
  return texts.map((source, index): ItemResult => {
    const guard = sanitized[index];
    if (guard.skip) {
      return {
        source,
        translation: "",
        ms: 0,
        protectedCount: 0,
        unresolved: [],
        skipped: true,
        skipLabel: guard.reason ? SKIP_LABEL[guard.reason] : "未翻译",
      };
    }
    const mask = masks[cursor];
    const result = translated[cursor] ?? { text: "", ms: 0 };
    cursor += 1;
    const { restored, leftovers, survived } = mask?.use
      ? restoreOrDegrade(mask, result.text)
      : { restored: result.text, leftovers: [], survived: true };
    const cleaned = correctOutput(restored);
    const quality: QualityVerdict = strictQuality
      ? checkTranslation(source, cleaned)
      : cleaned.trim() ? { ok: true } : { ok: false, reason: "empty" };
    return {
      source,
      translation: quality.ok ? cleaned : "",
      ms: result.ms,
      tokens: result.tokens,
      protectedCount: mask?.use ? mask.counts : 0,
      unresolved: leftovers,
      protectionSkipped: Boolean(mask && !mask.use && mask.counts > 0),
      degraded: Boolean(mask?.use && !survived),
      qualityFailed: !quality.ok,
      qualityReason: quality.ok ? undefined : QUALITY_LABEL[quality.reason!],
    };
  });
}

type Timing = { glmMs: number; deeplMs: number; provider: string };

export async function POST(request: Request) {
  const started = performance.now();
  const timing: Timing = { glmMs: 0, deeplMs: 0, provider: "unknown" };
  const label = request.headers.get("x-xinzh-timing-id");
  const id = label && /^[a-zA-Z0-9_-]{1,64}$/.test(label) ? label : crypto.randomUUID();
  let status = 500;
  try {
    const response = await translateRequest(request, timing);
    status = response.status;
    return response;
  } finally {
    console.info("[translation-timing]", JSON.stringify({ id, provider: timing.provider, status, totalMs: Math.round(performance.now() - started), glmMs: timing.glmMs, deeplMs: timing.deeplMs }));
  }
}

async function translateRequest(request: Request, timing: Timing) {
  const body = (await request.json().catch(() => null)) as RequestBody | null;
  const texts = (body?.texts || []).map((text) => String(text || "").trim()).filter(Boolean).slice(0, 24);
  const requested = body?.provider;
  const provider = requested === "online" || requested === "deepl" ? requested : "offline";
  timing.provider = provider;
  if (!texts.length) {
    return NextResponse.json({ ok: false, code: "empty", error: "没有要翻译的段落。" }, { status: 400 });
  }

  const { sanitized, targets } = prepare(texts);
  if (!targets.length) {
    return NextResponse.json({
      ok: true,
      provider,
      engine: "skipped",
      totalMs: 0,
      items: assemble(texts, sanitized, [], []),
      note: "这一页都是目录/索引/页码行，已跳过翻译。",
    });
  }

  if (provider === "deepl") {
    const config = deeplConfig();
    if (!config.configured) {
      return NextResponse.json({
        ok: false,
        code: "deepl_not_configured",
        error: "没有配置 DeepL API key。把 key 写进 .deepl-key 文件，或改用本机离线模型。",
      }, { status: 409 });
    }
    try {
      const masks = targets.map(({ item }) => maskFor(item.text));
      const payload = masks.map((mask, index) => decapitalizeForModel(mask.use ? mask.text : targets[index].item.text));
      const engineStarted = performance.now();
      const result = await translateWithDeepL(payload).finally(() => {
        timing.deeplMs = Math.round(performance.now() - engineStarted);
      });
      return NextResponse.json({
        ok: true,
        provider: "deepl",
        engine: `DeepL（${config.mode}，在线，已发送当前段落）`,
        totalMs: result.totalMs,
        items: assemble(texts, sanitized, result.items, masks, false),
      });
    } catch (error) {
      return NextResponse.json({
        ok: false,
        code: "deepl_failed",
        error: error instanceof Error ? error.message : "DeepL 翻译失败。",
      }, { status: 502 });
    }
  }

  if (provider === "online") {
    const online = onlineConfig();
    if (!online.configured) {
      return NextResponse.json({
        ok: false,
        code: "online_not_configured",
        error: "没有配置在线模型的 API key。把 key 写进 .zhipu-key 文件，或改用本机离线模型。",
      }, { status: 409 });
    }
    try {
      const masks = targets.map(({ item }) => maskFor(item.text));
      const payload = masks.map((mask, index) => decapitalizeForModel(mask.use ? mask.text : targets[index].item.text));
      const engineStarted = performance.now();
      const result = await translateOnline(payload).finally(() => {
        timing.glmMs = Math.round(performance.now() - engineStarted);
      });
      return NextResponse.json({
        ok: true,
        provider: "online",
        engine: `${online.provider} ${online.model}（在线，已发送当前段落）`,
        totalMs: result.totalMs,
        items: assemble(texts, sanitized, result.items, masks, false),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "在线翻译失败。";
      const friendly = /timeout|aborted/i.test(message)
        ? "在线模型排队超时（免费额度限流）。可以重试一次，或把引擎切回「本机离线」。"
        : message;
      return NextResponse.json({ ok: false, code: "online_failed", error: friendly }, { status: 502 });
    }
  }

  const info = modelPackageInfo();
  if (!info.installed) {
    return NextResponse.json({
      ok: false,
      code: "model_missing",
      error: "离线英中模型还没有安装，当前只能显示原文和术语提示。",
    }, { status: 409 });
  }
  const runtime = await resolveRuntime();
  if (!runtime.ready) {
    return NextResponse.json({ ok: false, code: "runtime_missing", error: runtime.detail }, { status: 409 });
  }

  try {
    const masks = targets.map(({ item }) => maskFor(item.text));
    // 保护密度过高时直接用原文，避免整段变成 [[Z0]] - [[Z1]]…
    const payload = masks.map((mask, index) => decapitalizeForModel(mask.use ? mask.text : targets[index].item.text));
    const startedAt = Date.now();
    const results = await translationEngine.translateMany(payload);

    // 占位符被吃掉的那些段落，补一次无保护直译，宁可有少量术语错也不显示 ??。
    const degradedIndexes = masks
      .map((mask, index) => ({ mask, index }))
      .filter(({ mask }) => mask.use)
      .filter(({ mask, index }) => !restoreOrDegrade(mask, results[index]?.text || "").survived)
      .map(({ index }) => index);
    if (degradedIndexes.length) {
      const retry = await translationEngine.translateMany(degradedIndexes.map((index) => decapitalizeForModel(targets[index].item.text)));
      degradedIndexes.forEach((index, order) => {
        results[index] = { text: retry[order]?.text || "", ms: (results[index]?.ms || 0) + (retry[order]?.ms || 0) };
        // 保留 counts 以便界面提示"未保护直译"，但不再做还原
        masks[index] = { text: targets[index].item.text, tokens: [], counts: masks[index].counts, use: false, density: 0 };
      });
    }

    return NextResponse.json({
      ok: true,
      provider: "offline",
      engine: "argos-en_zh-1.9 + ctranslate2 (本机 CPU)",
      totalMs: Date.now() - startedAt,
      items: assemble(texts, sanitized, results, masks),
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      code: "translate_failed",
      error: error instanceof Error ? error.message : "翻译失败。",
    }, { status: 500 });
  }
}
