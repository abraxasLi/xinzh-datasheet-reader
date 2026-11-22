// 本机 Chroma：拉起一个只监听 127.0.0.1 的 Chroma 服务，数据落在 ./chroma_db。
// 一本手册一个 collection；同一时间只保留一本，换手册就换索引。
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { ChromaClient, type Collection } from "chromadb";

const CHROMA_LIB = path.join(process.cwd(), ".runtime", "chroma");
const DB_DIR = path.join(process.cwd(), "chroma_db");
const PREFIX = "manual_";

const PYTHON_CANDIDATES = [process.env.XINZH_PYTHON, "python", "python3"].filter((value): value is string => Boolean(value));

type State = { child: ChildProcess | null; port: number; client: ChromaClient | null; starting: Promise<ChromaClient> | null };
const globalState = globalThis as typeof globalThis & { __xinzhChroma?: State };
const state: State = globalState.__xinzhChroma ??= { child: null, port: 0, client: null, starting: null };

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

async function launch(): Promise<ChromaClient> {
  const port = await freePort();
  let lastError = "";
  for (const python of PYTHON_CANDIDATES) {
    const child = spawn(
      python,
      ["-X", "utf8", "-c", "from chromadb.cli.cli import app; app()", "run", "--path", DB_DIR, "--host", "127.0.0.1", "--port", String(port)],
      { env: { ...process.env, PYTHONPATH: CHROMA_LIB, PYTHONIOENCODING: "utf-8", ANONYMIZED_TELEMETRY: "False", CHROMA_TELEMETRY_IMPL: "chromadb.telemetry.product.NoOp" }, windowsHide: true, stdio: "ignore" },
    );
    let exited = false;
    child.on("exit", () => {
      exited = true;
      if (state.child === child) { state.child = null; state.client = null; }
    });
    child.on("error", (error) => { lastError = String(error); exited = true; });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !exited) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/v2/heartbeat`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) {
          state.child = child;
          state.port = port;
          return new ChromaClient({ host: "127.0.0.1", port, ssl: false });
        }
      } catch { /* 还没起来 */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    child.kill();
    lastError ||= `${python} 无法启动 Chroma`;
  }
  throw new Error(`本机向量库不可用：${lastError}。请确认 .runtime/chroma 已安装 chromadb。`);
}

export function getChroma(): Promise<ChromaClient> {
  if (state.client && state.child) return Promise.resolve(state.client);
  if (!state.starting) {
    state.starting = launch()
      .then((client) => { state.client = client; return client; })
      .finally(() => { state.starting = null; });
  }
  return state.starting;
}

export function collectionNameFor(fingerprint: string) {
  return `${PREFIX}${fingerprint}`;
}

/** 只保留当前这一本：删掉其他手册的 collection。 */
export async function dropOtherManuals(client: ChromaClient, keep: string) {
  const collections = await client.listCollections();
  for (const item of collections) {
    if (item.name.startsWith(PREFIX) && item.name !== keep) await client.deleteCollection({ name: item.name });
  }
}

export type { Collection };
