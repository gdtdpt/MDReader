# 相对路径图片验收样例

验证 M2-2：图片相对路径按**本文档所在目录**解析（`samples/`），与渲染基址无关。

## 正常情况

1. `./img/logo.svg`（带 ./ 前缀）：

![logo](./img/logo.svg)

2. `img/logo.svg`（不带前缀）：

![logo](img/logo.svg)

3. `../samples/img/logo.svg`（含 .. 回溯折叠）：

![logo](../samples/img/logo.svg)

4. 中文与空格文件名 `./img/中文 图片.svg`（路径含空格须用尖括号包裹，CommonMark 规范）：

![中文文件名](<./img/中文 图片.svg>)

## 异常情况

5. 不存在的文件 `./img/missing.png`（应显示裂图占位，不影响其他内容）：

![missing](./img/missing.png)

6. 远程图片 `https://...`（CSP 拦截，内网脱机预期行为）：

![remote](https://example.com/remote.png)

以上 1–4 应显示图片，5–6 显示裂图但**不得报错、不得影响后续渲染**。
