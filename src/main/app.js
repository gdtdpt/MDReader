"use strict";

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  nativeTheme,
  Tray,
  nativeImage,
  clipboard,
} = require("electron");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const net = require("net");
const { fileURLToPath, pathToFileURL } = require("url");
const fsp = fs.promises;

const MD_EXTENSIONS = ["md", "markdown", "mdown", "mkdn", "txt"];
const MD_FILTER_NAME = "Markdown 文档";

/* ---------- 单实例锁 ----------
 * 已有实例（含常驻托盘的隐藏窗口）在运行时，本进程只负责把命令行文件交给它
 * 并立刻退出。文件关联现已指向 ~15KB 的原生启动器（MDReaderLauncher.exe），
 * 这条「启动一个完整 Electron 进程只为转交一个路径」的路径只在
 * 「未常驻 + 直接双击 .md」时才会走到。 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/* ---------- 托盘常驻与关闭行为（M4） ----------
 * 不做开机自启；点 × 关窗时由用户选择「最小化到托盘 / 完全退出」，
 * 首次询问 + 可勾选记住；偏好存 userData/mdreader-prefs.json
 * （主进程要在 close 事件里同步决策，用不了渲染层 localStorage）。
 * 常驻 = mainWindow.hide() 而非销毁：唤起时不重起渲染进程，
 * 这是「双击 .md 秒开」的前提（渲染进程冷启约 4.9s）。
 */
const CLOSE_ACTIONS = ["ask", "tray", "quit"];
const PREFS_FILE = "mdreader-prefs.json";
let prefsCache = null;
let tray = null;
let isQuitting = false;
let closeDialogOpen = false;

function prefsFilePath() {
  return path.join(app.getPath("userData"), PREFS_FILE);
}

function readPrefs() {
  if (prefsCache) return prefsCache;
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(prefsFilePath(), "utf8")) || {};
  } catch (_) {
    data = {}; // 首次运行 / 文件损坏 → 全默认
  }
  prefsCache = {
    closeAction: CLOSE_ACTIONS.includes(data.closeAction) ? data.closeAction : "ask",
    trayTipShown: !!data.trayTipShown,
    // 快速启动器（M4-2）：默认开；产物不在位时 openerCommandExe() 会自动退回应用自身
    fastLauncher: data.fastLauncher !== false,
  };
  return prefsCache;
}

function writePrefs(patch) {
  const next = Object.assign({}, readPrefs(), patch);
  prefsCache = next;
  try {
    fs.writeFileSync(prefsFilePath(), JSON.stringify(next, null, 2), "utf8");
  } catch (_) {
    /* 持久化失败退化为本次会话内生效 */
  }
  return next;
}

function setCloseAction(action) {
  if (!CLOSE_ACTIONS.includes(action)) return readPrefs().closeAction;
  const next = writePrefs({ closeAction: action });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("app:close-action-changed", next.closeAction);
  }
  return next.closeAction;
}

function createTray() {
  if (tray) return tray;
  const iconsDir = path.join(__dirname, "..", "..", "assets", "icons");
  // 优先多尺寸 ICO（各 DPI 下更锐利），读不出再退 32px PNG，最后退应用图标
  let image = nativeImage.createFromPath(path.join(iconsDir, "tray.ico"));
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(path.join(iconsDir, "tray.png"));
  }
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(path.join(iconsDir, "mdreader.ico"));
  }
  tray = new Tray(image);
  tray.setToolTip("MDReader 常驻中 — 双击 .md 文件可立即打开");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示主窗口", click: () => showWindow() },
      { type: "separator" },
      { label: "退出 MDReader", click: () => quitApp() },
    ])
  );
  tray.on("click", () => showWindow());
  tray.on("double-click", () => showWindow());

  // 首次驻留给一次性气泡提示，避免用户误以为应用没关掉
  if (!readPrefs().trayTipShown) {
    writePrefs({ trayTipShown: true });
    try {
      tray.displayBalloon({
        title: "MDReader 仍在后台运行",
        content: "双击 .md 文件可立即打开；右键托盘图标可显示窗口或退出。",
      });
    } catch (_) {
      /* 气泡失败无碍 */
    }
  }
  return tray;
}

function destroyTray() {
  if (tray) {
    try {
      tray.destroy();
    } catch (_) {
      /* 已销毁则忽略 */
    }
    tray = null;
  }
}

function hideToTray() {
  createTray();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
}

