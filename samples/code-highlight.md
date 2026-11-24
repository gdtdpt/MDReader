# 代码高亮验收样例

用于验证 M2-1 代码高亮（highlight.js，GitHub Light 配色）。

## JavaScript

```javascript
// 关键字、字符串、注释、模板串
const fetchUser = async (id) => {
  const res = await fetch(`/api/users/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};
```

## Python

```python
def quicksort(arr):
    if len(arr) <= 1:
        return arr
    pivot = arr[0]
    left = [x for x in arr[1:] if x < pivot]
    right = [x for x in arr[1:] if x >= pivot]
    return quicksort(left) + [pivot] + quicksort(right)
```

## CSS

```css
.container {
  display: flex;
  gap: 12px; /* 布局间距 */
}
.container > .item {
  color: #0969da;
}
```

## JSON 与 YAML

```json
{
  "name": "mdreader",
  "version": "0.1.0",
  "offline": true
}
```

```yaml
targets:
  - win10-x64
  - offline
```

## Diff

```diff
- frame: false
+ frame: false  // Typora 一体化标题栏
+ toolbar: added
```

## 未注册语言（应安全降级为普通转义）

```brainfuck
++++++++[>++++++++<-]>+.
```

## 无语言标注（默认转义）

```
plain <b>text</b> block —— 应原样显示，不执行 HTML
```
