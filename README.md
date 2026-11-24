# MDReader

离线优先的 Windows x64 本地 Markdown 阅读器。

为「无网络、无 Node、无 Python」的办公环境设计：产物解压即用，运行时零 npm 依赖、零网络请求，视觉与交互对齐 Typora。

- **版本**：1.0.1
- **运行时**：Electron 22.3.27
- **目标平台**：Windows x64

---

## 特性

### 阅读

| 能力 | 说明 |
|---|---|
| Markdown 渲染 | markdown-it 14（`html:false`）+ DOMPurify 兜底净化，原始 HTML 不进入解析器 |
| 代码高亮 | highlight.js 11，按需注册 23 种语言 |
| 数学公式 | KaTeX 0.16 + markdown-it-texmath，`$...$` / `$$...$$` |
| 流程图 / 时序图 | Mermaid 9.4，**仅当文档含 ` ```mermaid ` 代码块时才懒加载** |
| 任务列表 | `- [x]` 渲染为复选框 |
| 图片 | 支持相对路径（以文档所在目录为基准）与 SVG |
| 文本编码 | 自动探测：UTF-8（含 BOM）/ UTF-16LE / UTF-16BE / GBK（GB18030 回退）。旧文档常见的「记事本另存为 ANSI」可直接打开，非 UTF-8 时提示一次所用编码 |
| 链接 | 正文内相对链接在应用内打开（同文件聚焦已有标签页）；`[x](#标题)` 页内锚点跳转（按标题文字匹配，兼容 GitHub 风格写法）；外链与外部文件复制到剪贴板并提示 |
| 主题 | 亮色 / 暗色 / 跟随系统，三态循环；标题栏同步联动 |

### 使用

- **多标签页**：DOM 常驻 + LRU 淘汰（上限 10 个），切页零重解析
- **大纲侧栏**：标题树导航，可收起
- **文档内查找**：`Ctrl+F`，带命中计数、上一个/下一个、区分大小写
- **最近文件**：`···` 菜单内，可清空
- **会话恢复**：重启后还原标签页与滚动位置
- **外部修改检测**：聚焦标签页时比对 `mtime + size`，变化则提示可重新加载（不用 `fs.watch`，无空闲开销）
- **拖拽打开**：把 `.md` 文件拖入窗口即可
- **字号缩放**：工具栏 0.6×–2.0× 调节，可一键重置，**偏好跨启动保留**。缩放时版心宽度与字号**等比整体放大**（每行字数不变），顶满窗口可用宽度后版心封顶、只继续放大字号（重新折行）
- **设置默认打开方式**：写入 HKCU ProgID + RegisteredApplications，一键把 `.md` 关联到本应用（Win8+ 不允许静默抢占，已有关联时会拉起系统确认框）

### 三项针对性设计

**1. 无边框一体化窗口。** 自绘标题栏（同色、可拖拽、文件名 + 窗控按钮）+ Typora 风格工具栏；原生菜单栏彻底隐藏（`setMenuBarVisibility(false)`，Alt 也不呼出），所有操作走工具栏与 `···` 菜单，但菜单加速键（`Ctrl+O` 等）仍全局生效。

**2. 应用内自绘对话框。** 关闭询问、默认打开方式确认、打开失败提示全部由渲染层自绘，样式随明暗主题，不使用 Electron 原生 `dialog`——原生弹窗与无边框窗口风格割裂。唯一例外是 `Ctrl+O` 的系统文件选择器（OS 组件，无法定制）。

**3. 原生快速启动器（`MDReaderLauncher.exe`）。** 双击 `.md` 时被创建的进程是它而不是 150MB 的 `MDReader.exe`，它把文件路径经命名管道交给常驻实例后立即退出。

> **为什么需要这个 15KB 的小程序？** 安全软件会在进程创建**之前**同步扫描映像，扫描耗时与映像体积正相关（150MB 映像约 3s、200KB 约 1.5s）——这段开销发生在我们自己的代码跑起来之前，任何应用内打点都测不到，只能通过「缩小被创建的映像」绕开。实测把 `procBootMs` 从 ~350ms（150MB）降到 54–170ms，稳定在 ~50ms，双击 `.md` 从体感 4s 降到接近即时。
>
> 启动器连不上管道时（未常驻），会回退为直接拉起 `MDReader.exe` 并透传路径，行为与没有它时一致。产物与源码一并入库，**打包机不需要 C 工具链**。

---

## 快速开始

开发机需联网（仅用于一次性安装 Electron 与 electron-packager）。

```powershell
pnpm install
pnpm start
```

提交前静态检查：

```powershell
Get-ChildItem -Path src -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
```

> 阅读器必须用 `pnpm start` 打开真实应用验收——浏览器无法覆盖 IPC、文件访问与安全边界。验收语料见 `samples/`。

---

## 打包与部署

```powershell
pnpm run build:launcher   # 仅在改动 native/launcher/launcher.c 后需要执行
pnpm run pack             # 产出 dist/MDReader-win32-x64/
```

打包使用 electron-packager（`--no-asar`），并排除 `node_modules`（源码只 `require` 内置模块）、`native`、`tools`、`dist`、`.git`、`.workbuddy`。`tools/postpack.js` 会把 `MDReaderLauncher.exe` 拷到 dist 根目录，与 `MDReader.exe` 同级——**启动器靠「自身所在目录」推算应用路径，这个同级关系不能破坏**。

部署就是把 dist 目录（或 `MDReader-1.0.1-win32-x64.zip`）拷到目标电脑解压后直接运行，无需安装任何运行时。例如解压到 `C:\Apps\mdreader\`，进入后双击 `MDReader.exe` 启动，再用 `···` 菜单里的「设为默认打开方式 (.md)」建立文件关联。

`src/main/app.js` 中的关联命令会写入 `process.execPath`（或启动器路径）的**绝对路径**，因此部署后若移动了目录，需重新执行一次「设为默认打开方式」。

---

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+O` | 打开文档 |
| `Ctrl+F` | 文档内查找 |
| `Ctrl+N` / `Ctrl+P` | 查找下一个 / 上一个 |
| `Ctrl+W` | 关闭当前标签页 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 下一个 / 上一个标签页 |
| `Esc` | 关闭查找栏 / 取消对话框 |
| `Alt` | **不**呼出菜单（菜单已彻底隐藏） |

关闭窗口时的行为（每次询问 / 最小化到托盘 / 完全退出）在 `···` 菜单中设置，存于 `userData/mdreader-prefs.json`，首次询问时可勾选记住。托盘常驻**不做开机自启**。

---

## 目录结构

```
src/main/app.js          主进程：窗口生命周期、托盘、菜单与加速键、IPC、
                         命名管道服务端、默认打开方式注册、偏好持久化
src/preload/api.js       仅暴露最小 window.api（contextBridge）
src/renderer/            渲染层：标题栏/工具栏/标签页/大纲/查找栏/模态框 + 主题
  ├─ index.html          界面骨架
  ├─ theme.css           设计令牌（CSS 变量 + data-theme 明暗两套）
  ├─ theme-init.js       样式应用前预置主题，避免暗色用户启动白闪
  └─ viewer.js           解析渲染、标签页与 LRU、会话、变更检测、查找
native/launcher/         C 源码 + 编译产物（随包分发）
tools/                   构建期脚本：build-launcher.js / postpack.js
vendor/                  离线单文件第三方库（含 VENDOR.md 版本与来源登记）
samples/                 离线验收样例；full-test.md 为标准回归文档，
                         ansi-gbk-sample.md 是 GBK 编码夹具（二进制层面，勿用 UTF-8 工具覆写）
assets/icons/            应用图标与托盘图标
```

---

## 技术约定

| 项 | 约定 |
|---|---|
| 依赖 | 运行时**零 npm 依赖**；开发依赖仅 `electron` 与 `electron-packager` |
| 语言 | 原生 JavaScript（CommonJS）、HTML、CSS；不引入框架、构建步骤、TypeScript |
| 安全 | `contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`；CSP 限制脚本与资源来源；preload 只暴露最小 `window.api` |
| 渲染安全 | markdown-it `html:false` + DOMPurify 净化；默认禁止加载远程资源，本地资源只在已打开文档目录内解析 |
| 第三方库 | 一律以单文件形式放 `vendor/` 并登记版本与来源（见 `vendor/VENDOR.md`），**禁止运行时从网络加载** |
| 原生件 | 需要原生小工具时用 **C + MinGW-w64** 编译（`-Os -s -static -mwindows`），源码与产物一并入库 |
| 打包 | electron-packager `--no-asar`，剔除 `node_modules` |
| 版本号 | 开发期 0.`M`.`f`（M = 里程碑号），真机验收后定 1.0.0；此后按语义化递增（1.0.x 修复批次 / 1.1.0 功能批次） |
| 提交 | Conventional Commits 简化版（`feat`/`fix`/`chore`/`docs` + 中文描述），每子任务一 commit |
| 样例同步 | **每新增一种内容支持，必须同步更新 `samples/full-test.md`**——它是标准回归验收文档 |

### 离线库清单

| 库 | 版本 | 许可证 |
|---|---|---|
| markdown-it | 14.3.2 | MIT |
| DOMPurify | 3.4.15 | Apache-2.0 / MPL-2.0 |
| highlight.js | 11.12.0 | BSD-3-Clause |
| KaTeX / markdown-it-texmath | 0.16.47 / 1.0.0 | MIT |
| Mermaid | 9.4.3 | MIT |
| markdown-it-task-lists | 2.1.1 | MIT |

版本来源与重建步骤详见 `vendor/VENDOR.md`。

---

## 已知限制

- 仅支持 Windows x64（在 Windows 10 上验证）。
- `--no-asar` 打包导致 `resources/app/` 为 86 个散文件，渲染进程冷启时可能被安全软件逐个扫描；这是有意的取舍（便于离线排查与替换单个文件），后续可试验 asar 打包对比。
- 冷启动（开机后首次）仍受安全软件扫描的外部常数影响，约 3.5s 无法从应用侧消除；托盘常驻与快速启动器可以把**后续**双击降到接近即时。
- 默认打开方式无法静默设置——Win8+ 起系统不允许程序抢占 `UserChoice`，必须经用户确认。
- `.txt` 仅出现在打开对话框的过滤器里，**不参与文件关联注册**，避免误伤记事本的使用习惯。
- 编码探测只回退到 GB18030（覆盖 GBK / GB2312）。Big5、Shift_JIS 等其它非 UTF-8 编码仍会显示乱码——中文环境不做更多猜测，避免误判把正常文件读坏。
- 外链不打开只复制。离线环境点击外链必然失败，复制出去再贴到能上网的机器是唯一可行路径。正文内链接的点击行为由此完全接管（主进程另有 `will-navigate` 兜底），窗口不会被导航顶掉。
