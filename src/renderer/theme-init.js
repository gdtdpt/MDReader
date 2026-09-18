/* 主题预置（M2-5）：在样式表应用前设置 data-theme，避免暗色用户启动时白闪。
 * CSP script-src 'self'，故用独立文件而非内联；读取失败时保持亮色。 */
(function () {
  try {
    var mode = localStorage.getItem("mdreader.theme") || "system";
    var dark =
      mode === "dark" ||
      (mode === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch (_) {
    /* localStorage 不可用时保持亮色 */
  }
})();
