// 最小 ZIP 读取器：只支持 Argos 模型包用到的 stored / deflate 两种压缩方式。
// 这样模型安装不需要引入额外依赖，也能在打包成 EXE 时保持依赖面最小。
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

type Entry = { name: string; method: number; compressedSize: number; size: number; localOffset: number; flags: number };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buffer: Buffer) {
  const earliest = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= earliest; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function readEntries(buffer: Buffer): Entry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error("不是有效的 ZIP 文件（找不到目录结尾）");
  const total = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  const entries: Entry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < total; index++) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error("ZIP 中央目录损坏");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString(flags & 0x800 ? "utf8" : "latin1");
    entries.push({ name, method, compressedSize, size, localOffset, flags });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryData(buffer: Buffer, entry: Entry) {
  if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) throw new Error(`ZIP 条目损坏：${entry.name}`);
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`不支持的 ZIP 压缩方式 ${entry.method}：${entry.name}`);
}

function safeJoin(root: string, name: string) {
  const normalized = name.replace(/\\/g, "/");
  const target = path.resolve(root, normalized);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error(`ZIP 条目越界：${name}`);
  return target;
}

export function extractZip(buffer: Buffer, destination: string) {
  const entries = readEntries(buffer);
  const written: string[] = [];
  for (const entry of entries) {
    if (entry.name.endsWith("/")) {
      fs.mkdirSync(safeJoin(destination, entry.name), { recursive: true });
      continue;
    }
    const target = safeJoin(destination, entry.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entryData(buffer, entry));
    written.push(entry.name);
  }
  return written;
}

export function listZip(buffer: Buffer) {
  return readEntries(buffer).map((entry) => ({ name: entry.name, size: entry.size }));
}
