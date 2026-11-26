// 语义搜索用的大模型接入：查询改写 + 证据卡。可在智谱和硅基流动之间切换，默认仍是智谱。
// key 只从本机文件 / 环境变量读取，不进前端、不进日志。
import fs from "node:fs";
import path from "node:path";
import { onlineConfig } from "@/lib/translation/online";

export type LlmChoice = { provider: "zhipu" | "siliconflow"; model: string };

function readKeyFile(names: string[], envName: string): string {
  const fromEnv = (process.env[envName] || "").trim();
  if (fromEnv) return fromEnv;
  for (const name of names) {
    const file = path.join(process.cwd(), name);
    try {
      if (!fs.existsSync(file)) continue;
      const match = fs.readFileSync(file, "utf8").trim().match(new RegExp(`^(?:${envName}\\s*=\\s*)?(.+)$`, "m"));
      const key = (match?.[1] || "").trim().replace(/^["']|["']$/g, "");
      if (key) return key;
    } catch { /* 换下一个文件名 */ }
  }
  return "";
}

export function defaultLlm(): LlmChoice {
  const provider = process.env.XINZH_LLM_PROVIDER === "siliconflow" ? "siliconflow" : "zhipu";
  return { provider, model: process.env.XINZH_LLM_MODEL || (provider === "zhipu" ? onlineConfig().model : "Qwen/Qwen3-8B") };
}

export function llmHost(choice: LlmChoice = defaultLlm()) {
  return choice.provider === "zhipu" ? "open.bigmodel.cn" : "api.siliconflow.cn";
}

/** 调一次对话模型，返回文本。非思考模型直接答；思考模型尽量关闭或降到 low，保证 2–4 秒。 */
/** effort：low = 快速搜（尽量少想）；high = 精确搜（让模型多想一步）。 */
export type Effort = "low" | "high";

export async function chatOnce(choice: LlmChoice, system: string, user: string, maxTokens: number, timeoutMs: number, temperature: number, effort: Effort = "low"): Promise<string> {
  const zhipu = choice.provider === "zhipu";
  const key = zhipu ? readKeyFile([".zhipu-key", ".zhipu-key.txt"], "ZHIPU_API_KEY") : readKeyFile([".siliconflow-key", ".siliconflow-key.txt"], "SILICONFLOW_API_KEY");
  if (!key) throw new Error(zhipu ? "未配置智谱 API key（.zhipu-key 或 ZHIPU_API_KEY）。" : "未配置硅基流动 API key（.siliconflow-key 或 SILICONFLOW_API_KEY）。");
  const base = zhipu ? onlineConfig().base : (process.env.SILICONFLOW_BASE || "https://api.siliconflow.cn/v1");
  const attempts: Record<string, unknown>[] = zhipu
    ? [{ reasoning_effort: effort }, {}]           // glm-5.3 不能关思考，只能调深浅；老的 flash 档不认这个字段
    : effort === "low"
      ? [{ enable_thinking: false }, { reasoning_effort: "low" }, {}]
      : [{ enable_thinking: true }, { reasoning_effort: "high" }, {}];
  let lastError = "";
  for (const extra of attempts) {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: choice.model, temperature, stream: false, max_tokens: maxTokens, ...extra,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = (await response.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: { message?: string }; message?: string };
    if (response.ok) return payload.choices?.[0]?.message?.content?.trim() || "";
    lastError = `${response.status} ${(payload.error?.message || payload.message || "").slice(0, 100)}`;
    if (response.status !== 400) break; // 只有“参数不支持”才换一组参数重试
  }
  throw new Error(`${choice.provider}/${choice.model} 请求失败：${lastError}`);
}
