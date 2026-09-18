"use strict";

/* MDReader 渲染器核心（M3-1：多 tab）
 * 管线：markdown-it(html:false) → DOMPurify → 注入 tab pane
 * 依赖 vendor/markdown-it.min.js（全局 markdownit）、purify.min.js（DOMPurify）、
 *       highlight.min.js（hljs_bundle）、markdown-it-math.min.js（mdmath）、
 *       markdown-it-task.min.js（mdtasks）、mermaid.min.js（按需懒加载，全局 mermaid）
 *
 * Tab 模型（M3-1 设计共识）：
 * - 每个 tab 常驻一棵 DOM 树，切换只做显隐，零重解析；
 * - DOM 数量上限 MAX_DOM_TABS，超限淘汰最久未看的 tab（存 HTML 快照，激活时重建）；
 * - 同路径重复打开 → 聚焦已有 tab 并用新内容重渲染（滚动位置保留）。
 */

(function () {
  const emptyEl = document.getElementById("empty-state");
  const errorEl = document.getElementById("error-banner");
  const openBtn = document.getElementById("btn-open");
  const titlebarFilename = document.getElementById("titlebar-filename");
  const tabbarEl = document.getElementById("tabbar");
  const tabsEl = document.getElementById("tabs");
  const panesEl = document.getElementById("panes");
  const viewerEl = document.getElementById("viewer");
  const outlineEl = document.getElementById("outline");
  const outlineListEl = document.getElementById("outline-list");
  const tbOutline = document.getElementById("tb-outline");

  const MAX_DOM_TABS = 10;

  if (typeof window.markdownit !== "function") {
    showError("markdown-it 未加载，请检查 vendor/ 目录");
    return;
  }
  if (typeof window.DOMPurify === "undefined") {
    showError("DOMPurify 未加载，请检查 vendor/ 目录");
    return;
  }

  const md = window.markdownit({
    html: false, // 原始 HTML 不进解析器，XSS 源头封禁
    linkify: true,
    typographer: true,
    // 代码高亮：highlight.js 精简包（vendor/highlight.min.js，全局 hljs_bundle）
    // 返回 "" 时 markdown-it 走默认转义路径，未知语言安全降级
    highlight(str, lang) {
      const hljs = window.hljs_bundle;
      if (hljs && lang && hljs.getLanguage(lang)) {
        try {
          return (
            '<pre><code class="hljs language-' +
            lang +
            '">' +
            hljs.highlight(str, { language: lang }).value +
            "</code></pre>"
          );
        } catch (_) {
          /* 落入默认转义 */
        }
      }
      return "";
    },
  });

  // 数学公式：KaTeX + texmath（vendor/markdown-it-math.min.js，全局 mdmath 注册函数）
  if (typeof window.mdmath === "function") {
    window.mdmath(md);
  }

  // 任务列表：- [x] 渲染为复选框（vendor/markdown-it-task.min.js，全局 mdtasks）
  if (typeof window.mdtasks === "function") {
    md.use(window.mdtasks);
  }

  /* ---------- Mermaid 流程图（M2-4） ----------
   * fence 规则把 ```mermaid 代码块转为占位 div；
   * 页面里检测到占位块才动态加载 vendor/mermaid.min.js（UMD，全局 mermaid），
   * 普通文档零加载成本。渲染交给 mermaid.init，解析失败由 mermaid 输出错误图形。
   */

  const defaultFence =
    md.renderer.rules.fence ||
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    if (token.info.trim() === "mermaid") {
      return (
        '<div class="mermaid-block" data-mermaid="pending">' +
        md.utils.escapeHtml(token.content) +
        "</div>"
      );
    }
    return defaultFence(tokens, idx, md.options, {}, md.renderer);
  };

  let mermaidLoadState = ""; // "" | "loading" | "ready"

  /* ---------- 大纲数据（M3-2） ----------
   * heading_open 渲染规则：注入锚点 id + 在 env.outline 收集 {id, level, text}。
   * outline 随渲染管线顺带产出，零二次解析；id 内嵌进 HTML，
   * LRU 快照重建后锚点天然恢复，点击定位不受淘汰影响。
   */

  function inlinePlainText(token) {
    // 从 inline token 的子树抽纯文本（跳过强调/链接等装饰，图片取 alt）
    let out = "";
    const walk = (children) => {
      for (const c of children) {
        if (c.type === "text" || c.type === "code_inline") {
          out += c.content;
        } else if (c.type === "softbreak" || c.type === "hardbreak") {
          out += " ";
        } else if (c.children) {
          walk(c.children);
        }
      }
    };
    if (token && token.children) walk(token.children);
    else if (token) out = token.content;
    return out.replace(/\s+/g, " ").trim();
  }

  const defaultHeadingOpen =
    md.renderer.rules.heading_open ||
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const id = "mdh-" + env.headingSeq++;
    token.attrSet("id", id);
    env.outline.push({
      id,
      level: Number(token.tag.slice(1)),
      text: inlinePlainText(tokens[idx + 1]),
    });
    return defaultHeadingOpen(tokens, idx, options, env, self);
  };

  function runMermaid(blocks) {
    const mermaid = window.mermaid;
    if (!mermaid) return;
    try {
      mermaid.initialize({
        startOnLoad: false,
        theme: document.documentElement.dataset.theme === "dark" ? "dark" : "neutral",
        securityLevel: "strict", // 图内禁外链/交互，内网阅读器安全基线
        fontFamily: getComputedStyle(document.body).fontFamily,
      });
      blocks.forEach((el) => el.removeAttribute("data-mermaid"));
      mermaid.init(undefined, blocks);
    } catch (_) {
      blocks.forEach((el) => {
        el.removeAttribute("data-mermaid");
        el.classList.add("mermaid-error");
      });
    }
  }

  function initMermaid(rootEl) {
    const blocks = rootEl.querySelectorAll('.mermaid-block[data-mermaid="pending"]');
    if (!blocks.length) return;
    if (mermaidLoadState === "ready") {
      runMermaid(blocks);
      return;
    }
    // 懒加载：仅当文档含 mermaid 图块时才引入 ~1MB 的库
    const script = document.createElement("script");
    script.src = "../../vendor/mermaid.min.js";
    script.onload = () => {
      mermaidLoadState = "ready";
      runMermaid(rootEl.querySelectorAll('.mermaid-block[data-mermaid="pending"]'));
    };
    script.onerror = () => {
      blocks.forEach((el) => {
        el.removeAttribute("data-mermaid");
        el.classList.add("mermaid-error");
        el.title = "mermaid 库加载失败";
      });
    };
    if (mermaidLoadState !== "loading") {
      mermaidLoadState = "loading";
      document.head.appendChild(script);
    }
  }

  let errorTimer = null;

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      errorEl.hidden = true;
    }, 4000);
  }

  function basename(p) {
    return String(p).split(/[\\/]/).pop();
  }

  /* ---------- 相对路径图片解析（M2-2） ---------- */

  function docDir(docPath) {
    const s = String(docPath);
    const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return i > 0 ? s.slice(0, i) : "";
  }

  function toFileUrl(absPath) {
    // 先尝试解码（源里可能已含 %20 等），再按段编码
    let p = String(absPath).replace(/\\/g, "/");
    try {
      p = decodeURIComponent(p);
    } catch (_) {
      /* 保留原样 */
    }
    const segs = [];
    for (const seg of p.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        segs.pop();
        continue;
      }
      segs.push(seg);
    }
    return "file:///" + segs.map(encodeURIComponent).join("/");
  }

  function resolveImageSrc(src, docPath) {
    if (/^(https?:|data:|file:)/i.test(src) || src.startsWith("#")) {
      return null;
    }
    const dir = docDir(docPath);
    let p = src.replace(/\\/g, "/");
    if (/^[a-zA-Z]:/.test(p)) {
      // 盘符开头的绝对路径，直接用
    } else if (p.startsWith("/")) {
      // 根相对路径：挂到文档所在盘符
      p = (docPath.slice(0, 2) || "C:") + p;
    } else if (dir) {
      p = dir.replace(/\\/g, "/") + "/" + p;
    } else {
      return null;
    }
    return toFileUrl(p);
  }

  function rewriteImages(rootEl, docPath) {
    rootEl.querySelectorAll("img[src]").forEach((img) => {
      const url = resolveImageSrc(img.getAttribute("src"), docPath);
      if (url) img.src = url;
    });
  }

  /* ---------- Tab 状态模型（M3-1） ---------- */

  let tabs = []; // UI 顺序 = 数组顺序
  let activeTabId = null;
  let nextTabId = 1;
  let lruTick = 0;

  function getTab(id) {
    return tabs.find((t) => t.id === id) || null;
  }

  function getActiveTab() {
    return getTab(activeTabId);
  }

  function createPane(tab) {
    const pane = document.createElement("article");
    pane.className = "markdown-body tab-pane";
    pane.dataset.tabId = String(tab.id);
    panesEl.appendChild(pane);
    tab.pane = pane;
    return pane;
  }

  /* 完整渲染管线：解析 → 净化 → 图片改写 → mermaid（env 顺带产出大纲） */
  function renderDocument(tab) {
    if (!tab.pane) createPane(tab);
    const env = { headingSeq: 0, outline: [] };
    tab.pane.innerHTML = window.DOMPurify.sanitize(md.render(tab.content, env));
    rewriteImages(tab.pane, tab.path);
    initMermaid(tab.pane);
    tab.outline = env.outline;
    tab.display = "dom";
    tab.html = null;
  }

  /* 淘汰：DOM 快照为 HTML 字符串（切回时毫秒级重建，无需再解析/再跑 mermaid） */
  function evictTab(tab) {
    if (!tab.pane) return;
    tab.html = tab.pane.innerHTML;
    tab.pane.remove();
    tab.pane = null;
    tab.display = "cached";
  }

  function evictIfNeeded() {
    const domTabs = tabs.filter((t) => t.display === "dom" && t.id !== activeTabId);
    while (domTabs.length >= MAX_DOM_TABS) {
      let oldest = domTabs[0];
      for (const t of domTabs) {
        if (t.lastActive < oldest.lastActive) oldest = t;
      }
      evictTab(oldest);
      domTabs.splice(domTabs.indexOf(oldest), 1);
    }
  }

  function updateTabbar() {
    tabsEl.textContent = "";
    for (const tab of tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (tab.id === activeTabId ? " active" : "");
      el.dataset.tabId = String(tab.id);

      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = tab.title;
      title.title = tab.path;

      const close = document.createElement("button");
      close.className = "tab-close";
      close.type = "button";
      close.tabIndex = -1;
      close.title = "关闭 (Ctrl+W)";
      close.innerHTML =
        '<svg width="8" height="8" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>';
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      });

      el.appendChild(title);
      el.appendChild(close);
      el.addEventListener("click", () => activateTab(tab.id));
      tabsEl.appendChild(el);
    }
    tabbarEl.hidden = tabs.length === 0;
  }

  function updateEmptyState() {
    emptyEl.hidden = tabs.length > 0;
    if (tabs.length === 0) {
      document.title = "MDReader";
      titlebarFilename.textContent = "MDReader";
    }
    applyOutlineVisibility(); // 无打开文档时侧栏一并隐藏
  }

  function activateTab(id) {
    const target = getTab(id);
    if (!target) return;
    const prev = getActiveTab();
    if (prev && prev.id !== id && prev.display === "dom" && prev.pane) {
      prev.scrollTop = viewerEl.scrollTop; // 离开时保存滚动位置
    }

    // 快照重建（无解析、无 mermaid 重跑，快照本身已含最终图形）
    if (target.display === "cached" && !target.pane) {
      createPane(target);
      target.pane.innerHTML = target.html || "";
      target.html = null;
      target.display = "dom";
      if (!target.html && !target.pane.childElementCount) {
        renderDocument(target); // 快照缺失（主题切换作废）时全量重渲染
      }
    }

    for (const t of tabs) {
      if (t.pane) t.pane.classList.toggle("active", t.id === id);
    }
    activeTabId = id;
    target.lastActive = ++lruTick;
    evictIfNeeded();

    viewerEl.scrollTop = target.scrollTop || 0;
    document.title = target.title + " - MDReader";
    titlebarFilename.textContent = target.title;
    updateTabbar();
    renderOutline(); // 侧栏联动活动 tab
  }

  function openDocument(payload) {
    const key = String(payload.path).toLowerCase();
    const existing = tabs.find((t) => t.path.toLowerCase() === key);
    if (existing) {
      // 重复打开：聚焦 + 用新读到的内容重渲染（滚动位置保留）
      existing.content = payload.content;
      if (existing.display === "dom" && existing.pane) {
        renderDocument(existing);
        existing.pane.classList.add("active");
      } else {
        existing.html = null; // 下次激活全量重渲染
      }
      activateTab(existing.id);
      return;
    }

    const tab = {
      id: nextTabId++,
      path: payload.path,
      title: basename(payload.path),
      content: payload.content,
      display: "cached",
      html: null,
      pane: null,
      scrollTop: 0,
      lastActive: ++lruTick,
    };
    tabs.push(tab);
    renderDocument(tab);
    activateTab(tab.id);
    updateEmptyState();
  }

  function closeTab(id) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const tab = tabs[idx];
    if (tab.pane) tab.pane.remove();
    tabs.splice(idx, 1);

    if (activeTabId === id) {
      activeTabId = null;
      // 聚焦相邻 tab（优先右侧，其次左侧）
      const next = tabs[Math.min(idx, tabs.length - 1)];
      if (next) {
        activateTab(next.id);
      } else {
        viewerEl.scrollTop = 0;
        updateEmptyState();
        updateTabbar();
      }
    } else {
      updateTabbar();
    }
  }

  function cycleTab(dir) {
    if (tabs.length < 2) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const next = tabs[(idx + dir + tabs.length) % tabs.length];
    activateTab(next.id);
  }

  /* ---------- 大纲侧栏（M3-2） ---------- */

  const OUTLINE_KEY = "mdreader.outline";
  let outlineOpen = false;
  try {
    outlineOpen = localStorage.getItem(OUTLINE_KEY) === "1";
  } catch (_) {
    /* 读取失败按默认关处理 */
  }
  let spyScheduled = false;

  function applyOutlineVisibility() {
    outlineEl.hidden = !(outlineOpen && tabs.length > 0);
    tbOutline.classList.toggle("on", outlineOpen);
  }

  /* 用活动 tab 的大纲数组重建侧栏列表（层级相对最深根标题缩进） */
  function renderOutline() {
    const tab = getActiveTab();
    outlineListEl.textContent = "";
    if (!tab || !tab.outline || !tab.outline.length) {
      const d = document.createElement("div");
      d.className = "outline-empty";
      d.textContent = tab ? "此文档无标题" : "无打开文档";
      outlineListEl.appendChild(d);
      return;
    }
    let minLevel = 6;
    for (const o of tab.outline) {
      if (o.level < minLevel) minLevel = o.level;
    }
    for (const o of tab.outline) {
      const item = document.createElement("div");
      item.className = "outline-item";
      item.style.setProperty("--ol-level", String(o.level - minLevel));
      item.dataset.target = o.id;
      item.textContent = o.text || "(无标题)";
      item.addEventListener("click", () => jumpToHeading(o.id));
      outlineListEl.appendChild(item);
    }
    updateCurrentHeading();
  }

  function jumpToHeading(id) {
    const tab = getActiveTab();
    if (!tab || !tab.pane) return;
    const heading = tab.pane.querySelector("#" + CSS.escape(id));
    if (!heading) return;
    const top =
      heading.getBoundingClientRect().top -
      viewerEl.getBoundingClientRect().top +
      viewerEl.scrollTop -
      12; // 留一点呼吸空隙
    viewerEl.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  }

  /* 滚动跟随：视口顶部最近的高亮为当前标题（rAF 节流） */
  function updateCurrentHeading() {
    const tab = getActiveTab();
    if (!tab || !tab.pane) return;
    const items = outlineListEl.querySelectorAll(".outline-item");
    if (!items.length) return;
    const headings = tab.pane.querySelectorAll("h1,h2,h3,h4,h5,h6");
    const viewerTop = viewerEl.getBoundingClientRect().top;
    let current = -1;
    headings.forEach((h, i) => {
      if (h.getBoundingClientRect().top - viewerTop <= 80) current = i;
    });
    if (current === -1) current = 0; // 停在文档顶部时高亮第一个
    items.forEach((el, i) => el.classList.toggle("current", i === current));
    if (items[current]) {
      items[current].scrollIntoView({ block: "nearest" });
    }
  }

  viewerEl.addEventListener("scroll", () => {
    const tab = getActiveTab();
    if (tab) tab.scrollTop = viewerEl.scrollTop;
    if (spyScheduled) return;
    spyScheduled = true;
    requestAnimationFrame(updateCurrentHeading);
  });

  tbOutline.addEventListener("click", () => {
    outlineOpen = !outlineOpen;
    try {
      localStorage.setItem(OUTLINE_KEY, outlineOpen ? "1" : "0");
    } catch (_) {
      /* 持久化失败不阻塞切换 */
    }
    applyOutlineVisibility();
    renderOutline();
  });

  /* ---------- 打开入口 ---------- */

  async function openFileViaDialog() {
    const filePath = await window.api.openFileDialog();
    if (!filePath) return;
    const payload = await window.api.readFile(filePath);
    if (payload.ok) {
      openDocument(payload);
    } else {
      showError(payload.error);
    }
  }

  openBtn.addEventListener("click", () => {
    openFileViaDialog().catch((err) => showError(String(err)));
  });

  /* ---------- 无边框窗口控制 ---------- */

  const btnMin = document.getElementById("btn-min");
  const btnMax = document.getElementById("btn-max");
  const btnClose = document.getElementById("btn-close");

  btnMin.addEventListener("click", () => window.api.win.minimize());
  btnMax.addEventListener("click", () => window.api.win.toggleMaximize());
  btnClose.addEventListener("click", () => window.api.win.close());

  const iconMaximize = btnMax.querySelector(".icon-maximize");
  const iconRestore = btnMax.querySelector(".icon-restore");
  window.api.win.onMaximizedChange((maximized) => {
    iconMaximize.hidden = maximized;
    iconRestore.hidden = !maximized;
    btnMax.title = maximized ? "向下还原" : "最大化";
  });

  /* ---------- 工具栏：打开 + 字号缩放 + 主题 ---------- */

  document.getElementById("tb-open").addEventListener("click", () => {
    openFileViaDialog().catch((err) => showError(String(err)));
  });

  function applyFontFactor() {
    document.documentElement.style.setProperty(
      "--content-zoom",
      16 * fontFactor + "px"
    );
  }

  let fontFactor = 1;
  applyFontFactor();

  document.getElementById("tb-zoom-in").addEventListener("click", () => {
    fontFactor = Math.min(2, Math.round((fontFactor + 0.1) * 10) / 10);
    applyFontFactor();
  });
  document.getElementById("tb-zoom-out").addEventListener("click", () => {
    fontFactor = Math.max(0.6, Math.round((fontFactor - 0.1) * 10) / 10);
    applyFontFactor();
  });
  document.getElementById("tb-zoom-reset").addEventListener("click", () => {
    fontFactor = 1;
    applyFontFactor();
  });

  /* ---------- 主题切换（M2-5）：亮色 / 暗色 / 跟随系统 ---------- */

  const THEME_KEY = "mdreader.theme";
  const THEME_MODES = ["light", "dark", "system"];
  const THEME_LABELS = { light: "亮色", dark: "暗色", system: "跟随系统" };
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const tbTheme = document.getElementById("tb-theme");

  let themeMode = THEME_MODES.includes(localStorage.getItem(THEME_KEY))
    ? localStorage.getItem(THEME_KEY)
    : "system";

  function applyThemeMode() {
    const resolved =
      themeMode === "system" ? (darkQuery.matches ? "dark" : "light") : themeMode;
    document.documentElement.dataset.theme = resolved;
    tbTheme.querySelector(".theme-light").hidden = themeMode !== "light";
    tbTheme.querySelector(".theme-dark").hidden = themeMode !== "dark";
    tbTheme.querySelector(".theme-system").hidden = themeMode !== "system";
    tbTheme.title = "主题：" + THEME_LABELS[themeMode] + "（点击切换）";
    if (window.api.setThemeMode) window.api.setThemeMode(themeMode);
  }

  function cycleThemeMode() {
    themeMode =
      THEME_MODES[(THEME_MODES.indexOf(themeMode) + 1) % THEME_MODES.length];
    try {
      localStorage.setItem(THEME_KEY, themeMode);
    } catch (_) {
      /* 持久化失败不阻塞切换 */
    }
    const before = document.documentElement.dataset.theme;
    applyThemeMode();
    if (before === document.documentElement.dataset.theme) return;

    // 明暗切换：活动 tab 立即重渲染（mermaid 配色跟随）；缓存快照作废
    const active = getActiveTab();
    if (active) {
      if (active.display === "dom" && active.pane) {
        const st = viewerEl.scrollTop;
        renderDocument(active);
        viewerEl.scrollTop = st;
      } else {
        active.html = null; // 下次激活全量重渲染
      }
    }
  }

  darkQuery.addEventListener("change", () => {
    if (themeMode === "system") applyThemeMode();
  });

  tbTheme.addEventListener("click", cycleThemeMode);
  applyThemeMode();

  /* ---------- 主进程推送 ---------- */

  // 命令行参数 / 文件关联 / 菜单打开
  window.api.onOpenFile((payload) => {
    if (payload && payload.ok) {
      openDocument(payload);
    } else {
      showError(payload ? payload.error : "打开失败");
    }
  });

  // 菜单加速器：Ctrl+W / Ctrl+Tab / Ctrl+Shift+Tab
  window.api.onTabCommand((cmd) => {
    if (cmd === "close") {
      if (activeTabId !== null) closeTab(activeTabId);
    } else if (cmd === "next") {
      cycleTab(1);
    } else if (cmd === "prev") {
      cycleTab(-1);
    }
  });

  updateEmptyState();
})();
