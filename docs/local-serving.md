# 本地预览 / 验收：用 `scripts/serve.js`，不要用 `python3 -m http.server`

## 一句话

```bash
node scripts/serve.js          # 端口 8920，服务仓库根目录
node scripts/serve.js 8930     # 换端口
node scripts/serve.js 8930 docs  # 只服务某个子目录
# 浏览器打开 http://localhost:<port>/diagnose/（页面里另有 /、/explore/）
```

启动时会打印两行关键信息：可访问的 `http://localhost:<port>/diagnose/`，以及「已禁缓存」。

## 为什么不能再用 `python3 -m http.server`

这个项目是纯静态站点，所有页面靠 `fetch` 读 `data/*.json`，本地只能起一个静态服务器。
以前的写法是 `python3 -m http.server 8000`。它**不发送任何缓存指令**（没有 `Cache-Control`、
没有 `ETag`、没有 `Last-Modified`），Chrome 于是按 HTTP 规范的启发式规则自行决定缓存时长，
把 `diagnose/app.js` 这种几小时不动的资源当成「可以一直用」。

于是出现了一组非常容易误判的现象：

| 观察点 | 看到的结果 |
|---|---|
| `curl http://localhost:PORT/diagnose/app.js` | **新**代码（含 `explain-fold`） |
| 浏览器里 `fetch('/diagnose/app.js')` | 也拿到**新**代码（84217 字节，含 `explain-fold`） |
| 页面实际执行的代码 | **旧**代码（渲染 `<div class="explain">` 而不是 `<details class="explain-fold">`） |
| `performance.getEntriesByType('resource')` | `transferSize: 0` ← 命中磁盘缓存 |

也就是说：服务端没问题、网络没问题、磁盘上的文件是新的，唯独**脚本标签那次加载**用了缓存副本。
排查时很容易一路怀疑 DOM、Service Worker、构建产物，实际根因只有一个——服务器没告诉浏览器别缓存。

同样的坑对验收者的杀伤力最大：看到的是几小时前的旧版本，结论自然是「这功能没做」。

## `scripts/serve.js` 做了什么

零依赖，只用 Node 标准库（`http` / `fs` / `path` / `url`），和仓库里其他脚本一样 `node scripts/xxx.js` 直接跑。

1. **禁缓存**：响应头固定带
   ```
   Cache-Control: no-store, no-cache, must-revalidate, max-age=0
   Pragma: no-cache
   Expires: 0
   ```
   `.js/.mjs/.css/.html/.htm/.json/.map` 是硬要求；图片、字体等也跟随同一策略（开发服务不需要磁盘缓存，简单优先）。
   HEAD 与 GET 的头完全一致。
2. **正确的 Content-Type**：`.html .htm .js .mjs .css .json .map .md .txt .svg .png .jpg .jpeg .gif .webp .ico .woff .woff2 .ttf .pdf .wasm`。
   `.js` 是 `text/javascript; charset=utf-8` —— 写成别的类型 ES module 会被浏览器拒绝执行。
3. **目录索引**：以 `/` 结尾的路径（如 `/diagnose/`）返回该目录下的 `index.html`；目录不带斜杠时 301 到带斜杠的地址。
4. **路径安全**：**先** `decodeURIComponent` **再** `path.resolve`，解析结果必须等于根目录或以 `根目录 + 路径分隔符` 开头，否则 403。
   顺序不能反——先判越界再解码，`%2e%2e` 就能绕过。非法 URL 编码返回 400，不抛异常。
5. **404 / 500**：文件不存在返回 404 纯文本，读失败返回 500，进程不退出。
6. **端口占用**：打印含端口号的错误（并给出换端口的建议）后以 1 退出，不打崩溃栈。
   监听地址固定 `127.0.0.1`：省略 host 时 Node 会按 `getaddrinfo` 顺序（本机 `localhost` 先解析到 `::1`）做双栈重试，
   端口被占时可能「绑上了却永不回回调」，静默挂住——显式给地址才能一次成败、错误立刻可见。

## 测试

```bash
node tests/test_serve.js      # 输出 N passed, 0 failed
```

测试自建临时目录与临时端口（不依赖仓库里业务文件的内容，也不联网），覆盖：禁缓存头、`Pragma`/`Expires`、
GET/HEAD 头一致、六个代码/数据扩展名的 `no-store`、目录索引、目录无斜杠 301、404 纯文本、
十个扩展名的 Content-Type、明文 `../` 与 `%2e%2e` 两种穿越写法、越界判定函数本身、
非法编码 400、POST 405、错误请求后服务仍可用、端口占用（子进程实测退码与提示）、以及真实 `diagnose/` 的一次端到端请求。

## 如果已经中了旧缓存

换成 `scripts/serve.js` 并**硬刷新**一次（macOS：`Cmd + Shift + R`），或者在 DevTools → Application → Storage 里清掉该站点的缓存。
换端口也是个快捷办法（不同端口的缓存分开存）。