function showWindow() {
  destroyTray(); // 托盘图标只在常驻期间存在，窗口可见即收起
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  ensureForeground(mainWindow);
}

/* Windows 前台兜底（热启动唤起窗口）。
 * 常驻进程收到管道消息时不是前台进程，它自己调 SetForegroundWindow 会被系统
 * 前台锁降级成任务栏闪烁，窗口就被别的窗口压着 —— 现场表现是「有时候」不出现
 * 在最前面。主路径由启动器代为激活（它是用户双击唤起的，持有前台权限）；
 * 这里补两件轻活：把窗口提到 z-order 顶部（至少不被遮挡），以及 show() 之后
 * 的焦点滞后时再补一次 focus（second-instance / 托盘唤出等路径）。 */
function ensureForeground(win) {
  if (process.platform !== "win32" || !win || win.isDestroyed()) return;
  win.moveTop();
  setTimeout(() => {
    if (!win || win.isDestroyed() || win.isFocused()) return;
    win.focus();
  }, 60);
}

function quitApp() {
  isQuitting = true;
  destroyTray();
  app.quit();
}

let mainWindow = null;

/* 原生关窗询问：渲染层自绘模态框不可用时的兜底（脚本出错 / 消息应答超时） */
function showNativeCloseDialog() {
  dialog
    .showMessageBox(mainWindow, {
      type: "question",
      title: "关闭 MDReader",
      message: "完全退出，还是最小化到系统托盘继续后台运行？",
      detail: "驻留托盘后，双击 .md 文件可立即打开（无需等待启动）。",
      buttons: ["最小化到托盘", "完全退出", "取消"],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: "记住我的选择（可在 ··· 菜单中修改）",
      checkboxChecked: false,
      noLink: true,
    })
    .then((res) => {
      closeDialogOpen = false;
      if (res.response === 2) return; // 取消：窗口保持原样
      if (res.checkboxChecked) {
        writePrefs({ closeAction: res.response === 0 ? "tray" : "quit" });
      }
      if (res.response === 0) {
        hideToTray();
      } else {
        quitApp();
      }
    })
    .catch(() => {
      closeDialogOpen = false;
    });
}

/* ---------- 文件读取 ---------- */

function hasMdExtension(p) {
  return MD_EXTENSIONS.includes(path.extname(p).slice(1).toLowerCase());
}

/* 文本编码探测（批次 1）
 * 旧文档里「记事本另存为 ANSI」写出来的中文 .md 很常见，此前硬编码 utf8
 * 读它们会整篇乱码 —— 在 VSCode/Typora 里正常、在这里乱码，用户只会认为
 * 是本应用坏了。顺序：BOM 优先（BOM 是权威声明，不猜）→ 无 BOM 时用
 * fatal 模式严格试解 UTF-8（能解出来就是 UTF-8，解不出说明不是）→ 回退 GB18030。
 * 只做这一种回退：多一种猜测就多一类误判，中文环境 GB18030 已覆盖 GBK/GB2312；
 * Electron 22 内置全量 ICU，TextDecoder 支持 gb18030，零新增依赖。 */
function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.slice(3).toString("utf8"), encoding: "utf-8" };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(buf.slice(2)), encoding: "utf-16le" };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(buf.slice(2)), encoding: "utf-16be" };
  }
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(buf),
      encoding: "utf-8",
    };
  } catch (_) {
    return { text: new TextDecoder("gb18030").decode(buf), encoding: "gb18030" };
  }
}

async function readMarkdownFile(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return { ok: false, error: "无效的文件路径" };
  }
  const resolved = path.resolve(filePath);
  if (!hasMdExtension(resolved)) {
    return { ok: false, error: "暂不支持的文件类型：" + path.extname(resolved) };
  }
  try {
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) {
      return { ok: false, error: "路径不是普通文件" };
    }
    // 5MB 上限：本地阅读器场景下足够大，同时避免误开巨型文件卡住 UI
    if (stat.size > 5 * 1024 * 1024) {
      return { ok: false, error: "文件超过 5MB，暂不支持" };
    }
    const { text, encoding } = decodeText(await fsp.readFile(resolved));
    // stat 信息随载荷返回：渲染层用于外部修改检测（mtime+size 比对）；
    // encoding 非 utf-8 时渲染层会提示一次「已按 xx 解码」，避免用户误以为乱码是 bug
    return {
      ok: true,
      path: resolved,
      content: text,
      encoding,
      stat: { mtimeMs: stat.mtimeMs, size: stat.size },
    };
  } catch (err) {
    return { ok: false, error: "读取失败：" + err.message };
  }
}

