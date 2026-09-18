/* 打包后处理（M4-2）：把原生启动器放到 dist 根目录，与 MDReader.exe 同级。
 *
 * 启动器靠"与自己在同一目录"来推算 MDReader.exe 的位置，所以必须在同一个目录；
 * 又因为它是双击时被创建的那个进程，位置越贴近应用越好。
 * 由 npm run pack 在 electron-packager 之后自动调用。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIST_APP = path.join(ROOT, "dist", "MDReader-win32-x64");
const SRC = path.join(ROOT, "native", "launcher", "MDReaderLauncher.exe");
const DEST = path.join(DIST_APP, "MDReaderLauncher.exe");

if (!fs.existsSync(path.join(DIST_APP, "MDReader.exe"))) {
  console.error("[x] 未找到打包产物：" + DIST_APP + "\\MDReader.exe");
  process.exit(1);
}
if (!fs.existsSync(SRC)) {
  console.error("[x] 未找到启动器，请先执行：node tools/build-launcher.js");
  process.exit(1);
}

fs.copyFileSync(SRC, DEST);
const size = fs.statSync(DEST).size;
console.log(`[ok] 启动器已放入产物根目录：${path.relative(ROOT, DEST)}  ${size} bytes`);
