"use strict";

const { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } = require("electron");
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

let mainWindow = null;

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
    dialog.showErrorBox("打开失败", file.error);
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

async function setDefaultOpener() {
  const exePath = process.execPath; // 打包后即 MDReader.exe，开发期为 electron.exe
  try {
    const current =
      (await regQueryDefault("HKCU\\Software\\Classes\\.md")) ||
      (await regQueryDefault("HKCR\\.md"));
    if (current && current !== OPENER_PROG_ID) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: "question",
        title: "设为默认打开方式",
        message: "检测到 .md 当前关联到：" + current,
        detail:
          "是否改为用 MDReader 打开？仅修改当前用户设置，可随时在系统设置中改回。",
        buttons: ["改为 MDReader", "取消"],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice !== 0) {
        return { ok: false, message: "已取消" };
      }
    }
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
  ipcMain.handle("app:set-default-opener", () => {
    return setDefaultOpener();
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    openFromArgv(argv);
  });

  // M1：单窗口模型，全平台关闭即退出
  app.on("window-all-closed", () => {
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