/* ---------- 打开对话框 ---------- */

async function openFileDialog() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "打开 Markdown 文档",
    properties: ["openFile"],
    filters: [
      { name: MD_FILTER_NAME, extensions: MD_EXTENSIONS },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
}

async function openViaDialogAndPush() {
  const filePath = await openFileDialog();
  if (!filePath) return;
  await openFileFromPath(filePath);
}

/* 按路径打开（对话框 / 命令行 / 文件关联 / 原生启动器管道共用同一个出口） */
async function openFileFromPath(filePath) {
  const file = await readMarkdownFile(filePath);
  if (file.ok) {
    pushOpenFile(file);
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    // 应用内错误提示条（渲染层 showError），不再弹原生 showErrorBox
    mainWindow.webContents.send("app:open-error", file.error);
  }
}

function pushOpenFile(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("app:open-file", payload);
  }
}

/* ---------- 命令行 / 文件关联 ---------- */

function extractFilesFromArgv(argv) {
  // argv[0]=electron, argv[1]=脚本或打包名；其后才可能是用户传入的文件
  const files = [];
  for (let i = 1; i < argv.length; i++) {
    const candidate = argv[i];
    if (candidate && hasMdExtension(candidate) && fs.existsSync(candidate)) {
      files.push(candidate);
    }
  }
  return files;
}

async function openFromArgv(argv) {
  for (const filePath of extractFilesFromArgv(argv)) {
    const file = await readMarkdownFile(filePath);
    if (file.ok) {
      pushOpenFile(file);
    }
  }
}

/* ---------- 文档内链接（批次 1） ----------
 * 正文里的 <a href> 此前完全没有处理，点击会走 Chromium 默认导航 —— 相对路径
 * 会把整个窗口顶掉（无边框外壳、标题栏、tab 栏一起消失），外链则是打不开的
 * 错误页。渲染层已把<a>点击全部接管（preventDefault + 委托），这里是落点。
 *
 * 分流（离线环境，能做的事很少，能做的事做干净）：
 *   ① 外链 / 未知协议 → 一律不进文件系统，复制到剪贴板（用户自己贴到能上网的机器）
 *   ② file: 协议 → 还原成本地路径，按 ③④ 继续处理
 *   ③ 本地 md 家族且存在 → 复用 openFileFromPath()（自动获得「同文件聚焦已有 tab」）
 *   ④ 非 md（图片/PDF/压缩包等）或文件不存在 → 复制绝对路径
 * 返回 {action, text|message}，提示文案由渲染层组装（应用内提示条只认文本）。 */

const HREF_PROTOCOL_RE = /^([a-z][a-z0-9+.-]*):/i;

/* 取出 href 的协议名；单字母「协议」其实是 Windows 盘符（C:\docs\a.md），不算协议 */
function hrefProtocol(href) {
  const m = HREF_PROTOCOL_RE.exec(href);
  if (!m) return "";
  return m[1].length === 1 ? "" : m[1].toLowerCase();
}

/* href → 绝对路径（与渲染层图片解析同口径：盘符开头 / 根相对 / 相对文档目录） */
function resolveHrefPath(basePath, href) {
  if (/^[a-zA-Z]:[\\/]/.test(href) || href.startsWith("\\\\")) {
    return path.resolve(href); // 已是绝对路径（含 UNC）
  }
  if (href.startsWith("/") || href.startsWith("\\")) {
    return path.resolve((String(basePath).slice(0, 2) || "C:") + href); // 根相对：挂文档所在盘符
  }
  return path.resolve(path.dirname(String(basePath)), href);
}

async function followLink(basePath, href) {
  if (typeof href !== "string" || !href.trim()) {
    return { action: "error", message: "链接为空" };
  }
  const raw = href.trim();

  // ① 外链 / 未知协议：不进 fs（javascript: 等已被 DOMPurify 拦掉，这里再兜一层）
  const proto = hrefProtocol(raw);
  if (proto && proto !== "file") {
    clipboard.writeText(raw);
    return { action: "external", text: raw };
  }

  // ② file: 协议还原成本地路径；还原失败（畸形 URL）就按外链复制
  let local = raw;
  if (proto === "file") {
    try {
      local = fileURLToPath(raw);
    } catch (_) {
      clipboard.writeText(raw);
      return { action: "external", text: raw };
    }
  }
  local = local.split("#")[0].split("?")[0]; // 锚点/查询串不参与路径解析
  try {
    local = decodeURIComponent(local); // 源里可能已写成 %20 转义
  } catch (_) {
    /* 含非法转义序列时按原样处理 */
  }
  if (!local) return { action: "error", message: "链接为空" };

  const abs = resolveHrefPath(basePath, local);

  let stat = null;
  try {
    stat = await fsp.stat(abs);
  } catch (_) {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    clipboard.writeText(abs);
    return { action: "missing", text: abs };
  }
  if (hasMdExtension(abs)) {
    await openFileFromPath(abs); // 统一出口：读失败会走 app:open-error 提示条
    return { action: "opened", text: abs };
  }
  clipboard.writeText(abs); // 非 md：阅读器不管，交出路径让用户自行处理
  return { action: "copied", text: abs };
}

