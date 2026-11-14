// Electron 主进程：启动内置 Next.js 服务，再用窗口打开它。
// 用户双击 exe 后不需要任何终端、Node.js、Python 环境。
const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");

// 打包后资源在 resources/app 下；开发时在项目根目录
const ROOT = app.isPackaged ? path.join(process.resourcesPath, "app") : __dirname;
const SERVER_DIR = path.join(ROOT, ".next", "standalone");
const DATA_DIR = path.join(app.getPath("userData"));

let serverProcess = null;
let mainWindow = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(url, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) return resolve();
      } catch {
        /* 还没起来 */
      }
      if (Date.now() > deadline) return reject(new Error("内置服务启动超时"));
      setTimeout(tick, 400);
    };
    tick();
  });
}

async function startServer() {
  const port = await freePort();
  const serverEntry = path.join(SERVER_DIR, "server.js");
  if (!fs.existsSync(serverEntry)) throw new Error(`找不到内置服务：${serverEntry}`);

  // 模型、运行时、密钥都放在用户数据目录，升级程序不会覆盖用户数据
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    XINZH_DATA_DIR: DATA_DIR,
    XINZH_PYTHON: path.join(ROOT, "runtime-python", "python.exe"),
    PYTHONPATH: path.join(ROOT, "runtime-deps"),
    PYTHONIOENCODING: "utf-8",
    XINZH_MODEL_DIR: path.join(DATA_DIR, "models"),
    XINZH_KEY_DIR: DATA_DIR,
    PATH: `${path.join(ROOT, "runtime-python")};${process.env.PATH || ""}`,
  };

  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: SERVER_DIR,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout.on("data", (chunk) => console.log("[next]", chunk.toString().trim()));
  serverProcess.stderr.on("data", (chunk) => console.error("[next]", chunk.toString().trim()));

  const base = `http://127.0.0.1:${port}`;
  await waitForServer(base);
  return base;
}

async function createWindow(baseUrl) {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#f7f7f4",
    title: "芯知 · 英文芯片手册阅读器",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // 站内链接在窗口里开，外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  await mainWindow.loadURL(baseUrl);
}

app.whenReady().then(async () => {
  try {
    const baseUrl = await startServer();
    await createWindow(baseUrl);
  } catch (error) {
    console.error(error);
    const { dialog } = require("electron");
    dialog.showErrorBox("芯知启动失败", String(error && error.message ? error.message : error));
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});

app.on("before-quit", () => {
  if (serverProcess) serverProcess.kill();
});
