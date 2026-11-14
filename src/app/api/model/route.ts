import { NextResponse } from "next/server";
import { installModelPackage, modelPackageInfo, removeModelPackage } from "@/lib/translation/model";
import { resolveRuntime, resetRuntimeProbe, translationEngine } from "@/lib/translation/engine";
import { onlineConfig } from "@/lib/translation/online";
import { deeplConfig } from "@/lib/translation/deepl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OFFICIAL_SOURCE = "https://data.argosopentech.com/argospm/v1/translate-en_zh-1_9.argosmodel";
const OFFICIAL_INDEX = "https://github.com/argosopentech/argospm-index/blob/main/index.json";

export async function GET() {
  const info = modelPackageInfo();
  const runtime = await resolveRuntime();
  return NextResponse.json({
    installed: info.installed,
    manifest: info.manifest,
    modelDir: info.modelDir,
    packageDir: info.packageDir,
    sizeBytes: info.sizeBytes,
    runtime,
    engine: translationEngine.status(),
    online: onlineConfig(),
    deepl: deeplConfig(),
    officialSource: OFFICIAL_SOURCE,
    officialIndex: OFFICIAL_INDEX,
    expectedPackageBytes: 70743021,
  });
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const body = (await request.json()) as { action?: string };
    if (body.action === "remove") {
      translationEngine.stop();
      removeModelPackage();
      return NextResponse.json({ ok: true, installed: false });
    }
    if (body.action === "reprobe") {
      resetRuntimeProbe();
      const runtime = await resolveRuntime();
      return NextResponse.json({ ok: runtime.ready, runtime });
    }
    return NextResponse.json({ ok: false, error: "未知操作。" }, { status: 400 });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "请选择 .argosmodel 模型包文件。" }, { status: 400 });
  }
  if (file.size > 200 * 1024 * 1024) {
    return NextResponse.json({ ok: false, error: "模型包超过 200 MB，拒绝安装。" }, { status: 413 });
  }
  try {
    const manifest = installModelPackage(Buffer.from(await file.arrayBuffer()), {
      source: `本地文件 ${file.name}`,
    });
    resetRuntimeProbe();
    return NextResponse.json({ ok: true, installed: true, manifest });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "安装失败。" }, { status: 400 });
  }
}