/* ---------- 默认打开方式（M3-4，验收挂 M4 打包后） ----------
 * HKCU\Software\Classes 写 ProgID + 扩展名重定向，免管理员权限；
 * 已有关联时先弹确认框，绝不静默抢默认（Win8+ 也不允许写 UserChoice 哈希键）。
 */

const OPENER_PROG_ID = "MDReader.md";
const OPENER_EXTENSIONS = [".md", ".markdown"]; // .txt 等不抢，避免误伤记事本习惯

function regQueryDefault(keyPath) {
  return new Promise((resolve) => {
    execFile("reg", ["query", keyPath, "/ve"], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null); // 键不存在 → 视为无关联
      const m = /REG_SZ\s+(.*)/i.exec(stdout || "");
      resolve(m ? m[1].trim() : "");
    });
  });
}

function regAdd(args) {
  return new Promise((resolve, reject) => {
    execFile("reg", ["add", ...args], { windowsHide: true }, (err) =>
      err ? reject(err) : resolve()
    );
  });
}

async function checkDefaultOpener() {
  // 只查不写：是否存在冲突关联，由渲染层弹自绘确认框后再决定是否 apply
  try {
    const current =
      (await regQueryDefault("HKCU\\Software\\Classes\\.md")) ||
      (await regQueryDefault("HKCR\\.md"));
    if (current && current !== OPENER_PROG_ID) {
      return { conflict: true, current };
    }
    return { conflict: false, current: null };
  } catch (err) {
    return { conflict: false, current: null, error: err.message };
  }
}

async function applyDefaultOpener() {
  const exePath = process.execPath; // 打包后即 MDReader.exe，开发期为 electron.exe
  // 命令指向谁由「快速启动器」偏好决定：开启且启动器在位 → 指向 ~15KB 的启动器
  // （双击时被创建的映像小一个数量级），否则退回应用自身（旧行为）
  const cmdExe = openerCommandExe();
  const viaLauncher = cmdExe !== exePath;
  try {
    await regAdd([
      "HKCU\\Software\\Classes\\" + OPENER_PROG_ID,
      "/ve",
      "/d",
      "Markdown 文档 (MDReader)",
      "/f",
    ]);
    await regAdd([
      "HKCU\\Software\\Classes\\" + OPENER_PROG_ID + "\\DefaultIcon",
      "/ve",
      "/d",
      exePath + ",0",
      "/f",
    ]);
    await regAdd([
      "HKCU\\Software\\Classes\\" + OPENER_PROG_ID + "\\shell\\open\\command",
      "/ve",
      "/d",
      '"' + cmdExe + '" "%1"',
      "/f",
    ]);
    for (const ext of OPENER_EXTENSIONS) {
      await regAdd(["HKCU\\Software\\Classes\\" + ext, "/ve", "/d", OPENER_PROG_ID, "/f"]);
    }
    return {
      ok: true,
      message: viaLauncher
        ? "已将 .md / .markdown 关联到 MDReader（快速启动器）"
        : "已将 .md / .markdown 关联到 MDReader",
    };
  } catch (err) {
    return { ok: false, message: "注册失败：" + err.message };
  }
}

/* ---------- 快速启动器（M4-2） ----------
 * 实测：双击时被创建的那个进程，其「进程创建前的外部开销」（安全软件同步扫描
 * 映像）与映像体积正相关 —— MDReader.exe 150.3MB ≈ 3s，200KB 的对照 exe ≈ 1.5s。
 * 托盘常驻已把进程内耗时压到 ~0.7s，剩下的大头就是这一笔映像开销。
 *
 * 对策：把 .md 关联指向 native/launcher/launcher.c 编出来的 ~15KB 原生启动器。
 * 它只做一件事 —— 把文件路径经命名管道交给常驻实例后立刻退出；连不上（未常驻）
 * 就退回「直接拉起 MDReader.exe」，行为与旧版一致。
 * 服务端用 Node 内置 net，零新增依赖；关闭该偏好即整体回退到旧路径。
 */
