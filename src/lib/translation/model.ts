// 模型包管理：安装（本地 .argosmodel 文件）、状态、移除。
// 模型永远装在本机项目目录内，不上传、不联网；包内的许可文本原样保留供界面展示。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { extractZip, listZip } from "./zip";

export const MODEL_ROOT = path.join(process.cwd(), "models");
const PACKAGE_DIR = path.join(MODEL_ROOT, "argos-en-zh");
const MANIFEST = path.join(PACKAGE_DIR, "install.json");

export type ModelManifest = {
  name: string;
  version: string;
  source: string;
  license: string;
  licenseNote: string;
  packageSize: number;
  packageSha256: string;
  installedAt: string;
  engine: string;
};

function directorySize(directory: string): number {
  if (!fs.existsSync(directory)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    total += entry.isDirectory() ? directorySize(full) : fs.statSync(full).size;
  }
  return total;
}

/** 在解包目录里找到 CTranslate2 模型目录（含 model.bin + config.json）。 */
export function locateModelDir(root: string): string | null {
  const queue = [root];
  while (queue.length) {
    const current = queue.shift()!;
    if (fs.existsSync(path.join(current, "model.bin")) && fs.existsSync(path.join(current, "config.json"))) return current;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) queue.push(path.join(current, entry.name));
    }
  }
  return null;
}

export function readManifest(): ModelManifest | null {
  if (!fs.existsSync(MANIFEST)) return null;
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as ModelManifest;
  } catch {
    return null;
  }
}

export function modelPackageInfo() {
  const manifest = readManifest();
  const modelDir = fs.existsSync(PACKAGE_DIR) ? locateModelDir(PACKAGE_DIR) : null;
  const hasSentencePiece = fs.existsSync(PACKAGE_DIR) ? Boolean(findSentencePiece(PACKAGE_DIR)) : false;
  const installed = Boolean(manifest && modelDir && hasSentencePiece);
  return {
    installed,
    modelDir,
    manifest,
    packageDir: PACKAGE_DIR,
    sizeBytes: installed ? directorySize(PACKAGE_DIR) : 0,
  };
}

function findSentencePiece(root: string): string | null {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findSentencePiece(full);
      if (nested) return nested;
    } else if (entry.name === "sentencepiece.model") {
      return full;
    }
  }
  return null;
}

/** 安装顺序：校验 ZIP -> 解包到临时目录 -> 落盘 manifest -> 原子改名。失败不会破坏已装模型。 */
export function installModelPackage(buffer: Buffer, options: { source: string }) {
  const entries = listZip(buffer);
  const hasModelBin = entries.some((entry) => entry.name.endsWith("model.bin"));
  const hasTokenizer = entries.some((entry) => entry.name.endsWith("sentencepiece.model"));
  if (!hasModelBin || !hasTokenizer) {
    throw new Error("这个文件不像 Argos 模型包：缺少 model.bin 或 sentencepiece.model。");
  }
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  fs.mkdirSync(MODEL_ROOT, { recursive: true });
  const staging = path.join(MODEL_ROOT, `.staging-${Date.now()}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    extractZip(buffer, staging);
    // Argos 包通常带一层 translate-en_zh-1_9/ 目录，这里把它提到包根，避免路径过深。
    const topLevel = fs.readdirSync(staging, { withFileTypes: true });
    let root = staging;
    if (topLevel.length === 1 && topLevel[0].isDirectory()) root = path.join(staging, topLevel[0].name);
    const modelDir = locateModelDir(root);
    if (!modelDir) throw new Error("解包后找不到 CTranslate2 模型文件（model.bin + config.json）。");
    const licenseFile = ["LICENSE", "LICENSE.txt", "COPYING", "README.md"]
      .map((name) => path.join(root, name))
      .find((file) => fs.existsSync(file));
    const license = licenseFile ? fs.readFileSync(licenseFile, "utf8").slice(0, 8000) : "";
    const metadataFile = path.join(root, "metadata.json");
    let metadata: Record<string, unknown> = {};
    try {
      if (fs.existsSync(metadataFile)) metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8")) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    const manifest: ModelManifest = {
      name: String(metadata.package_name || metadata.name || "translate-en_zh"),
      version: String(metadata.package_version || metadata.version || "1.9"),
      source: options.source,
      license: license || "模型包内未附带许可文本，需按官方索引单独核对",
      licenseNote: license
        ? `许可文本来自模型包内 ${path.basename(licenseFile!)}，原样保存。`
        : "包内没有许可文件，界面必须提示未核实。",
      packageSize: buffer.length,
      packageSha256: sha256,
      installedAt: new Date().toISOString(),
      engine: "CTranslate2 + SentencePiece",
    };
    fs.writeFileSync(path.join(staging, "install.json"), JSON.stringify(manifest, null, 2));
    fs.rmSync(PACKAGE_DIR, { recursive: true, force: true });
    fs.renameSync(staging, PACKAGE_DIR);
    return manifest;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function removeModelPackage() {
  fs.rmSync(PACKAGE_DIR, { recursive: true, force: true });
}
