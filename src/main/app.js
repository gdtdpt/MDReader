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
} = require("electron");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;

const MD_EXTENSIONS = ["md", "markdown", "mdown", "mkdn", "txt"];
const MD_FILTER_NAME = "Markdown 文档";

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/* ---------- 启动性能打点（M4 目标机量化用） ----------
 * 主进程标记：process 起点即本模块顶层；appReady / windowCreated / firstPaint。
 * 渲染层在首文档（或空状态）渲染完成后经 app:perf 回报 nav 相对耗时，
 * 主进程合并写入 userData/startup-timing.log，每次启动一行。
 */
const PERF_T0 = Date.now();
const PERF_MARKS = {};
function perfMark(name) {
  PERF_MARKS[name] = Date.now() - PERF_T0;
}
function appendStartupLog(rendererPerf) {
  const line = {
    time: new Date().toISOString(),
    processToReady: PERF_MARKS.appReady,
    processToWindow: PERF_MARKS.windowCreated,
    processToPaint: PERF_MARKS.firstPaint,
    renderer: rendererPerf || null,
  };
  try {
    fs.appendFile(
      path.join(app.getPath("userData"), "startup-timing.log"),
      JSON.stringify(line) + "\n",
      () => {}
    );
  } catch (_) {
    /* 日志失败不影响功能 */
  }
}

/* ---------- 托盘常驻与关闭行为（M4，Heinrich 确认方案） ----------
 * 不做开机自启；点 × 关窗时由用户选择「最小化到托盘 / 完全退出」，
 * 首次询问 + 可勾选记住；偏好存 userData/mdreader-prefs.json
 * （主进程要在 close 事件里同步决策，用不了渲染层 localStorage）。
 * 常驻 = mainWindow.hide() 而非销毁：唤起时不重起渲染进程，
 * 这是「双击 .md 秒开」的前提（目标机渲染进程冷启约 4.9s）。
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
    const content = await fsp.readFile(resolved, "utf8");
    // stat 信息随载荷返回：渲染层用于外部修改检测（mtime+size 比对）
    return {
      ok: true,
      path: resolved,
      content,
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
  const file = await readMarkdownFile(filePath);
  if (file.ok) {
    pushOpenFile(file);
  } else {
    // 应用内错误提示条（渲染层 showError），不再弹原生 showErrorBox
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("app:open-error", file.error);
    }
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
      '"' + exePath + '" "%1"',
      "/f",
    ]);
    for (const ext of OPENER_EXTENSIONS) {
      await regAdd(["HKCU\\Software\\Classes\\" + ext, "/ve", "/d", OPENER_PROG_ID, "/f"]);
    }
    return { ok: true, message: "已将 .md / .markdown 关联到 MDReader" };
  } catch (err) {
    return { ok: false, message: "注册失败：" + err.message };
  }
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
    // Typora 风格：无边框 + 自绘标题栏/工具栏（Heinrich 确认方案）
    frame: false,
    // 预设背景色配合 ready-to-show 防白闪；按当前系统明暗取色，
    // 窗口显示后渲染层会用 localStorage 里的偏好立即校正
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0d1117" : "#fafafa",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "api.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    perfMark("firstPaint");
    mainWindow.show();
  });

  // 原生菜单彻底隐藏（操作走自绘工具栏）；菜单加速键仍全局生效
  mainWindow.setMenuBarVisibility(false);

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
  ipcMain.handle("opener:check", () => {
    return checkDefaultOpener();
  });
  ipcMain.handle("opener:apply", () => {
    return applyDefaultOpener();
  });

  // 关闭行为偏好（渲染层 ··· 菜单读写；关窗询问勾选「记住」时主动推送变更）
  ipcMain.handle("prefs:get-close-action", () => readPrefs().closeAction);
  ipcMain.handle("prefs:set-close-action", (_event, action) => setCloseAction(action));

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

  // 渲染层启动性能回报 → 合并写日志（每次启动一行）。
  // 延迟 1.5s 落盘：等 ready-to-show（首次绘制）打点到位，避免字段缺失
  ipcMain.on("app:perf", (_event, data) => {
    const perf = data && typeof data === "object"
      ? { scripts: data.scripts, firstRender: data.firstRender, tabs: data.tabs }
      : null;
    setTimeout(() => appendStartupLog(perf), 1500);
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
}

/* ---------- 生命周期 ---------- */

app.whenReady().then(() => {
  perfMark("appReady");
  registerIpc();
  buildMenu();
  createWindow();
  perfMark("windowCreated");

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