const LAUNCHER_NAME = "MDReaderLauncher.exe";
const PIPE_NAME = "\\\\.\\pipe\\mdreader";
let pipeServer = null;

function launcherPath() {
  // 与 MDReader.exe 同目录（打包时由 tools/postpack.js 放到产物根目录）
  return path.join(path.dirname(process.execPath), LAUNCHER_NAME);
}

function launcherAvailable() {
  try {
    return fs.statSync(launcherPath()).isFile();
  } catch (_) {
    return false; // 开发期 / 未打包时不存在
  }
}

/* 关联命令该指向谁 */
function openerCommandExe() {
  if (readPrefs().fastLauncher !== false && launcherAvailable()) {
    return launcherPath();
  }
  return process.execPath;
}

/* 启动器消息：`<procBootMs>\n<文件路径>`（UTF-16LE；路径可空 = 只唤出窗口）。
 * procBootMs 由启动器自己用 GetProcessTimes 度量（进程创建 → 代码执行，也就是
 * 映像被创建/扫描的那一段），协议保留该字段以便日后诊断，当前不再落盘。 */
function handleLauncherMessage(buf) {
  const text = buf.toString("utf16le").replace(/\u0000+$/, "");
  const nl = text.indexOf("\n");
  const fileRaw = nl >= 0 ? text.slice(nl + 1) : "";
  showWindow(); // 常驻态先恢复可见（并收起托盘），再打开文件
  if (fileRaw) openFileFromPath(fileRaw);
}

function startPipeServer() {
  if (pipeServer) return;
  pipeServer = net.createServer((socket) => {
    const chunks = [];
    socket.on("data", (d) => chunks.push(d));
    socket.on("error", () => {});
    socket.on("end", () => handleLauncherMessage(Buffer.concat(chunks)));
  });
  pipeServer.on("error", () => {
    // 监听失败不致命：启动器连不上会自行退回冷启动（拉起 MDReader.exe），只是没享受到加速
  });
  pipeServer.listen(PIPE_NAME);
}

/* 切换快速启动器：写偏好；若 .md 关联已经在我们手上，顺手改写命令路径
 * （否则用户还得再点一次「设为默认打开方式」才生效） */
async function toggleFastLauncher(enabled) {
  const value = writePrefs({ fastLauncher: !!enabled }).fastLauncher;
  let reApplied = false;
  const cmd = await regQueryDefault(
    "HKCU\\Software\\Classes\\" + OPENER_PROG_ID + "\\shell\\open\\command"
  );
  if (cmd && cmd.toLowerCase().indexOf(path.dirname(process.execPath).toLowerCase()) >= 0) {
    reApplied = !!(await applyDefaultOpener()).ok;
  }
  return { fastLauncher: value, available: launcherAvailable(), reApplied };
}

/* ---------- 文件 stat（外部修改检测用） ---------- */

