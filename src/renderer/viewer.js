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
  const tbMore = document.getElementById("tb-more");
  const moreMenu = document.getElementById("more-menu");
  const recentListEl = document.getElementById("recent-list");
  const closeAskEl = document.getElementById("close-ask");
  const closeTrayEl = document.getElementById("close-tray");
  const closeQuitEl = document.getElementById("close-quit");
  const fastLauncherEl = document.getElementById("menu-fast-launcher");
  const modifiedBanner = document.getElementById("modified-banner");
  const modifiedText = document.getElementById("modified-text");
  const modifiedReload = document.getElementById("modified-reload");
  const modifiedIgnore = document.getElementById("modified-ignore");
  const findBar = document.getElementById("find-bar");
  const findInput = document.getElementById("find-input");
  const findCount = document.getElementById("find-count");
  const findPrevBtn = document.getElementById("find-prev");
  const findNextBtn = document.getElementById("find-next");
  const findCaseBtn = document.getElementById("find-case");
  const findCloseBtn = document.getElementById("find-close");

  const MAX_DOM_TABS = 10;

  if (typeof window.markdownit !== "function") {
    showError("markdown-it 未加载，请检查 vendor/ 目录");
    return;
  }
  if (typeof window.DOMPurify === "undefined") {
    showError("DOMPurify 未加载，请检查 vendor/ 目录");
    return;
  }

  /* ---------- markdown-it 实例工厂（M4 启动优化重构） ----------
   * 启动只同步加载 markdown-it + DOMPurify（实测 vendor 同步加载占 4.3s/4.8s），
   * highlight/KaTeX/task-lists 由首绘后的 loadDeferredVendor() 异步加载，
   * 到位后重建实例并重渲染（规则挂载全部收进工厂，重建即完整管线）。
   * 高亮回调运行时读 window.hljs_bundle，缺库自然走默认转义降级。
   */
  function createMarkdownIt() {
    const instance = window.markdownit({
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
      window.mdmath(instance);
    }

    // 任务列表：- [x] 渲染为复选框（vendor/markdown-it-task.min.js，全局 mdtasks）
    if (typeof window.mdtasks === "function") {
      instance.use(window.mdtasks);
    }

    const defaultFence =
      instance.renderer.rules.fence ||
      ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

    instance.renderer.rules.fence = (tokens, idx) => {
      const token = tokens[idx];
      if (token.info.trim() === "mermaid") {
        return (
          '<div class="mermaid-block" data-mermaid="pending">' +
          instance.utils.escapeHtml(token.content) +
          "</div>"
        );
      }
      return defaultFence(tokens, idx, instance.options, {}, instance.renderer);
    };

    const defaultHeadingOpen =
      instance.renderer.rules.heading_open ||
      ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

    instance.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
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

    return instance;
  }

  let md = createMarkdownIt();

  /* ---------- Mermaid 流程图（M2-4） ----------
   * fence 规则把 ```mermaid 代码块转为占位 div；
   * 页面里检测到占位块才动态加载 vendor/mermaid.min.js（UMD，全局 mermaid），
   * 普通文档零加载成本。渲染交给 mermaid.init，解析失败由 mermaid 输出错误图形。
   */

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

  function runMermaid(blocks) {
    const mermaid = window.mermaid;
    if (!mermaid) return;
    try {
      mermaid.initialize({
        startOnLoad: false,
        theme: document.documentElement.dataset.theme === "dark" ? "dark" : "neutral",
        securityLevel: "strict", // 图内禁外链/交互，阅读器安全基线
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

  function showNotice(message, ok) {
    errorEl.textContent = message;
    errorEl.classList.toggle("info", !!ok);
    errorEl.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      errorEl.hidden = true;
    }, ok ? 3000 : 4000);
  }

  function showError(message) {
    showNotice(message, false);
  }

  function basename(p) {
    return String(p).split(/[\\/]/).pop();
  }

  /* 非 UTF-8 文档解码提示（批次 1）：让用户知道「中文没乱」是因为自动认了编码，
   * 而不是怀疑文件被改过或内容缺失。UTF-8（含 BOM）是绝大多数情况，不打扰。 */
  const ENCODING_LABELS = {
    gb18030: "GB18030/GBK",
    "utf-16le": "UTF-16LE",
    "utf-16be": "UTF-16BE",
  };

  function notifyEncoding(payload) {
    const enc = payload && payload.encoding;
    if (!enc || enc === "utf-8") return;
    showNotice("已按 " + (ENCODING_LABELS[enc] || enc) + " 解码该文档", true);
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

  /* 外链点击是「复制链接」而不是「打开」（离线环境打不开），
   * 悬停提示让这个非默认行为可被发现；作者自己写了 title 的不覆盖。
   * 本地链接不标记：它们在应用内打开，符合直觉。 */
  function markExternalLinks(rootEl) {
    rootEl.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      const m = /^([a-z][a-z0-9+.-]*):/i.exec(href);
      if (!m || m[1].length === 1) return; // 盘符开头的绝对路径不算协议
      if (a.hasAttribute("title")) return;
      a.title = "点击复制链接";
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

  /* ---------- 代码块行号 ----------
   * 把 pre>code 的内容按逻辑行包成 <span class="cl">，行号交给 CSS 计数器生成：
   * 伪元素不参与 innerText，「复制代码」拿到的仍是纯代码；超宽行折行时样式层的
   * 悬挂缩进让续行与代码列对齐、行号列留白，读者凭行号即可判断续行归属。
   * hljs 的高亮 span 可能跨行（多行注释、多行字符串），拆行时按未闭合标签栈先
   * 在一行末尾闭合、在下一行开头重开，视觉与拆之前完全一致。 */
  function splitHtmlLines(html) {
    const lines = [];
    const stack = []; // 未闭合标签（按打开顺序，存原始开标签以便原样重开）
    let cur = "";
    let i = 0;
    while (i < html.length) {
      const ch = html[i];
      if (ch === "<") {
        const end = html.indexOf(">", i);
        if (end < 0) {
          cur += html.slice(i); // 残缺标签，原样收尾（实际不会发生）
          break;
        }
        const tag = html.slice(i, end + 1);
        const m = /^<(\/?)([a-zA-Z][\w-]*)/.exec(tag);
        if (!m) {
          cur += tag; // 注释 / doctype 等
        } else if (m[1] === "/") {
          const top = stack[stack.length - 1];
          if (top && top.name === m[2]) stack.pop();
          cur += tag;
        } else if (!/\/>$/.test(tag)) {
          stack.push({ name: m[2], open: tag });
          cur += tag;
        } else {
          cur += tag; // 自闭合
        }
        i = end + 1;
        continue;
      }
      if (ch === "\n") {
        for (let k = stack.length - 1; k >= 0; k--) cur += "</" + stack[k].name + ">";
        lines.push(cur);
        cur = stack.map((s) => s.open).join("");
        i += 1;
        continue;
      }
      cur += ch;
      i += 1;
    }
    lines.push(cur);
    return lines;
  }

  function wrapCodeLines(root) {
    root.querySelectorAll("pre > code").forEach((code) => {
      if (code.querySelector(".cl")) return; // 幂等：快照重建等路径可能已包过
      const lines = splitHtmlLines(code.innerHTML.replace(/\r\n?/g, "\n"));
      // 内容以换行结尾时 split 会多出一个空元素，去掉它（不会吃掉真实空行）
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      const frag = document.createDocumentFragment();
      for (let n = 0; n < lines.length; n++) {
        const span = document.createElement("span");
        span.className = "cl";
        span.innerHTML = lines[n]; // 内容来自已净化的 DOM，拆行不引入新标签
        frag.appendChild(span);
      }
      code.textContent = "";
      code.appendChild(frag);
      // 行号列宽按位数自适应（1ch ≈ 一个等宽数字），避免一位数时右侧一片空白
      code.style.setProperty("--ln-digits", String(String(lines.length).length));
      const pre = code.parentElement;
      if (pre) pre.classList.add("has-lines");
    });
  }

  /* 完整渲染管线：解析 → 净化 → 图片改写 → mermaid（env 顺带产出大纲） */
  function renderDocument(tab) {
    if (!tab.pane) createPane(tab);
    const env = { headingSeq: 0, outline: [] };
    tab.pane.innerHTML = window.DOMPurify.sanitize(md.render(tab.content, env));
    rewriteImages(tab.pane, tab.path);
    markExternalLinks(tab.pane);
    wrapCodeLines(tab.pane); // 行号：必须在 mermaid 替换之前（mermaid 块不是 pre）
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
    hideModifiedBanner(); // 提示条属于上一个 tab 的上下文
    closeFind(); // 查找状态不跨 tab 保留（M3-5 设计共识）
    checkExternalChange(target);
    scheduleSessionSave();
  }

  function openDocument(payload) {
    addRecent(payload.path); // 所有打开入口统一记最近文件
    const key = String(payload.path).toLowerCase();
    const existing = tabs.find((t) => t.path.toLowerCase() === key);
    if (existing) {
      /* 重复打开（双击关联 / 最近文件 / 拖拽）：mtime+size 未变时只聚焦，
       * 跳过整篇重解析与重渲染 —— 实测这一步 200~470ms，在快速启动器
       * 已经打掉外部常数之后，它已是双击延迟的主要剩余成本。
       * 判定口径与外部修改检测（checkExternalChange）一致：内容真的变了才重渲染。 */
      const unchanged =
        existing.stat &&
        payload.stat &&
        existing.stat.mtimeMs === payload.stat.mtimeMs &&
        existing.stat.size === payload.stat.size;
      if (unchanged && existing.display === "dom" && existing.pane) {
        activateTab(existing.id); // 聚焦 + 恢复滚动 + 刷新大纲
        return;
      }
      existing.content = payload.content;
      existing.stat = payload.stat || existing.stat;
      if (existing.display === "dom" && existing.pane) {
        renderDocument(existing);
        existing.pane.classList.add("active");
      } else {
        existing.html = null; // 下次激活全量重渲染
      }
      activateTab(existing.id);
      notifyEncoding(payload);
      scheduleSessionSave();
      return;
    }

    const tab = {
      id: nextTabId++,
      path: payload.path,
      title: basename(payload.path),
      content: payload.content,
      stat: payload.stat || null,
      display: "cached",
      html: null,
      pane: null,
      scrollTop: 0,
      lastActive: ++lruTick,
    };
    tabs.push(tab);
    renderDocument(tab);
    activateTab(tab.id);
    notifyEncoding(payload);
    updateEmptyState();
    scheduleSessionSave();
    loadDeferredVendor(); // 首绘已达成，异步补齐高亮/公式/任务列表
  }

  function closeTab(id) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const tab = tabs[idx];
    if (tab.pane) tab.pane.remove();
    tabs.splice(idx, 1);
    if (modifiedTabId === id) hideModifiedBanner();
    scheduleSessionSave();

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
        renderOutline();
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

  function scrollHeadingIntoView(heading) {
    const top =
      heading.getBoundingClientRect().top -
      viewerEl.getBoundingClientRect().top +
      viewerEl.scrollTop -
      12; // 留一点呼吸空隙
    viewerEl.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  }

  function jumpToHeading(id) {
    const tab = getActiveTab();
    if (!tab || !tab.pane) return;
    const heading = tab.pane.querySelector("#" + CSS.escape(id));
    if (!heading) return;
    scrollHeadingIntoView(heading);
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
    scheduleSessionSave();
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

  /* ---------- 文档内链接（批次 1） ----------
   * 正文里的 <a href> 必须全部接管：此前零处理，点击会走 Chromium 默认导航 ——
   * 相对路径把整个窗口顶掉（无边框外壳/标题栏/tab 栏一起消失），外链是打不开的
   * 错误页。主进程侧另有 will-navigate 兜底，这里是正常路径。
   * 分流：页内 #锚点 → 本地滚动；其余交主进程（外链 / 非 md → 复制；md → 打开）。
   */

  /* 标题 slug（对齐 GitHub / Typora 惯例）：小写、空白转连字符、去其余标点 */
  function slugify(text) {
    return String(text)
      .trim()
      .toLowerCase()
      .replace(/[\s\u3000]+/g, "-")
      .replace(/[^\w\u4e00-\u9fff-]/g, "");
  }

  /* 页内锚点跳转：标题 id 是合成序号（mdh-N），所以标准写法 [x](#中文标题) 的
   * href 不可能直接命中原生 id —— 先按原样试（兼容手写的 #mdh-3、自定义 id），
   * 未命中再用 slug 反查大纲标题文字。不动现有 id 方案，大纲与 LRU 快照都不受影响。 */
  function jumpToAnchor(rawFrag) {
    const tab = getActiveTab();
    if (!tab || !tab.pane) return;
    let frag = rawFrag;
    try {
      frag = decodeURIComponent(rawFrag); // href 里的中文可能是 %E4%B8%AD 形式
    } catch (_) {
      /* 含非法转义序列时按原样处理 */
    }
    if (!frag) {
      viewerEl.scrollTo({ top: 0, behavior: "auto" }); // [回到顶部](#)
      return;
    }
    let heading = tab.pane.querySelector("#" + CSS.escape(frag));
    if (!heading) {
      const needle = slugify(frag);
      const hit = needle
        ? (tab.outline || []).find((o) => slugify(o.text) === needle)
        : null;
      if (hit) heading = tab.pane.querySelector("#" + CSS.escape(hit.id));
    }
    if (!heading) {
      showError("未找到锚点：" + frag);
      return;
    }
    scrollHeadingIntoView(heading);
    updateCurrentHeading();
  }

  function shorten(text, max) {
    const s = String(text);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  panesEl.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const a = target.closest("a[href]");
    if (!a) return;
    e.preventDefault(); // 无论如何都不允许真导航（主进程还有一道兜底）
    const tab = getActiveTab();
    if (!tab) return;
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#")) {
      jumpToAnchor(href.slice(1));
      return;
    }
    if (!href) return;
    window.api
      .followLink(tab.path, href)
      .then((res) => {
        if (!res) return;
        if (res.action === "external") {
          showNotice("已复制链接：" + shorten(res.text, 60), true);
        } else if (res.action === "copied") {
          showNotice("非 Markdown 文件，已复制路径：" + basename(res.text), true);
        } else if (res.action === "missing") {
          showError("未找到文件，已复制路径：" + basename(res.text));
        } else if (res.action === "error") {
          showError(res.message || "链接打开失败");
        }
        // action === "opened"：目标已在应用内打开，界面上已有反馈，不再提示
      })
      .catch((err) => showError(String(err)));
  });

  // 中键/辅助键点击同样不能导航（Chromium 会走「新窗口」路径，主进程已 deny）
  panesEl.addEventListener("auxclick", (e) => {
    const target = e.target;
    if (target instanceof Element && target.closest("a[href]")) e.preventDefault();
  });

  /* ---------- 拖拽打开（M3-3） ----------
   * Electron 22 渲染层 File.path 直接携带完整路径（无需主进程转发），
   * 拿到路径后走既有 readFile → openDocument 管线（多文件多 tab、去重聚焦）。
   */

  // 与主进程 MD_EXTENSIONS 保持一致（渲染层拿不到主进程常量，改动时需两边同步）
  const DRAG_EXTENSIONS = ["md", "markdown", "mdown", "mkdn", "txt"];
  const dropOverlay = document.getElementById("drop-overlay");
  let dragDepth = 0;

  function hasDraggableExtension(name) {
    const m = /\.([a-z0-9]+)$/i.exec(String(name));
    return !!m && DRAG_EXTENSIONS.includes(m[1].toLowerCase());
  }

  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    const types = (e.dataTransfer && Array.from(e.dataTransfer.types)) || [];
    if (!types.includes("Files")) return; // 忽略文本/元素拖拽
    dragDepth++;
    dropOverlay.hidden = false;
  });

  window.addEventListener("dragover", (e) => {
    e.preventDefault(); // 关键：不阻止默认行为 Chromium 会直接打开被拖文件
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });

  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.hidden = true;
  });

  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length) openDroppedFiles(files);
  });

  async function openDroppedFiles(files) {
    const paths = [];
    let skipped = 0;
    for (const f of files) {
      if (f.path && hasDraggableExtension(f.path)) {
        paths.push(f.path);
      } else {
        skipped++;
      }
    }
    if (!paths.length) {
      showError("拖入的文件都不是 Markdown 文档");
      return;
    }
    let firstError = null;
    for (const p of paths) {
      const payload = await window.api.readFile(p);
      if (payload.ok) {
        openDocument(payload);
      } else {
        firstError = firstError || payload.error;
      }
    }
    if (firstError) showError(firstError);
    if (skipped) showError("已跳过 " + skipped + " 个不支持的文件");
  }

  /* ---------- 「···」菜单 + 最近文件（M3-4） ---------- */

  const RECENTS_KEY = "mdreader.recents";
  const RECENTS_MAX = 10;
  let recents = loadRecents();

  function loadRecents() {
    try {
      const v = JSON.parse(localStorage.getItem(RECENTS_KEY));
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch (_) {
      return [];
    }
  }

  function saveRecents() {
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
    } catch (_) {
      /* 持久化失败不影响使用 */
    }
  }

  function addRecent(p) {
    const key = String(p).toLowerCase();
    recents = [p, ...recents.filter((x) => x.toLowerCase() !== key)].slice(0, RECENTS_MAX);
    saveRecents();
  }

  function removeRecent(p) {
    const key = String(p).toLowerCase();
    recents = recents.filter((x) => x.toLowerCase() !== key);
    saveRecents();
  }

  function renderMoreMenu() {
    recentListEl.textContent = "";
    if (!recents.length) {
      const d = document.createElement("div");
      d.className = "menu-empty";
      d.textContent = "无最近文件";
      recentListEl.appendChild(d);
      return;
    }
    for (const p of recents) {
      const item = document.createElement("div");
      item.className = "menu-item recent-item";
      item.textContent = basename(p);
      item.title = p;
      item.addEventListener("click", () => {
        hideMoreMenu();
        openRecentFile(p);
      });
      recentListEl.appendChild(item);
    }
  }

  /* ---------- 关闭窗口行为（托盘常驻，M4） ----------
   * "ask" 每次询问 / "tray" 最小化到托盘 / "quit" 完全退出。
   * 真值由主进程持久化（mdreader-prefs.json），这里只展示与切换。
   */
  let closeAction = "ask";
  window.api.getCloseAction().then((v) => {
    if (v === "ask" || v === "tray" || v === "quit") closeAction = v;
  });
  window.api.onCloseActionChanged((v) => {
    closeAction = v;
  });

  const CLOSE_ITEMS = [
    ["ask", closeAskEl],
    ["tray", closeTrayEl],
    ["quit", closeQuitEl],
  ];

  function renderCloseActionItems() {
    for (const [value, el] of CLOSE_ITEMS) {
      el.querySelector(".menu-check").textContent = closeAction === value ? "✓" : "";
    }
  }

  for (const [value, el] of CLOSE_ITEMS) {
    el.addEventListener("click", async () => {
      hideMoreMenu();
      const applied = await window.api.setCloseAction(value);
      if (applied === "ask" || applied === "tray" || applied === "quit") {
        closeAction = applied;
      }
    });
  }

  /* ---------- 快速启动器（M4-2）
   * 把 .md 关联指向 ~15KB 的原生启动器：双击时不再创建 150MB 的 MDReader.exe，
   * 而是由小进程把文件路径经命名管道交给常驻实例（实测外部开销与映像体积
   * 正相关：150MB ≈ 3s，200KB ≈ 1.5s）。产物不在位（开发期）时整项隐藏。
   */
  let fastLauncher = { on: false, available: false };

  window.api.getFastLauncher().then((v) => {
    if (!v) return;
    fastLauncher = { on: !!v.fastLauncher, available: !!v.available };
    fastLauncherEl.hidden = !fastLauncher.available;
  });

  function renderFastLauncherItem() {
    fastLauncherEl.hidden = !fastLauncher.available;
    fastLauncherEl.querySelector(".menu-check").textContent = fastLauncher.on ? "✓" : "";
  }

  fastLauncherEl.addEventListener("click", async () => {
    hideMoreMenu();
    const res = await window.api.setFastLauncher(!fastLauncher.on);
    fastLauncher = { on: !!res.fastLauncher, available: !!res.available };
    if (!fastLauncher.available) {
      showNotice("未找到 MDReaderLauncher.exe（仅打包版可用）", false);
      return;
    }
    if (fastLauncher.on) {
      showNotice(
        res.reApplied ? "已启用快速启动器，.md 关联已更新" : "已启用快速启动器（下次设默认打开方式时生效）",
        true
      );
    } else {
      showNotice(res.reApplied ? "已停用快速启动器，.md 关联已还原" : "已停用快速启动器", true);
    }
  });

  /* ---------- 应用内模态对话框（M4，替代原生 showMessageBox） ----------
   * Promise 风格：appConfirm({title, message, detail, buttons, checkboxLabel})
   * → { index, checked }；Esc / 点击遮罩 = index -1（取消）。
   * 样式走 CSS 变量，明暗主题即时跟随。
   */
  const modalOverlay = document.getElementById("modal-overlay");
  const modalCard = document.getElementById("modal-card");
  const modalCheckbox = document.getElementById("modal-checkbox");
  let modalResolve = null;
  let modalPrevFocus = null;

  function settleModal(index) {
    if (!modalResolve) return;
    const resolve = modalResolve;
    modalResolve = null;
    const checked = modalCheckbox.checked;
    modalOverlay.hidden = true;
    if (modalPrevFocus && typeof modalPrevFocus.focus === "function") {
      modalPrevFocus.focus();
    }
    resolve({ index, checked });
  }

  function appConfirm(opts) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      modalPrevFocus = document.activeElement;
      document.getElementById("modal-title").textContent = opts.title || "";
      const msgEl = document.getElementById("modal-message");
      msgEl.textContent = opts.message || "";
      msgEl.hidden = !opts.message;
      const detEl = document.getElementById("modal-detail");
      detEl.textContent = opts.detail || "";
      detEl.hidden = !opts.detail;
      const rowEl = document.getElementById("modal-checkbox-row");
      document.getElementById("modal-checkbox-label").textContent =
        opts.checkboxLabel || "";
      rowEl.hidden = !opts.checkboxLabel;
      modalCheckbox.checked = false;
      const btnBox = document.getElementById("modal-buttons");
      btnBox.textContent = "";
      for (const b of opts.buttons || [{ label: "确定", primary: true }]) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "modal-btn" + (b.primary ? " primary" : "");
        btn.textContent = b.label;
        btn.addEventListener("click", () => settleModal(opts.buttons.indexOf(b)));
        btnBox.appendChild(btn);
      }
      modalOverlay.hidden = false;
      const primary = btnBox.querySelector(".primary") || btnBox.firstChild;
      primary.focus();
    });
  }

  // Esc 取消 + Tab 焦点圈定（捕获阶段拦截，避免触发查找栏等其他快捷键）
  document.addEventListener(
    "keydown",
    (e) => {
      if (modalOverlay.hidden) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        settleModal(-1);
      } else if (e.key === "Tab") {
        e.preventDefault();
        const nodes = [
          ...(document.getElementById("modal-checkbox-row").hidden
            ? []
            : [modalCheckbox]),
          ...modalCard.querySelectorAll(".modal-btn"),
        ];
        const i = nodes.indexOf(document.activeElement);
        const next = e.shiftKey
          ? nodes[(i - 1 + nodes.length) % nodes.length]
          : nodes[(i + 1) % nodes.length];
        next.focus();
      }
    },
    true
  );

  // 点击遮罩空白处 = 取消
  modalOverlay.addEventListener("mousedown", (e) => {
    if (e.target === modalOverlay) settleModal(-1);
  });

  // 关窗询问：主进程拦截 close 后推送，弹自绘框并把决策回传
  window.api.onCloseRequest(async () => {
    const res = await appConfirm({
      title: "关闭 MDReader",
      message: "完全退出，还是最小化到系统托盘继续后台运行？",
      detail: "驻留托盘后，双击 .md 文件可立即打开（无需等待启动）。",
      buttons: [
        { label: "最小化到托盘", primary: true },
        { label: "完全退出" },
        { label: "取消" },
      ],
      checkboxLabel: "记住我的选择（可在 ··· 菜单中修改）",
    });
    const choice = res.index === 0 ? "tray" : res.index === 1 ? "quit" : "cancel";
    window.api.closeDecision({
      choice,
      remember: res.checked && choice !== "cancel",
    });
  });

  // 打开失败：应用内错误提示条（替代原生 showErrorBox）
  window.api.onOpenError((message) => showError(message));

  async function openRecentFile(p) {
    const payload = await window.api.readFile(p);
    if (payload.ok) {
      openDocument(payload);
    } else {
      removeRecent(p); // 失效条目直接清掉，避免反复踩错
      showError(payload.error);
    }
  }

  function hideMoreMenu() {
    moreMenu.hidden = true;
  }

  function showMoreMenu() {
    renderMoreMenu();
    renderCloseActionItems();
    renderFastLauncherItem();
    moreMenu.hidden = false; // 先显示才有几何信息可量，同帧定位不闪烁
    // 菜单左缘对齐按钮左缘、贴按钮下方 4px；越出视口右缘时右移收进来
    const rect = tbMore.getBoundingClientRect();
    const menuWidth = moreMenu.offsetWidth || 260;
    const left = Math.min(rect.left, window.innerWidth - menuWidth - 8);
    moreMenu.style.left = Math.max(8, left) + "px";
    moreMenu.style.top = rect.bottom + 4 + "px";
  }

  tbMore.addEventListener("click", (e) => {
    e.stopPropagation();
    if (moreMenu.hidden) {
      showMoreMenu();
    } else {
      hideMoreMenu();
    }
  });

  // 点击菜单外部关闭
  document.addEventListener("click", (e) => {
    if (!moreMenu.hidden && !moreMenu.contains(e.target)) hideMoreMenu();
  });

  document.getElementById("menu-clear-recents").addEventListener("click", () => {
    recents = [];
    saveRecents();
    renderMoreMenu();
    hideMoreMenu();
  });

  /* 导出 PDF：正文 DOM 交给主进程纸面化（分页控制见 export-print.css）。
   * 恒亮色 / 固定 16px 基准都由主进程组装时保证，这里只交内容。 */
  document.getElementById("menu-export-pdf").addEventListener("click", async () => {
    hideMoreMenu();
    const tab = getActiveTab();
    if (!tab || !tab.path || tab.display !== "dom" || !tab.pane) {
      showNotice("当前没有可导出的文档", false);
      return;
    }
    showNotice("正在导出 PDF…", true);
    const res = await window.api.exportPdf({
      html: tab.pane.innerHTML,
      title: basename(tab.path),
      defaultPath: tab.path.replace(/\.[^.]+$/, "") + ".pdf",
    });
    if (res.ok) showNotice("已导出：" + res.path, true);
    else if (res.canceled) showNotice("已取消导出", true);
    else showNotice("导出失败：" + (res.error || "未知错误"), false);
  });

  /* 导出 HTML 单文件：同样只交内容，样式内联与图片/字体打包由主进程完成 */
  document.getElementById("menu-export-html").addEventListener("click", async () => {
    hideMoreMenu();
    const tab = getActiveTab();
    if (!tab || !tab.path || tab.display !== "dom" || !tab.pane) {
      showNotice("当前没有可导出的文档", false);
      return;
    }
    showNotice("正在导出 HTML…", true);
    const res = await window.api.exportHtml({
      html: tab.pane.innerHTML,
      title: basename(tab.path),
      defaultPath: tab.path.replace(/\.[^.]+$/, "") + ".html",
    });
    if (res.ok) showNotice("已导出：" + res.path, true);
    else if (res.canceled) showNotice("已取消导出", true);
    else showNotice("导出失败：" + (res.error || "未知错误"), false);
  });

  document.getElementById("menu-default-opener").addEventListener("click", async () => {
    hideMoreMenu();
    // 先查关联：有冲突才弹自绘确认框（应用内风格），无冲突直接写
    const check = await window.api.checkDefaultOpener();
    if (check.conflict) {
      const res = await appConfirm({
        title: "设为默认打开方式",
        message: "检测到 .md 当前关联到：" + check.current,
        detail: "是否改为用 MDReader 打开？仅修改当前用户设置，可随时在系统设置中改回。",
        buttons: [
          { label: "改为 MDReader", primary: true },
          { label: "取消" },
        ],
      });
      if (res.index !== 0) {
        showNotice("已取消，未修改关联", true);
        return;
      }
    }
    const result = await window.api.applyDefaultOpener();
    showNotice(result.message, result.ok);
  });

  /* ---------- 会话恢复（M3-4）：tab 路径 + 滚动位置 ---------- */

  const SESSION_KEY = "mdreader.session";
  let sessionTimer = null;
  let hasStartupFiles = false;

  function scheduleSessionSave() {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(saveSession, 500);
  }

  function saveSession() {
    try {
      if (tabs.length === 0) {
        localStorage.removeItem(SESSION_KEY);
        return;
      }
      const data = {
        tabs: tabs.map((t) => ({ path: t.path, scrollTop: t.scrollTop || 0 })),
        active: tabs.findIndex((t) => t.id === activeTabId),
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(data));
    } catch (_) {
      /* 持久化失败不影响使用 */
    }
  }

  /* 空启动时恢复上次会话；显式打开（命令行/关联/拖拽）不叠加恢复 */
  async function restoreSession() {
    if (hasStartupFiles || tabs.length > 0) return;
    let data = null;
    try {
      data = JSON.parse(localStorage.getItem(SESSION_KEY));
    } catch (_) {
      return;
    }
    if (!data || !Array.isArray(data.tabs) || !data.tabs.length) return;

    for (const entry of data.tabs) {
      if (!entry || typeof entry.path !== "string") continue;
      const payload = await window.api.readFile(entry.path);
      if (!payload.ok) continue; // 已删除/读失败：静默跳过
      openDocument(payload);
      const opened = tabs.find(
        (t) => t.path.toLowerCase() === entry.path.toLowerCase()
      );
      if (opened && typeof entry.scrollTop === "number") {
        opened.scrollTop = entry.scrollTop;
      }
    }
    // 激活上次的活动 tab 并还原滚动位置
    const idx = typeof data.active === "number" ? data.active : -1;
    const activeEntry = idx >= 0 ? data.tabs[idx] : null;
    if (activeEntry) {
      const t = tabs.find(
        (x) => x.path.toLowerCase() === activeEntry.path.toLowerCase()
      );
      if (t) {
        activateTab(t.id);
        viewerEl.scrollTop = t.scrollTop || 0;
        updateCurrentHeading();
      }
    }
    loadDeferredVendor();
  }

  window.api.onInitMeta((meta) => {
    hasStartupFiles = !!(meta && meta.hasStartupFiles);
  });
  // 元信息在 did-finish-load 即达，稍等一拍再尝试恢复（显式打开会先行占位）
  setTimeout(restoreSession, 300);

  /* ---------- 文件外部修改检测（M3-4）：激活/聚焦时 stat 比对 ---------- */

  let modifiedTabId = null;
  let modifiedStat = null;

  function hideModifiedBanner() {
    modifiedTabId = null;
    modifiedStat = null;
    modifiedBanner.hidden = true;
  }

  function showModifiedBanner(tab, stat) {
    modifiedTabId = tab.id;
    modifiedStat = stat;
    modifiedText.textContent = "「" + tab.title + "」已被外部修改";
    modifiedBanner.hidden = false;
  }

  async function checkExternalChange(tab) {
    if (!tab || !tab.path) return;
    const result = await window.api.statFile(tab.path);
    if (!result.ok) return; // 文件被删等异常：不干扰阅读
    if (!tab.stat) {
      tab.stat = result; // 旧会话/无基线：先建立基线
      return;
    }
    if (
      result.mtimeMs !== tab.stat.mtimeMs ||
      result.size !== tab.stat.size
    ) {
      if (tab.id === activeTabId) showModifiedBanner(tab, result);
    }
  }

  modifiedReload.addEventListener("click", async () => {
    const tab = getTab(modifiedTabId);
    hideModifiedBanner();
    if (!tab) return;
    const payload = await window.api.readFile(tab.path);
    if (!payload.ok) {
      showError(payload.error);
      return;
    }
    const st = viewerEl.scrollTop; // 重载保持滚动位置
    tab.content = payload.content;
    tab.stat = payload.stat;
    renderDocument(tab);
    viewerEl.scrollTop = st;
    renderOutline();
    showNotice("已重新加载 " + tab.title, true);
  });

  modifiedIgnore.addEventListener("click", () => {
    // 忽略 = 以当前磁盘状态为新基线
    const tab = getTab(modifiedTabId);
    if (tab && modifiedStat) tab.stat = modifiedStat;
    hideModifiedBanner();
  });

  // 应用窗口重新聚焦时也检查活动 tab
  window.addEventListener("focus", () => {
    const tab = getActiveTab();
    if (tab) checkExternalChange(tab);
  });

  /* ---------- 文档内查找（M3-5） ----------
   * CSS Custom Highlight API 高亮：Range 集合直接上色，
   * 不改 DOM、不与 mermaid/KaTeX 的结构冲突。
   * 快捷键（vim 方案）：Ctrl+N 下一个 / Ctrl+P 上一个 / Esc 关闭。
   */

  const highlightSupported =
    typeof window.Highlight === "function" && !!(window.CSS && CSS.highlights);
  let findMatches = []; // Range[]
  let findCurrent = -1;
  let findCaseSensitive = false;
  let findDebounce = null;

  function getFindRoot() {
    const tab = getActiveTab();
    return tab && tab.pane ? tab.pane : null;
  }

  /* 单文本节点内匹配（跨节点如 **粗体** 截断处 v1 不覆盖，跳过） */
  function collectFindRanges(root, query, caseSensitive) {
    const ranges = [];
    if (!query) return ranges;
    const needle = caseSensitive ? query : query.toLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const name = node.parentNode ? node.parentNode.nodeName : "";
        if (name === "SCRIPT" || name === "STYLE") return NodeFilter.FILTER_REJECT;
        return node.nodeValue && node.nodeValue.trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const hay = caseSensitive ? node.nodeValue : node.nodeValue.toLowerCase();
      let i = hay.indexOf(needle);
      while (i !== -1) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + needle.length);
        ranges.push(range);
        i = hay.indexOf(needle, i + needle.length);
      }
    }
    return ranges;
  }

  function applyFindHighlights() {
    if (!highlightSupported) return;
    CSS.highlights.delete("find-matches");
    CSS.highlights.delete("find-current");
    if (findMatches.length) {
      CSS.highlights.set("find-matches", new window.Highlight(...findMatches));
      if (findMatches[findCurrent]) {
        CSS.highlights.set("find-current", new window.Highlight(findMatches[findCurrent]));
      }
    }
  }

  function updateFindCount() {
    if (!findInput.value) {
      findCount.textContent = "0/0";
    } else if (!findMatches.length) {
      findCount.textContent = "无结果";
    } else {
      findCount.textContent = findCurrent + 1 + "/" + findMatches.length;
    }
  }

  function runFind() {
    const root = getFindRoot();
    findMatches = root ? collectFindRanges(root, findInput.value.trim(), findCaseSensitive) : [];
    findCurrent = findMatches.length ? 0 : -1;
    applyFindHighlights();
    updateFindCount();
    scrollToCurrentMatch();
  }

  function scheduleFind() {
    clearTimeout(findDebounce);
    findDebounce = setTimeout(runFind, 120);
  }

  function scrollToCurrentMatch() {
    if (findCurrent < 0 || !findMatches[findCurrent]) return;
    const rect = findMatches[findCurrent].getBoundingClientRect();
    const viewRect = viewerEl.getBoundingClientRect();
    const target =
      viewerEl.scrollTop + (rect.top - viewRect.top) - viewRect.height * 0.35;
    viewerEl.scrollTo({ top: Math.max(0, target), behavior: "auto" });
  }

  function stepFind(dir) {
    if (!findMatches.length) return;
    findCurrent = (findCurrent + dir + findMatches.length) % findMatches.length;
    applyFindHighlights();
    updateFindCount();
    scrollToCurrentMatch();
  }

  function openFind() {
    if (!getActiveTab()) {
      showNotice("先打开一个文档再查找", true);
      return;
    }
    findBar.hidden = false;
    findInput.focus();
    findInput.select();
    if (findInput.value) runFind();
  }

  function closeFind() {
    findBar.hidden = true;
    findMatches = [];
    findCurrent = -1;
    if (highlightSupported) {
      CSS.highlights.delete("find-matches");
      CSS.highlights.delete("find-current");
    }
  }

  findInput.addEventListener("input", scheduleFind);
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      stepFind(e.shiftKey ? -1 : 1); // Enter/Shift+Enter 作为 Ctrl+N/P 的补充
    } else if (e.key === "Escape") {
      closeFind();
    }
  });

  findNextBtn.addEventListener("click", () => stepFind(1));
  findPrevBtn.addEventListener("click", () => stepFind(-1));
  findCloseBtn.addEventListener("click", closeFind);
  findCaseBtn.addEventListener("click", () => {
    findCaseSensitive = !findCaseSensitive;
    findCaseBtn.classList.toggle("on", findCaseSensitive);
    runFind();
  });

  // 查找栏外点击不关闭（浮动面板）；Esc 全局兜底
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !findBar.hidden) closeFind();
  });

  /* ---------- 主进程推送 ---------- */

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

  const tbZoomOut = document.getElementById("tb-zoom-out");
  const tbZoomReset = document.getElementById("tb-zoom-reset");
  const tbZoomIn = document.getElementById("tb-zoom-in");

  /* 字号缩放（批次 1：改为持久化）
   * 此前 fontFactor 只是局部变量，每次启动都回到 1.0 —— 习惯放大阅读的用户
   * 每次都要重按几下。存 localStorage；非法值（越界/非数字）静默回默认。 */
  const ZOOM_KEY = "mdreader.zoom";
  const ZOOM_MIN = 0.6;
  const ZOOM_MAX = 2;

  function loadFontFactor() {
    try {
      const v = Number(localStorage.getItem(ZOOM_KEY));
      if (Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX) {
        return Math.round(v * 10) / 10;
      }
    } catch (_) {
      /* 读取失败回默认值 */
    }
    return 1;
  }

  let fontFactor = loadFontFactor();

  function applyFontFactor() {
    document.documentElement.style.setProperty(
      "--content-zoom",
      16 * fontFactor + "px"
    );
    // 版心宽度与字号等比联动（见 .markdown-body 的 max-width）：
    // 空间足够时整体放大，顶满可用宽度后只涨字号。宽度上限由 CSS 的 100% 兜底，
    // 因此窗口缩放、大纲开合都不需要这里重新计算。
    document.documentElement.style.setProperty(
      "--font-factor",
      String(fontFactor)
    );
    // 缩放未偏离原值时，重置按钮无意义 → 禁用
    tbZoomReset.disabled = fontFactor === 1;
    try {
      localStorage.setItem(ZOOM_KEY, String(fontFactor)); // 统一在此写回，三个按钮不各写一遍
    } catch (_) {
      /* 持久化失败不影响本次会话 */
    }
  }

  applyFontFactor();

  tbZoomIn.addEventListener("click", () => {
    fontFactor = Math.min(2, Math.round((fontFactor + 0.1) * 10) / 10);
    applyFontFactor();
  });
  tbZoomOut.addEventListener("click", () => {
    fontFactor = Math.max(0.6, Math.round((fontFactor - 0.1) * 10) / 10);
    applyFontFactor();
  });
  tbZoomReset.addEventListener("click", () => {
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

  /* 解析后的明暗值发生变化后重建：mermaid 图配色在渲染时就烧进 SVG（runMermaid
   * 读 documentElement.dataset.theme），不重跑管线不会换色；缓存快照同理作废。 */
  function refreshForResolvedTheme() {
    for (const t of tabs) {
      if (t.display === "cached") t.html = null; // 旧主题快照作废，激活时全量重渲染
    }
    const active = getActiveTab();
    if (active && active.display === "dom" && active.pane) {
      const st = viewerEl.scrollTop;
      renderDocument(active);
      viewerEl.scrollTop = st;
    }
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
    refreshForResolvedTheme();
  }

  /* 跟随系统（批次 1 修复）：此前 OS 切明暗只调了 applyThemeMode()，正文配色
   * 跟着 CSS 变量变了，但已渲染的 mermaid 图仍是旧配色（手动点工具栏切换正常，
   * 因为那条路径会重渲染）。这里补齐同一条重渲染路径。 */
  darkQuery.addEventListener("change", () => {
    if (themeMode !== "system") return;
    const before = document.documentElement.dataset.theme;
    applyThemeMode();
    if (before === document.documentElement.dataset.theme) return;
    refreshForResolvedTheme();
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

  // 查找加速器：Ctrl+F 打开 / Ctrl+N 下一个 / Ctrl+P 上一个（vim 方案）
  window.api.onFindCommand((cmd) => {
    if (cmd === "open") {
      openFind();
    } else if (cmd === "next") {
      if (!findBar.hidden) stepFind(1);
    } else if (cmd === "prev") {
      if (!findBar.hidden) stepFind(-1);
    }
  });

  /* ---------- vendor 懒加载（M4 启动优化） ----------
   * 实测：5 个 vendor 同步脚本加载占首屏 4.3s/4.8s（磁盘/CPU 稳态成本）。
   * 首绘后异步补齐其余三个库，全部到位后重建 markdown-it 实例并重渲染，
   * 滚动位置由 activateTab 恢复；单个脚本失败不阻塞其余（缺库功能降级，与原行为一致）。
   */
  const DEFERRED_VENDOR = [
    "../../vendor/highlight.min.js",
    "../../vendor/markdown-it-math.min.js",
    "../../vendor/markdown-it-task.min.js",
  ];
  let deferredState = ""; // "" | "loading" | "done"

  function loadDeferredVendor() {
    if (deferredState) return;
    deferredState = "loading";
    let pending = DEFERRED_VENDOR.length;
    const settle = () => {
      if (--pending > 0) return;
      md = createMarkdownIt();
      for (const t of tabs) {
        renderDocument(t); // LRU 快照一并失效重建，走新管线
      }
      const active = getActiveTab();
      if (active) activateTab(active.id); // 恢复滚动 + 刷新大纲
      deferredState = "done";
      // 到这里内容才算最终形态（含公式/高亮/任务列表）
    };
    for (const src of DEFERRED_VENDOR) {
      const s = document.createElement("script");
      s.src = src;
      s.onload = settle;
      s.onerror = settle;
      document.head.appendChild(s);
    }
  }

  // 兜底：无文件且无会话等任何路径都没触发时也要补齐懒加载库
  setTimeout(loadDeferredVendor, 3000);

  updateEmptyState();
})();
