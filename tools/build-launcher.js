/* 编译原生启动器（M4-2）
 *
 *   node tools/build-launcher.js
 *
 * 产出 native/launcher/MDReaderLauncher.exe（约 15 KB），源码与产物一并在 git 里，
 * 打包机不需要任何 C 工具链 —— 与「离线可复现」的项目约定一致。
 *
 * 编译器查找顺序：MDREADER_CC 环境变量 → PATH 里的 gcc → 已知 MinGW 安装位置。
 * 关键参数：-Os（体积优先）、-s（去符号表）、-static（不依赖 libgcc/libwinpthread DLL，
 * 真正单文件）、-mwindows（不弹控制台窗口）。
 */
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "native", "launcher", "launcher.c");
const OUT = path.join(ROOT, "native", "launcher", "MDReaderLauncher.exe");

const CANDIDATES = [
  process.env.MDREADER_CC,
  "gcc",
  "C:\\mingw64\\bin\\gcc.exe",
  "C:\\MinGW\\bin\\gcc.exe",
].filter(Boolean);

function usable(cc) {
  const r = spawnSync(cc, ["--version"], { encoding: "utf8", windowsHide: true });
  return !r.error && r.status === 0;
}

let cc = null;
for (const c of CANDIDATES) {
  if (usable(c)) {
    cc = c;
    break;
  }
}
if (!cc) {
  console.error(
    "[x] 找不到可用的 C 编译器。请安装 MinGW-w64 并把 gcc 放进 PATH，" +
      "或用 MDREADER_CC 指定完整路径。"
  );
  process.exit(1);
}

const args = ["-Os", "-s", "-static", "-mwindows", "-o", OUT, SRC];
const res = spawnSync(cc, args, { stdio: "inherit", windowsHide: true });
if (res.error || res.status !== 0) {
  console.error("[x] 编译失败：" + (res.error ? res.error.message : "exit " + res.status));
  process.exit(res.status || 1);
}

const size = fs.statSync(OUT).size;
console.log(`[ok] ${path.relative(ROOT, OUT)}  ${size} bytes (${(size / 1024).toFixed(1)} KB)`);

/* 顺手核对依赖，守住「运行时零安装」这条约定 */
const objdump = path.join(path.dirname(cc), "objdump.exe");
if (fs.existsSync(objdump)) {
  const r = spawnSync(objdump, ["-p", OUT], { encoding: "utf8", windowsHide: true });
  const dlls = (r.stdout || "")
    .split(/\r?\n/)
    .filter((l) => /DLL Name/i.test(l))
    .map((l) => l.split(":").pop().trim());
  console.log("[i] 依赖 DLL：" + (dlls.join(", ") || "(无法解析)"));
}
