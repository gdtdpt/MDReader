"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// 最小暴露面：仅三个通道，不泄漏 ipcRenderer 与 Node 能力
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
   * @returns {Promise<{ok: boolean, path?: string, content?: string, error?: string}>}
   */
  readFile(filePath) {
    return ipcRenderer.invoke("file:read", filePath);
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
