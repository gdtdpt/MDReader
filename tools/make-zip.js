/* 生成发布 zip（M4-2）：把 dist/MDReader-win32-x64 打成 MDReader-<version>-win32-x64.zip。
 *
 * 为什么不用 7z / Compress-Archive：
 *  - electron-packager 会在项目根/包内落一个 `nul` 保留名文件（rcedit 副作用），
 *    常规工具枚举或读取它会出错；本脚本按文件名跳过。
 *  - 7z 在中文 Windows 上会把非 ASCII 文件名按本机代码页写入导致乱码；
 *    Compress-Archive 无法排除 nul。本脚本全部条目用 UTF-8 标志位。
 *  - 与历史包结构对齐：内容平铺（无根目录前缀）、不含目录条目。
 *
 * 用法：node tools/make-zip.js
 * 产物：dist/MDReader-<package.json version>-win32-x64.zip
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "dist", "MDReader-win32-x64");
const version = require(path.join(ROOT, "package.json")).version;
const OUT = path.join(ROOT, "dist", `MDReader-${version}-win32-x64.zip`);

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---- 收集文件（跳过 nul 保留名）----
function walk(dir, base) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === "nul") continue; // rcedit 副作用产物，无法正常读取，跳过
    const full = path.join(dir, name);
    const rel = base ? base + "/" + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full, rel));
    else out.push({ rel, full, mtime: st.mtime, size: st.size });
  }
  return out;
}

// ---- DOS 时间 ----
function dosTime(d) {
  const time =
    ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) >>> 0;
  const date =
    (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) >>> 0;
  return { time, date };
}

if (!fs.existsSync(path.join(SRC, "MDReader.exe"))) {
  console.error("[x] 未找到打包产物：" + SRC + "\\MDReader.exe");
  process.exit(1);
}

const files = walk(SRC, "");
const chunks = [];
const central = [];
let offset = 0;

for (const f of files) {
  const data = fs.readFileSync(f.full);
  const compressed = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const { time, date } = dosTime(f.mtime);
  const nameBuf = Buffer.from(f.rel, "utf8");

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 名标志
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, nameBuf, compressed);

  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0);
  c.writeUInt16LE(20, 4);
  c.writeUInt16LE(20, 6);
  c.writeUInt16LE(0x0800, 8);
  c.writeUInt16LE(8, 10);
  c.writeUInt16LE(time, 12);
  c.writeUInt16LE(date, 14);
  c.writeUInt32LE(crc, 16);
  c.writeUInt32LE(compressed.length, 20);
  c.writeUInt32LE(data.length, 24);
  c.writeUInt16LE(nameBuf.length, 28);
  c.writeUInt32LE(offset, 42);
  central.push(Buffer.concat([c, nameBuf]));

  offset += local.length + nameBuf.length + compressed.length;
}

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);

fs.writeFileSync(OUT, Buffer.concat([...chunks, centralBuf, eocd]));
const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
console.log(`[ok] ${path.relative(ROOT, OUT)}  ${files.length} 条目  ${mb} MB（nul 已跳过）`);