async function statFile(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return { ok: true, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ---------- 窗口 ---------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    // Typora 风格：无边框 + 自绘标题栏/工具栏
    frame: false,
    // 窗口创建即显示（Typora 同款策略）：背景色按当前系统明暗预设，不白闪；
    // 正文外壳（标题栏/工具栏）由渲染层随后绘出，不等 ready-to-show。
    // 此前等 ready-to-show 才显窗，冷启动下用户有数秒看不到任何窗口，
    // 性能差的机器上会被误认为没响应。
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0d1117" : "#fafafa",
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "api.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // 原生菜单彻底隐藏（操作走自绘工具栏）；菜单加速键仍全局生效
  mainWindow.setMenuBarVisibility(false);

  /* 导航守卫（批次 1）：离线阅读器没有任何理由让页面导航离开自身。
   * 渲染层已接管正文里的 <a> 点击，这里是兜底 —— 任何漏网的导航都会把整个
   * 窗口顶掉（无边框外壳/标题栏/tab 栏一起消失），target="_blank" 更会开出一个
   * 没有 preload 的裸窗口。一律阻断；同 URL 放行，避免误伤手动 reload。 */
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const current = mainWindow ? mainWindow.webContents.getURL() : "";
    if (url !== current) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // 最大化状态推送给渲染层，用于切换标题栏按钮图标
  const sendMaximized = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("app:maximized", mainWindow.isMaximized());
    }
  };
  mainWindow.on("maximize", sendMaximized);
  mainWindow.on("unmaximize", sendMaximized);

  // 关窗拦截：按用户偏好决定「询问 / 常驻托盘 / 完全退出」；
  // 常驻用 hide() 保住渲染进程，双击 .md 走单实例唤起才是秒开。
  // 询问优先用渲染层自绘模态框（与整体风格一致），渲染层不可用时回退原生框
  mainWindow.on("close", (event) => {
    if (isQuitting) return; // 托盘退出 / app.quit()，放行
    const action = readPrefs().closeAction;
    if (action === "quit") return; // 记住为完全退出：直接放行
    event.preventDefault();
    if (closeDialogOpen) return; // 对话框已开着，忽略重复触发
    if (action === "tray") {
      hideToTray();
      return;
    }
    closeDialogOpen = true;
    const wc = mainWindow.webContents;
    if (wc && !wc.isDestroyed() && !wc.isLoading()) {
      wc.send("app:close-request");
      // 渲染层 8s 内未应答（脚本异常 / 消息丢失）→ 回退原生对话框
      setTimeout(() => {
        if (closeDialogOpen && mainWindow && !mainWindow.isDestroyed()) {
          showNativeCloseDialog();
        }
      }, 8000);
    } else {
      showNativeCloseDialog();
    }
  });

  // 开发期保留 DevTools 快捷键；打包后由菜单模板控制
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  ensureForeground(mainWindow);

  // 页面就绪后：先推启动元信息（渲染层据此决定是否恢复会话），
  // 再处理初始命令行文件（修复此前端口：仅 second-instance 处理过 argv）
  let startupArgvDone = false;
  mainWindow.webContents.on("did-finish-load", () => {
    if (startupArgvDone) return; // reload 时不重复推启动文件
    startupArgvDone = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("app:init-meta", {
        hasStartupFiles: extractFilesFromArgv(process.argv).length > 0,
      });
    }
    openFromArgv(process.argv);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/* ---------- 菜单 ---------- */

function buildMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        {
          label: "打开...",
          accelerator: "CmdOrCtrl+O",
          click: () => openViaDialogAndPush(),
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
      ],
    },
    {
      label: "查找",
      submenu: [
        {
          label: "查找",
          accelerator: "CmdOrCtrl+F",
          click: () => pushFindCommand("open"),
        },
        {
          label: "查找下一个",
          accelerator: "CmdOrCtrl+N",
          click: () => pushFindCommand("next"),
        },
        {
          label: "查找上一个",
          accelerator: "CmdOrCtrl+P",
          click: () => pushFindCommand("prev"),
        },
      ],
    },
    {
      label: "标签页",
      submenu: [
        {
          label: "关闭标签页",
          accelerator: "CmdOrCtrl+W",
          click: () => pushTabCommand("close"),
        },
        {
          label: "下一个标签页",
          accelerator: "CmdOrCtrl+Tab",
          click: () => pushTabCommand("next"),
        },
        {
          label: "上一个标签页",
          accelerator: "CmdOrCtrl+Shift+Tab",
          click: () => pushTabCommand("prev"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function pushTabCommand(cmd) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("app:tab-command", cmd);
  }
}

function pushFindCommand(cmd) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("app:find-command", cmd);
  }
}

/* ---------- IPC ---------- */

