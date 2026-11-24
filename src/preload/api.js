"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// 最小暴露面：只暴露具名方法与订阅入口，不泄漏 ipcRenderer 与任何 Node 能力
contextBridge.exposeInMainWorld("api", {
  /**
   * 打开文件选择对话框。
   * @returns {Promise<string|null>} 选中的文件路径；取消返回 null
   */
  openFileDialog() {
    return ipcRenderer.invoke("dialog:open-md");
  },

  /**
   * 读取本地 Markdown 文件。
   * @param {string} filePath
   * @returns {Promise<{ok: boolean, path?: string, content?: string, encoding?: string, stat?: object, error?: string}>}
   *   encoding 为探测出的文本编码（utf-8 / utf-16le / utf-16be / gb18030）
   */
  readFile(filePath) {
    return ipcRenderer.invoke("file:read", filePath);
  },

  /**
   * 跟随文档内链接（批次 1）。主进程按 href 分流：外链与非 md 目标写入剪贴板，
   * md 目标复用统一打开出口（同文件聚焦已有 tab）。页内 `#锚点` 不走这里。
   * @param {string} basePath 当前文档的绝对路径（相对链接的解析基准）
   * @param {string} href 正文里的原始 href
   * @returns {Promise<{action: "opened"|"external"|"copied"|"missing"|"error", text?: string, message?: string}>}
   */
  followLink(basePath, href) {
    return ipcRenderer.invoke("link:follow", basePath, href);
  },

  /**
   * 订阅主进程推送的打开文件事件（命令行参数、文件关联、菜单）。
   * @param {(payload: {ok: boolean, path?: string, content?: string, error?: string}) => void} callback
   */
  onOpenFile(callback) {
    const wrapped = (_event, payload) => callback(payload);
    ipcRenderer.on("app:open-file", wrapped);
    return () => ipcRenderer.removeListener("app:open-file", wrapped);
  },

  /**
   * 查询文件 stat（外部修改检测：mtime + size 比对）。
   * @param {string} filePath
   * @returns {Promise<{ok: boolean, mtimeMs?: number, size?: number, error?: string}>}
   */
  statFile(filePath) {
    return ipcRenderer.invoke("file:stat", filePath);
  },

  /**
   * 查询 .md 当前关联（只查不写，渲染层据此决定是否弹自绘确认框）。
   * @returns {Promise<{conflict: boolean, current: string|null, error?: string}>}
   */
  checkDefaultOpener() {
    return ipcRenderer.invoke("opener:check");
  },

  /**
   * 将 .md/.markdown 注册为 MDReader 打开（HKCU 写注册表，不弹任何系统框）。
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  applyDefaultOpener() {
    return ipcRenderer.invoke("opener:apply");
  },

  /**
   * 订阅启动元信息（渲染层据此决定是否恢复上次会话）。
   * @param {(meta: {hasStartupFiles: boolean}) => void} callback
   */
  onInitMeta(callback) {
    const wrapped = (_event, meta) => callback(meta);
    ipcRenderer.once("app:init-meta", wrapped);
    return () => ipcRenderer.removeListener("app:init-meta", wrapped);
  },

  /**
   * 订阅查找命令（菜单加速器：Ctrl+F 打开 / Ctrl+N 下一个 / Ctrl+P 上一个）。
   * @param {("open"|"next"|"prev") => void} callback
   */
  onFindCommand(callback) {
    const wrapped = (_event, cmd) => callback(cmd);
    ipcRenderer.on("app:find-command", wrapped);
    return () => ipcRenderer.removeListener("app:find-command", wrapped);
  },

  /**
   * 订阅主进程推送的标签页命令（菜单加速器：关闭/切换）。
   * @param {("close"|"next"|"prev") => void} callback
   */
  onTabCommand(callback) {
    const wrapped = (_event, cmd) => callback(cmd);
    ipcRenderer.on("app:tab-command", wrapped);
    return () => ipcRenderer.removeListener("app:tab-command", wrapped);
  },

  /**
   * 同步主题模式到主进程 nativeTheme（仅接受三个白名单值）。
   * @param {"light"|"dark"|"system"} mode
   */
  setThemeMode(mode) {
    if (mode === "light" || mode === "dark" || mode === "system") {
      ipcRenderer.send("theme:set", mode);
    }
  },

  /**
   * 导出当前正文为 PDF。payload: { html, title, defaultPath?, outPath? }；
   * outPath 仅供自动化测试直写，正常路径由主进程弹保存对话框。
   * @returns {Promise<{ok: boolean, path?: string, canceled?: boolean, error?: string}>}
   */
  exportPdf(payload) {
    return ipcRenderer.invoke("export:pdf", payload);
  },

  exportHtml(payload) {
    return ipcRenderer.invoke("export:html", payload);
  },

  /** 写系统剪贴板（代码块复制用）。@returns {Promise<boolean>} 是否成功 */
  copyText(text) {
    return ipcRenderer.invoke("clipboard:write", text);
  },

  /**
   * 查询关闭窗口行为（"ask" 每次询问 / "tray" 最小化到托盘 / "quit" 完全退出）。
   * @returns {Promise<"ask"|"tray"|"quit">}
   */
  getCloseAction() {
    return ipcRenderer.invoke("prefs:get-close-action");
  },

  /**
   * 设置关闭窗口行为（··· 菜单），主进程持久化并广播变更。
   * @param {"ask"|"tray"|"quit"} action
   * @returns {Promise<"ask"|"tray"|"quit">} 生效后的值
   */
  setCloseAction(action) {
    return ipcRenderer.invoke("prefs:set-close-action", action);
  },

  /**
   * 订阅关窗询问（主进程拦截 close 后触发；渲染层弹自绘模态框并回传决策）。
   * @param {() => void} callback
   */
  onCloseRequest(callback) {
    const wrapped = () => callback();
    ipcRenderer.on("app:close-request", wrapped);
    return () => ipcRenderer.removeListener("app:close-request", wrapped);
  },

  /**
   * 回传关窗询问的决策（choice: "tray"|"quit"|"cancel"，remember: 勾选记住）。
   * @param {{choice: "tray"|"quit"|"cancel", remember: boolean}} payload
   */
  closeDecision(payload) {
    ipcRenderer.send("app:close-decision", payload);
  },

  /**
   * 订阅打开失败提示（应用内错误提示条，替代原生 showErrorBox）。
   * @param {(message: string) => void} callback
   */
  onOpenError(callback) {
    const wrapped = (_event, message) => callback(message);
    ipcRenderer.on("app:open-error", wrapped);
    return () => ipcRenderer.removeListener("app:open-error", wrapped);
  },

  /**
   * 查询快速启动器状态（M4-2）。
   * @returns {Promise<{fastLauncher: boolean, available: boolean}>}
   *   available 为 false 表示启动器产物不在位（开发期 / 未打包），菜单项应隐藏
   */
  getFastLauncher() {
    return ipcRenderer.invoke("prefs:get-fast-launcher");
  },

  /**
   * 开关快速启动器（把 .md 关联指向 ~15KB 的原生启动器，双击时免于创建 150MB 映像）。
   * @param {boolean} enabled
   * @returns {Promise<{fastLauncher: boolean, available: boolean, reApplied: boolean}>}
   *   reApplied 为 true 表示关联已被主进程顺手改写
   */
  setFastLauncher(enabled) {
    return ipcRenderer.invoke("prefs:set-fast-launcher", enabled);
  },

  /**
   * 订阅关闭行为变更（关窗询问勾选「记住」时推送）。
   * @param {("ask"|"tray"|"quit") => void} callback
   */
  onCloseActionChanged(callback) {
    const wrapped = (_event, action) => callback(action);
    ipcRenderer.on("app:close-action-changed", wrapped);
    return () => ipcRenderer.removeListener("app:close-action-changed", wrapped);
  },

  /**
   * 无边框窗口控制（自绘标题栏）。
   */
  win: {
    minimize() {
      ipcRenderer.send("win:minimize");
    },
    toggleMaximize() {
      ipcRenderer.send("win:toggle-maximize");
    },
    close() {
      ipcRenderer.send("win:close");
    },
    /**
     * 订阅最大化状态变化（切换标题栏按钮图标）。
     * @param {(maximized: boolean) => void} callback
     */
    onMaximizedChange(callback) {
      const wrapped = (_event, maximized) => callback(maximized);
      ipcRenderer.on("app:maximized", wrapped);
      return () => ipcRenderer.removeListener("app:maximized", wrapped);
    },
  },
});
