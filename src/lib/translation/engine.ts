// 本机翻译引擎：在 127.0.0.1 上拉起一个只监听本机的 Python 翻译服务，
// 通过本机 HTTP 调用。模型常驻内存，段落翻译只需要几十毫秒；不产生任何外网请求。
import { spawn, execFile, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { modelPackageInfo } from "./model";

export type TranslateResult = { text: string; ms: number; tokens?: number };
export type RuntimeStatus = { python: string | null; ready: boolean; detail: string };

const RUNTIME_DIR = path.join(process.cwd(), ".runtime");
const SERVER_SCRIPT = path.join(process.cwd(), "runtime", "translate_server.py");

const PYTHON_CANDIDATES = [
  process.env.XINZH_PYTHON,
  path.join(process.cwd(), ".runtime", "python", "python.exe"),
  "python",
  "python3",
].filter((value): value is string => Boolean(value));

let runtimeProbe: Promise<RuntimeStatus> | null = null;

function probePython(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      command,
      ["-X", "utf8", "-c", "import ctranslate2, sentencepiece"],
      { timeout: 20000, windowsHide: true, env: { ...process.env, PYTHONPATH: RUNTIME_DIR, PYTHONIOENCODING: "utf-8" } },
      (error) => resolve(!error),
    );
  });
}

export function resolveRuntime(): Promise<RuntimeStatus> {
  if (!runtimeProbe) {
    runtimeProbe = (async () => {
      const tried: string[] = [];
      for (const command of PYTHON_CANDIDATES) {
        if (await probePython(command)) return { python: command, ready: true, detail: "" };
        tried.push(command);
      }
      return {
        python: null,
        ready: false,
        detail: `找不到能 import ctranslate2/sentencepiece 的 Python（试过：${tried.join("、")}）。请把运行时依赖放进 .runtime，或用 XINZH_PYTHON 指定解释器。`,
      };
    })().catch((error) => ({ python: null, ready: false, detail: String(error) }));
  }
  return runtimeProbe;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

type HealthPayload = { ready: boolean; load_ms: number; compute_type: string; threads: number };

class Engine {
  private child: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;
  private health: HealthPayload | null = null;
  private cache = new Map<string, TranslateResult>();
  private startedAt = 0;

  status() {
    const model = modelPackageInfo();
    return {
      modelInstalled: model.installed,
      modelName: model.manifest?.name ?? null,
      modelVersion: model.manifest?.version ?? null,
      modelSizeBytes: model.sizeBytes,
      modelLicense: model.manifest?.license ?? null,
      running: Boolean(this.child),
      port: this.port || null,
      loadMs: this.health?.load_ms ?? null,
      startedAt: this.startedAt || null,
      cachedParagraphs: this.cache.size,
    };
  }

  private async ensureStarted() {
    if (this.child && this.health) return;
    if (this.starting) return this.starting;
    const model = modelPackageInfo();
    if (!model.installed || !model.modelDir) throw new Error("离线翻译模型未安装。");
    const runtime = await resolveRuntime();
    if (!runtime.ready || !runtime.python) throw new Error(runtime.detail || "翻译运行时不可用。");

    this.starting = (async () => {
      const port = await freePort();
      const child = spawn(
        runtime.python!,
        ["-X", "utf8", SERVER_SCRIPT, "--model-dir", model.modelDir!, "--port", String(port)],
        { env: { ...process.env, PYTHONPATH: RUNTIME_DIR, PYTHONIOENCODING: "utf-8" }, windowsHide: true, stdio: "ignore" },
      );
      this.child = child;
      this.port = port;
      this.startedAt = Date.now();
      child.on("exit", () => {
        if (this.child === child) {
          this.child = null;
          this.health = null;
        }
      });
      const deadline = Date.now() + 120000;
      let lastError = "";
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`翻译服务进程退出（code=${child.exitCode}）。`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
          if (response.ok) {
            this.health = (await response.json()) as HealthPayload;
            return;
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      child.kill();
      this.child = null;
      throw new Error(`翻译服务启动超时。${lastError}`);
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  async translateMany(texts: string[]): Promise<TranslateResult[]> {
    const unique = [...new Set(texts.map((text) => text.trim()).filter(Boolean))];
    const results = new Map<string, TranslateResult>();
    for (const text of unique) {
      const hit = this.cache.get(text);
      if (hit) results.set(text, hit);
    }
    const missing = unique.filter((text) => !results.has(text));
    if (missing.length) {
      await this.ensureStarted();
      const response = await fetch(`http://127.0.0.1:${this.port}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: missing }),
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`本机翻译服务返回 ${response.status}。${detail.slice(0, 200)}`);
      }
      const payload = (await response.json()) as { items: TranslateResult[] };
      missing.forEach((text, index) => {
        const item = payload.items[index] ?? { text: "", ms: 0 };
        this.cache.set(text, item);
        results.set(text, item);
      });
    }
    return texts.map((text) => results.get(text.trim()) ?? { text: "", ms: 0 });
  }

  stop() {
    this.child?.kill();
    this.child = null;
    this.health = null;
  }

  clearCache() {
    this.cache.clear();
  }
}

const globalForEngine = globalThis as unknown as { __xinzhEngine?: Engine };
export const translationEngine = globalForEngine.__xinzhEngine ?? new Engine();
if (!globalForEngine.__xinzhEngine) globalForEngine.__xinzhEngine = translationEngine;

export function resetRuntimeProbe() {
  runtimeProbe = null;
}