function registerIpc() {
  ipcMain.handle("dialog:open-md", async () => {
    return openFileDialog();
  });
  ipcMain.handle("file:read", (_event, filePath) => {
    return readMarkdownFile(filePath);
  });
  ipcMain.handle("file:stat", (_event, filePath) => {
    return statFile(filePath);
  });
  // 文档内链接（批次 1）：外链 / 非 md 目标复制到剪贴板，md 目标走统一打开出口
  ipcMain.handle("link:follow", (_event, basePath, href) => {
    return followLink(basePath, href);
  });
  ipcMain.handle("opener:check", () => {
    return checkDefaultOpener();
  });
  ipcMain.handle("opener:apply", () => {
    return applyDefaultOpener();
  });

  // 关闭行为偏好（渲染层 ··· 菜单读写；关窗询问勾选「记住」时主动推送变更）
  ipcMain.handle("prefs:get-close-action", () => readPrefs().closeAction);
  ipcMain.handle("prefs:set-close-action", (_event, action) => setCloseAction(action));

  // 快速启动器偏好（··· 菜单切换；available 为 false 时渲染层不展示该项）
  ipcMain.handle("prefs:get-fast-launcher", () => ({
    fastLauncher: readPrefs().fastLauncher !== false,
    available: launcherAvailable(),
  }));
  ipcMain.handle("prefs:set-fast-launcher", (_event, enabled) => toggleFastLauncher(enabled));

  // 渲染层自绘关窗询问的应答；原生兜底框已接管或已处理时（closeDialogOpen=false）忽略
  ipcMain.on("app:close-decision", (_event, payload) => {
    if (!closeDialogOpen) return;
    closeDialogOpen = false;
    const choice = payload && typeof payload === "object" ? payload.choice : null;
    const remember = !!(payload && payload.remember);
    if (choice !== "tray" && choice !== "quit") return; // cancel / 非法值：窗口保持原样
    if (remember) {
      writePrefs({ closeAction: choice });
    }
    if (choice === "tray") {
      hideToTray();
    } else {
      quitApp();
    }
  });

  // 无边框窗口控制（自绘标题栏用）
  ipcMain.on("win:minimize", () => {
    if (mainWindow) mainWindow.minimize();
  });
  ipcMain.on("win:toggle-maximize", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });
  ipcMain.on("win:close", () => {
    if (mainWindow) mainWindow.close();
  });

  // 主题模式同步（渲染层已做白名单校验，这里再兜底一次）
  ipcMain.on("theme:set", (_event, mode) => {
    if (mode === "light" || mode === "dark" || mode === "system") {
      nativeTheme.themeSource = mode;
    }
  });

  /* 导出 PDF：payload { html, title, defaultPath?, outPath? }。
   * outPath 仅供自动化测试直写目标文件；正常路径走保存对话框。 */
  ipcMain.handle("export:pdf", async (_event, payload) => {
    try {
      let target = payload && payload.outPath;
      if (!target) {
        const dlg = await dialog.showSaveDialog(mainWindow, {
          title: "导出为 PDF",
          defaultPath: (payload && payload.defaultPath) || "导出.pdf",
          filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
        });
        if (dlg.canceled || !dlg.filePath) return { ok: false, canceled: true };
        target = dlg.filePath;
      }
      const pdf = await runPrintToPdf(payload || {});
      await fsp.writeFile(target, pdf);
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

/* ---------- 导出 PDF（M5 批次 2） ----------
 * 渲染层把正文 DOM（pane.innerHTML）交上来，主进程负责纸面化：组装
 * tokens + content + 打印层（export-print.css）+ KaTeX 的完整 HTML，离屏窗口
 * 加载后 printToPDF —— Chromium 打印管线自动按 A4 分页，分页控制见
 * export-print.css（标题不孤悬页尾 / 表格行不切 / 代码折行）。
 * 恒亮色：导出容器不设 data-theme，tokens 的 :root 默认值即亮色。
 * 忽略屏幕缩放：导出 DOM 不经过 --font-factor，固定 16px 基准。 */

let printCssCache = null;

function katexCssInline() {
  const dir = path.join(__dirname, "..", "..", "vendor", "katex");
  const css = fs.readFileSync(path.join(dir, "katex.min.css"), "utf8");
  // @font-face 的相对字体引用改写为绝对 file URL，供离屏打印窗口加载
  return css.replace(/url\((['"]?)(fonts\/[^'")]+)\1\)/g, (m, q, rel) => {
    return "url(" + pathToFileURL(path.join(dir, rel)).href + ")";
  });
}

function printCss() {
  if (printCssCache === null) {
    const read = (p) => fs.readFileSync(p, "utf8");
    // KaTeX 样式一并内联（含公式的 MathML 隐藏规则），打印层最后覆盖屏幕差异
    printCssCache =
      katexCssInline() +
      "\n" +
      read(path.join(__dirname, "..", "renderer", "styles", "tokens.css")) +
      "\n" +
      read(path.join(__dirname, "..", "renderer", "styles", "content.css")) +
      "\n" +
      read(path.join(__dirname, "export-print.css"));
  }
  return printCssCache;
}

function escapeHtmlText(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const EXPORT_IMG_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

const EXPORT_IMG_SRC_RE = /(<img\b[^>]*?\bsrc=")file:\/\/\/([^"]*?)(")/g;

/* 正文里的相对图片在渲染期已被改写成 file:/// 绝对路径；PDF 内嵌需要转 data:。
 * 读取失败（文件被移动等）保留原引用，让导出继续而不中断。 */
function inlineExportImages(html) {
  return html.replace(EXPORT_IMG_SRC_RE, (m, head, urlPath, tail) => {
    try {
      const file = decodeURIComponent(urlPath);
      const mime = EXPORT_IMG_MIME[path.extname(file).toLowerCase()];
      if (!mime) return m;
      return head + "data:" + mime + ";base64," + fs.readFileSync(file).toString("base64") + tail;
    } catch (_) {
      return m;
    }
  });
}

function buildPrintHtml(bodyHtml, title) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtmlText(title)}</title>
<style>${printCss()}</style>
</head>
<body>
<div class="markdown-body">${bodyHtml}</div>
</body>
</html>`;
}

/* 等图片与 KaTeX 字体就绪再打印（超时兜底，缺失资源不无限等） */
const PRINT_WAIT_ASSETS = `new Promise(function (resolve) {
  var imgs = Array.prototype.slice.call(document.images);
  var left = imgs.filter(function (i) { return !i.complete; }).length;
  var fonts = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
  var settled = false;
  function finish() {
    if (settled) return;
    settled = true;
    Promise.race([fonts, new Promise(function (r) { setTimeout(r, 2000); })]).then(function () { resolve(true); });
  }
  if (left === 0) return finish();
  imgs.forEach(function (i) {
    i.addEventListener("load", step);
    i.addEventListener("error", step);
  });
  function step() {
    left -= 1;
    if (left === 0) finish();
  }
  setTimeout(function () { resolve(false); }, 8000);
})`;

/* 超宽公式缩放适配：KaTeX 内部尺寸全是 em 相对单位，改 .katex 的 font-size
 * 即整条公式等比缩放。测量用 scrollWidth/clientWidth —— overflow:visible 下
 * Chromium 的 scrollWidth 仍包含溢出内容（实测 1047/719）；版心宽度已由
 * export-print.css 钉死 178mm，离屏测量布局 == 纸面布局。两轮迭代兜底残差。 */
const PRINT_FIT_FORMULAS = `(function () {
  var els = document.querySelectorAll('.katex-display');
  var shrunk = 0;
  for (var pass = 0; pass < 2; pass++) {
    shrunk = 0;
    els.forEach(function (d) {
      var w = d.scrollWidth, avail = d.clientWidth;
      if (w > avail + 1) {
        var k = d.querySelector('.katex') || d;
        var fs = parseFloat(getComputedStyle(k).fontSize);
        k.style.fontSize = (Math.floor((fs * avail / w) * 100) / 100) + 'px';
        shrunk += 1;
      }
    });
  }
  return shrunk;
})()`;

async function runPrintToPdf(payload) {
  const bodyHtml = inlineExportImages(String(payload.html || ""));
  const tmpHtml = path.join(app.getPath("temp"), "mdreader-export-" + Date.now() + "-" + process.pid + ".html");
  fs.writeFileSync(tmpHtml, buildPrintHtml(bodyHtml, String(payload.title || "MDReader")), "utf8");
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadFile(tmpHtml);
    await win.webContents.executeJavaScript(PRINT_WAIT_ASSETS);
    await win.webContents.executeJavaScript(PRINT_FIT_FORMULAS);
    return await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: "A4",
    });
  } finally {
    win.destroy();
    fs.unlink(tmpHtml, () => {});
  }
}

/* ---------- 生命周期 ---------- */

app.whenReady().then(() => {
  registerIpc();
  buildMenu();
  startPipeServer(); // 快速启动器的落点：窗口还没建就先听着，避免早到的双击落空
  createWindow();

  app.on("second-instance", (_event, argv) => {
    // 常驻托盘时窗口是隐藏的：先恢复可见（并收起托盘），再打开文件
    showWindow();
    openFromArgv(argv);
  });

  app.on("before-quit", () => {
    isQuitting = true; // 任何退出路径都不再被 close 拦截
  });

  // 单窗口模型：正常关闭即退出；常驻中窗口不会真正 close，此事件理论上不触发，
  // 兜底防御：托盘还在（常驻态）时不退出
  app.on("window-all-closed", () => {
    if (!isQuitting && tray) return;
    app.quit();
  });
});

// macOS 拖到 Dock 图标的打开事件（打包后行为，开发期无害）
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (app.isReady() && hasMdExtension(filePath)) {
    readMarkdownFile(filePath).then((file) => {
      if (file.ok) pushOpenFile(file);
    });
  }
});
