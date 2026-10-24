# tests/manual/geomlab-verify.html

几何画板（`diagnose/geomlab.js`）的浏览器验收页。**不是自动测试**，是给人工/agent 做
「图上到底画了什么」这类断言用的 —— 因为 canvas 上的文字没法在 Node 里读取。

## 用法

```bash
# 在仓库根目录起服务（不能在 file:// 下打开，data/*.json 要 fetch）
python3 -m http.server 8123
# 打开
open http://127.0.0.1:8123/tests/manual/geomlab-verify.html
```

页面提供几个全局函数，配合 `agent-browser eval` 使用：

```bash
agent-browser eval "load().then(function(){ return boot('cnm_269_q1') })"   # 挂一道真题，返回 solve() 全量
agent-browser screenshot /path/to/shot.png                                  # 截图看画布标注
agent-browser eval "dragTo(0, -4, 0)"                                       # 把第 0 个手柄拖到世界坐标
agent-browser eval "clickCheck()"                                           # 点「我算好了」，返回对比行
```

`boot()` 返回里的 `values` 是 `solve()` 的完整输出（含 `given` 判定表），
`checkRows` 是自检面板要显示的行 —— 这两处是核对「图上该不该出现某个数」的唯一依据。

## 为什么要这个页

`tests/test_geomlab.js` 第 9 节锁的是**取值口径**（`knownText()` 题面给了才出数），
但「画布上真的渲染成了 `?`」只有截图能证明。返修前 `verify-d-similar.png` 的红字
`AD/DB ≈ 0.46 = AE/EC ≈ 0.46` 就是这类只能靠看图发现的问题。

注意：页顶那行「题库答案 X，仅验收记录用，不上画板」是验收页自己写的，不属于画板。
真实面板里第 3 步本来就会印完整解析（那是讲解文本，不是画板标注）。
