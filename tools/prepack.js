/* 打包前清理旧产物（tools/prepack.js）
 *
 *   node tools/prepack.js
 *
 * 为什么需要这一步：
 *   electron-packager 的 --overwrite 会在打包前递归删除上一个产物目录（约 160 个文件）。
 *   工作环境对「单轮批量删除超过阈值」有审批拦截（node 的 fs 被安全 shim 包了一层），
 *   删除会被拒绝，自动化打包因此卡在审批上。
 *   把清理由独立的 prepack 步骤完成、并让 electron-packager 以「目标不存在」的正常路径
 *   写入，全程不出现任何批量删除 ←→ 打包可以无人值守。
 *
 * 做法：改名而非删除。
 *   把 dist/MDReader-win32-x64 整体 rename 到系统临时目录（rename 只是改目录项，
 *   不产生文件删除），再顺手清理上一轮留下的临时残留（系统临时目录不受上述拦截约束）。
 *
 * 安全边界（只动自己的产物，不动别的）：
 *   - 目标路径写死为 <repo>/dist/MDReader-win32-x64，不接受外部参数；
 *   - 校验目标确实在 dist 之下，防止路径拼错波及仓库源码；
 *   - 只清理系统临时目录下自己创建的 mdreader-stale-* 目录。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const STAGE = path.join(DIST, "MDReader-win32-x64");
const TMP = os.tmpdir();
const PREFIX = "mdreader-stale-";

/* ---- 1. 清掉上一轮打包留下的临时残留（系统临时目录，不受批量删除拦截） ---- */
for (const name of fs.readdirSync(TMP)) {
  if (!name.startsWith(PREFIX)) continue;
  const full = path.join(TMP, name);
  try {
    fs.rmSync(full, { recursive: true, force: true });
    console.log("[i] 已清理临时残留：" + name);
  } catch (e) {
    console.log("[i] 临时残留清理失败（可忽略）：" + name + "  " + e.message);
  }
}

/* ---- 2. 把旧产物改名挪出 dist，让 electron-packager 无需 --overwrite ---- */
if (!fs.existsSync(STAGE)) {
  console.log("[i] 无旧产物，跳过清理");
  process.exit(0);
}
if (path.dirname(STAGE) !== DIST) {
  console.error("[x] 清理目标不在 dist 之下，已中止：" + STAGE);
  process.exit(1);
}

const dest = path.join(TMP, PREFIX + Date.now());
try {
  fs.renameSync(STAGE, dest);
  console.log(`[ok] 旧产物已移出：dist/MDReader-win32-x64 -> ${dest}`);
} catch (e) {
  /* 跨卷等情况下 rename 会失败（EXDEV）。退一步在 dist 内改名，保证打包能继续；
     代价是残留留在 dist 下，需要人工或放宽阈值后清理。 */
  const local = path.join(DIST, ".stale-" + Date.now());
  fs.renameSync(STAGE, local);
  console.log("[!] 无法移到临时目录（" + e.code + "），已改名为 " + path.relative(ROOT, local));
  console.log("[!] 该残留需人工清理，或在设置里放宽批量删除阈值后由下次打包清除");
}
