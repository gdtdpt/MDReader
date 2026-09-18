# vendor/ 离线库登记

本目录存放运行时使用的第三方单文件库。**运行时零 npm 依赖、零网络加载**，所有库在开发期一次性产出并入库。

| 文件 | 库 | 版本 | 来源 | 产出方式 | 许可证 |
|---|---|---|---|---|---|
| `markdown-it.min.js` | markdown-it | 14.3.2 | npm `markdown-it@14` | esbuild bundle：入口 `module.exports = require("markdown-it")`，`--bundle --minify --format=iife --global-name=markdownit --define:process.env.NODE_ENV="production"`，暴露全局 `markdownit` | MIT |
| `purify.min.js` | DOMPurify | 3.4.15 | npm `dompurify@3`（直接取 `dist/purify.min.js`） | 官方 UMD 单文件，未做修改 | Apache-2.0 / MPL-2.0 双许可 |
| `highlight.min.js` | highlight.js | 11.12.0 | npm `highlight.js@11`（core + 23 种语言按需注册） | esbuild bundle：入口为 `highlight.js/lib/core` + `registerLanguage` 列表（js/ts/xml/css/scss/json/yaml/bash/shell/python/java/c/cpp/csharp/go/rust/php/ruby/sql/markdown/diff/ini/dockerfile），`--format=iife --global-name=hljs_bundle`，暴露全局 `hljs_bundle` | BSD-3-Clause |
| `markdown-it-math.min.js` | KaTeX + markdown-it-texmath | 0.16.47 / 1.0.0 | npm `katex@0.16` + `markdown-it-texmath@1` | esbuild bundle：入口为注册函数 `md.use(texmath, {engine: katex, delimiters: "dollars", katexOptions: {throwOnError:false}})`，`--format=iife --global-name=mdmath`，暴露全局 `mdmath`；KaTeX 样式与字体在 `katex/`（katex.min.css + fonts/） | KaTeX: MIT；texmath: MIT |
| `mermaid.min.js` | Mermaid | 9.4.3 | npm `mermaid@9`（直接取 `dist/mermaid.min.js`） | 官方 UMD 单文件，未做修改；**按需懒加载**——仅当文档含 ` ```mermaid ` 代码块时由 viewer.js 动态插入 script，全局 `mermaid` | MIT |
| `markdown-it-task.min.js` | markdown-it-task-lists | 2.1.1 | npm `markdown-it-task-lists` | esbuild bundle：入口 `module.exports = require("markdown-it-task-lists")`，`--bundle --minify --format=iife --global-name=mdtasks`，暴露全局 `mdtasks`；`- [x]` 渲染为禁用复选框 | MIT |

## 重新构建步骤（联网开发机执行）

1. 在隔离 node workspace 安装 `markdown-it@14`、`dompurify@3`、`esbuild`。
2. 入口文件内容：`module.exports = require("markdown-it");`
3. esbuild JS API 配置：`format:"iife"`, `globalName:"markdownit"`, `minify:true`, `define:{"process.env.NODE_ENV":'"production"'}`，输出到本目录 `markdown-it.min.js`。
4. 从 `node_modules/dompurify/dist/` 拷贝 `purify.min.js`。
5. 冒烟验证：vm 加载 bundle，确认全局 `markdownit` 为函数，渲染表格/删除线/围栏代码/链接均正确，且 `html:false` 下原始 `<script>` 被转义。

## 使用约定

- 渲染进程通过 `<script src="../vendor/...">` 同步加载。
- markdown-it 一律 `html:false`，原始 HTML 不进解析器；DOMPurify 兜底净化最终 HTML。
- 后续新增库（KaTeX、Mermaid v9 UMD 等）同样走本模式，并在此登记。
