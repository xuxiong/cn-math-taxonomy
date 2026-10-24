#!/usr/bin/env node
/* LLM 匹配层（diagnose/labmatch.js）+ 能力清单自洽性测试：node tests/test_labmatch.js
 *
 * 覆盖（对应卡面验收标准 4/8）：
 *   1. 参数代回校验：正例通过、假参数（{a:99,h:9,k:9}）/ 类型不符 / 区间不符 一律拒绝
 *   2. intent 必须逐字属于该画板 canAnswer（含空白归一化、"两项拼接"、编造 intent）
 *   3. 网关失败（抛错 / 非 200 / JSON 解析失败 / 字符串 "null"）→ matchLab 返回 null 或拒绝
 *   4. 缓存：命中不再发请求；只缓存校验通过的结果
 *   5. resolve：LLM 拒绝 / 校验失败 → null；通过 → 可直接喂 Funclab.mount 的配置
 *   6. 能力清单自洽：每个 canAnswer 都有文案模板（避免「清单里有、模板查不到」的假缺失）
 *   7. intent 驱动文案分支：问最值的题绝不出现「就是方程的两个根」，问根的题必须讲交点
 *
 * 全部离线：fetch 一律注入，不访问网关。
 * 题面全部取自 data/questions.json 的真实 prompt（用 q(id) 取），不臆造。
 */
'use strict';
const assert = require('assert');
const path = require('path');

let passed = 0;
let failed = 0;
const CASES = [];
/** 登记用例；全部登记完后按顺序串行执行（缓存/存储是模块级状态，并发跑会互相覆盖） */
function test(name, fn) { CASES.push([name, fn]); }
function runAll() {
  let p = Promise.resolve();
  CASES.forEach(function (c) {
    p = p.then(function () {
      return Promise.resolve().then(c[1]).then(
        function () { passed++; console.log('  ok   ' + c[0]); },
        function (e) {
          failed++; console.log('  FAIL ' + c[0] + '\n       ' + (e && e.stack || e).split('\n').slice(0, 6).join('\n       '));
        }
      );
    });
  });
  return p.then(function () {
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  });
}

const F = require('../diagnose/funclab.js');
const L = require('../diagnose/labmatch.js');

const QUESTIONS = require('../data/questions.json');
const QMAP = new Map(QUESTIONS.map(function (x) { return [x.id, x]; }));
function q(id) {
  const item = QMAP.get(id);
  assert.ok(item, '题库里找不到题目 ' + id + '（题库改过了？请更新测试）');
  return item.prompt;
}

/* ------------------------------------------------------------ fetch 假货 */

/** 造一个返回给定 JSON 内容的响应 */
function fakeFetch(content, status) {
  const f = function () {
    f.calls++;
    return Promise.resolve({
      ok: (status || 200) < 400,
      status: status || 200,
      json: function () { return Promise.resolve({ choices: [{ message: { content: content } }] }); }
    });
  };
  f.calls = 0;
  return f;
}
/** 造一个「连接不上」的 fetch */
function deadFetch() {
  const f = function () { f.calls++; return Promise.reject(new Error('econnrefused')); };
  f.calls = 0;
  return f;
}
/** 每次调用一个新的内存存储（测试之间不串） */
function freshStore() {
  const m = {};
  return {
    get: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    set: function (k, v) { m[k] = v; },
    remove: function (k) { delete m[k]; },
    _raw: m
  };
}

const VERTEX_OK = {
  match: 'quadratic-vertex', params: { a: 2, h: -1, k: -4 }, intent: '最小值',
  reason: '题目问最小值'
};

/* ================================================================ */

console.log('\n--- 1. 参数代回校验（verifyParams） ---');

test('正例：y=2(x+1)²-4 的最小值 → a=2,h=-1,k=-4 通过', function () {
  const v = L.verifyParams(q('cnm_235_q2'), VERTEX_OK);
  assert.deepStrictEqual(v.why, []);
  assert.strictEqual(v.ok, true);
});

test('正例：一般式配方 y=-x²+4x+1 → a=-1,h=2,k=5 通过（LLM 自己完成配方也要能验）', function () {
  const v = L.verifyParams(q('cnm_235_q1'), {
    match: 'quadratic-vertex', params: { a: -1, h: 2, k: 5 }, intent: '最大值'
  });
  assert.strictEqual(v.ok, true, JSON.stringify(v.why));
});

test('正例：一般式 y=x²-6x+5 对称轴 h=3（分式/配方小数都能过）', function () {
  const v = L.verifyParams(q('cnm_232_q2'), {
    match: 'quadratic-vertex', params: { a: 1, h: 3, k: -4 }, intent: '对称轴'
  });
  assert.strictEqual(v.ok, true, JSON.stringify(v.why));
});

test('反例：LLM 编造参数 {a:99,h:9,k:9} 必须拒绝（卡面验收 4）', function () {
  const v = L.verifyParams(q('cnm_235_q2'), {
    match: 'quadratic-vertex', params: { a: 99, h: 9, k: 9 }, intent: '最小值'
  });
  assert.strictEqual(v.ok, false);
  assert.ok(/代回不符/.test(v.why.join(';')), '理由要说清是代回校验不过：' + v.why.join(';'));
});

test('反例：只错一个数（a、h 对，k 错 1）也必须拒绝', function () {
  const v = L.verifyParams(q('cnm_235_q2'), {
    match: 'quadratic-vertex', params: { a: 2, h: -1, k: -3 }, intent: '最小值'
  });
  assert.strictEqual(v.ok, false);
});

test('反例：参数缺失 / 非数值 → 拒绝', function () {
  const v1 = L.verifyParams(q('cnm_235_q2'), { match: 'quadratic-vertex', params: { a: 2, h: -1 }, intent: '最小值' });
  assert.strictEqual(v1.ok, false);
  const v2 = L.verifyParams(q('cnm_235_q2'), { match: 'quadratic-vertex', params: { a: 2, h: 'x', k: -4 }, intent: '最小值' });
  assert.strictEqual(v2.ok, false);
});

test('反例：一次函数参数不符（cnm_204_q2 平移题，LLM 按平移后的 b=3 作答）→ 拒绝', function () {
  const v = L.verifyParams(q('cnm_204_q2'), {
    match: 'linear-intercepts', params: { k: 1, b: 3 }, intent: '与 y 轴交点的纵坐标'
  });
  assert.strictEqual(v.ok, false);
  assert.ok(/代回不符/.test(v.why.join(';')), v.why.join(';'));
});

test('正例：一次函数 k=2,b=-6（cnm_202_q2）通过', function () {
  const v = L.verifyParams(q('cnm_202_q2'), {
    match: 'linear-intercepts', params: { k: 3, b: -6 }, intent: '与 x 轴交点的横坐标'
  });
  assert.strictEqual(v.ok, true, JSON.stringify(v.why));
});

test('区间最值：端点与题面一致才通过，端点错就拒绝（cnm_235_q4 当 2≤x≤4）', function () {
  const okv = L.verifyParams(q('cnm_235_q4'), {
    match: 'quadratic-range-on-interval', params: { a: 1, h: 1, k: -4, xMin: 2, xMax: 4 },
    intent: '在给定区间上的最大值'
  });
  assert.strictEqual(okv.ok, true, JSON.stringify(okv.why));
  const bad = L.verifyParams(q('cnm_235_q4'), {
    match: 'quadratic-range-on-interval', params: { a: 1, h: 1, k: -4, xMin: 0, xMax: 4 },
    intent: '在给定区间上的最大值'
  });
  assert.strictEqual(bad.ok, false);
  assert.ok(/区间不符/.test(bad.why.join(';')), bad.why.join(';'));
});

test('区间最值：题面没有区间（cnm_235_q2）时该画板一律拒绝', function () {
  const v = L.verifyParams(q('cnm_235_q2'), {
    match: 'quadratic-range-on-interval', params: { a: 2, h: -1, k: -4, xMin: 0, xMax: 1 },
    intent: '在给定区间上的最大值'
  });
  assert.strictEqual(v.ok, false);
});

test('promptInterval 能从 cnm_235_q4 抠出 [2,4]', function () {
  assert.deepStrictEqual(L.promptInterval(q('cnm_235_q4')), { xMin: 2, xMax: 4 });
  assert.strictEqual(L.promptInterval(q('cnm_235_q2')), null);
});

/* ================================================================ */

console.log('\n--- 2. 画板 / intent 白名单 ---');

test('未注册画板名（含字符串 "null"）→ 拒绝', function () {
  assert.strictEqual(L.verifyParams(q('cnm_235_q2'), { match: 'circle-lab', params: {}, intent: '最小值' }).ok, false);
  assert.strictEqual(L.verifyParams(q('cnm_235_q2'), { match: 'null', params: { a: 2, h: -1, k: -4 }, intent: '最小值' }).ok, false);
});

test('intent 不在该画板 canAnswer（把根类 intent 用在顶点画板）→ 拒绝', function () {
  const v = L.verifyParams(q('cnm_235_q2'), {
    match: 'quadratic-vertex', params: { a: 2, h: -1, k: -4 }, intent: '方程的根'
  });
  assert.strictEqual(v.ok, false);
});

test('intent 把两项拼起来（"…增大还是减小、…哪几个象限"）→ 拒绝，不猜', function () {
  const v = L.verifyParams(q('cnm_203_q1'), {
    match: 'linear-trend', params: { k: -3, b: 1 },
    intent: 'y 随 x 的增大而增大还是减小、直线经过哪几个象限'
  });
  assert.strictEqual(v.ok, false);
  assert.ok(/intent 不在/.test(v.why.join(';')), v.why.join(';'));
});

test('intent 带多余空白也要认（归一化空白后比较）', function () {
  const v = L.verifyParams(q('cnm_235_q2'), {
    match: 'quadratic-vertex', params: { a: 2, h: -1, k: -4 }, intent: ' 最小值 '
  });
  assert.strictEqual(v.ok, true, JSON.stringify(v.why));
});

test('编造的 intent（清单里没有的措辞）→ 拒绝', function () {
  const v = L.verifyParams(q('cnm_235_q2'), {
    match: 'quadratic-vertex', params: { a: 2, h: -1, k: -4 }, intent: '求最小值'
  });
  assert.strictEqual(v.ok, false);
});

/* ================================================================ */

console.log('\n--- 3. 能力清单自洽（canAnswer ↔ 文案模板 ↔ CAP_TYPE） ---');

test('每个画板的每个 canAnswer 都能生成文案（非空），且没有 CAP_TYPE 缺失', function () {
  const sample = {
    quadratic: { a: 2, h: -1, k: -4, xMin: 2, xMax: 4 },
    linear: { k: 2, b: -6 },
    inverse: { k: -8 }
  };
  Object.keys(F.CAPABILITIES).forEach(function (lab) {
    const type = F.CAP_TYPE[lab];
    assert.ok(type, '画板 ' + lab + ' 缺 CAP_TYPE');
    F.CAPABILITIES[lab].canAnswer.forEach(function (intent) {
      const s = F.noteText(lab, intent, Object.assign({}, sample[type]));
      assert.ok(s && s.length > 6, lab + ' / ' + intent + ' 文案为空');
      assert.ok(s.indexOf('undefined') < 0 && !/\{\w+\}/.test(s), lab + ' / ' + intent + ' 有未填的占位符: ' + s);
    });
  });
});

test('问顶点/最值/对称轴/开口/面积/象限的文案绝不出现「根」字（只有根类 intent 允许）', function () {
  const sample = {
    quadratic: { a: 2, h: -1, k: -4, xMin: 2, xMax: 4 },
    linear: { k: 2, b: -6 },
    inverse: { k: -8 }
  };
  /* 讲「一次函数与一元一次方程的关系」本来就是在讲「方程的根 = 交点横坐标」，允许出现「根」 */
  const ROOT_ALLOWED = F.ROOT_INTENTS.concat(['一次函数与一元一次方程的关系']);
  Object.keys(F.CAPABILITIES).forEach(function (lab) {
    const type = F.CAP_TYPE[lab];
    F.CAPABILITIES[lab].canAnswer.forEach(function (intent) {
      const s = F.noteText(lab, intent, Object.assign({}, sample[type]));
      const isRootIntent = ROOT_ALLOWED.indexOf(F.intentKey(intent)) >= 0;
      if (!isRootIntent) {
        assert.ok(s.indexOf('根') < 0, lab + ' / ' + intent + ' 出现了「根」：' + s);
      }
    });
  });
});

test('ROOT_INTENTS 里每一项都真的是某个画板的 canAnswer', function () {
  F.ROOT_INTENTS.forEach(function (intent) {
    const hit = Object.keys(F.CAPABILITIES).some(function (lab) {
      return F.capabilityIntents(lab).indexOf(intent) >= 0;
    });
    assert.ok(hit, 'ROOT_INTENTS 里的 ' + intent + ' 不属于任何画板');
  });
});

test('capabilitiesFor(type) 只给该类型的画板', function () {
  const lin = F.capabilitiesFor('linear');
  Object.keys(lin).forEach(function (lab) { assert.strictEqual(F.CAP_TYPE[lab], 'linear', lab); });
  assert.ok(!lin['quadratic-vertex']);
});

/* ================================================================ */

console.log('\n--- 4. intent 驱动文案分支（卡面 bug 的回归锁） ---');

test('cnm_235_q2（求最小值）：文案讲顶点/最小值，不出现「就是方程的两个根」', function () {
  const s = F.noteText('quadratic-vertex', '最小值', { a: 2, h: -1, k: -4 });
  assert.ok(/最小值/.test(s), s);
  assert.ok(s.indexOf('两个根') < 0, '问最值的题不能讲根：' + s);
  assert.ok(s.indexOf('-4') >= 0, '要点出最小值 -4：' + s);
});

test('求根的题仍讲「交点横坐标即根」（cnm_224_q1 解方程 x²-5x+6=0）', function () {
  const s = F.noteText('quadratic-roots', '方程的根', { a: 1, h: 2.5, k: -0.25 });
  assert.ok(/交点/.test(s) && /根/.test(s), s);
});

test('intentUsesRoots：最值/顶点 False，根/零点 True', function () {
  assert.strictEqual(F.intentUsesRoots('最小值'), false);
  assert.strictEqual(F.intentUsesRoots('顶点坐标'), false);
  assert.strictEqual(F.intentUsesRoots('方程的根'), true);
  assert.strictEqual(F.intentUsesRoots('零点'), true);
  assert.strictEqual(F.intentUsesRoots(''), false);
});

test('intent 缺失 → noteText 返回 null（调用方据此不挂图）', function () {
  assert.strictEqual(F.noteText('quadratic-vertex', null, { a: 1, h: 0, k: 0 }), null);
  assert.strictEqual(F.noteText('quadratic-vertex', '', { a: 1, h: 0, k: 0 }), null);
  assert.strictEqual(F.intentSupported('quadratic-vertex', null), false);
});

/* ================================================================ */

console.log('\n--- 5. matchLab：网关失败一律返回 null（不抛到 UI） ---');

test('连接失败（econnrefused）→ null', function () {
  L.setStore(freshStore());
  return L.matchLab(q('cnm_235_q2'), F.CAPABILITIES, { itemId: 't-dead', fetchImpl: deadFetch(), retries: 1 })
    .then(function (r) { assert.strictEqual(r, null); });
});

test('非 200（HTTP 500）→ null', function () {
  L.setStore(freshStore());
  return L.matchLab(q('cnm_235_q2'), F.CAPABILITIES, { itemId: 't-500', fetchImpl: fakeFetch('boom', 500), retries: 0 })
    .then(function (r) { assert.strictEqual(r, null); });
});

test('内容不是 JSON（模型废话 / 被截断）→ null', function () {
  L.setStore(freshStore());
  return L.matchLab(q('cnm_235_q2'), F.CAPABILITIES, { itemId: 't-garbage', fetchImpl: fakeFetch('我觉得应该挂顶点画板'), retries: 0 })
    .then(function (r) { assert.strictEqual(r, null); });
});

test('模型把「不挂」写成字符串 "null" → 当作拒绝（不是画板名）', function () {
  L.setStore(freshStore());
  const f = fakeFetch('{"match":"null","params":{},"intent":"","reason":"清单里没有"}');
  return L.matchLab(q('cnm_208_q1'), F.CAPABILITIES, { itemId: 't-nullstr', fetchImpl: f, retries: 0 })
    .then(function (r) {
      assert.ok(r, '应当是「拒绝」对象而不是 null（调用失败）');
      assert.strictEqual(r.match, null);
      assert.strictEqual(r.from, 'llm');
    });
});

test('请求体契约：temperature=0、max_tokens>=1200、system 要求只输出 JSON', function () {
  L.setStore(freshStore());
  let seen = null;
  const f = function (url, init) {
    seen = { url: url, body: JSON.parse(init.body) };
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve({ choices: [{ message: { content: JSON.stringify(VERTEX_OK) } }] }); }
    });
  };
  return L.matchLab(q('cnm_235_q2'), F.CAPABILITIES, { itemId: 't-body', fetchImpl: f, retries: 0 })
    .then(function () {
      assert.ok(seen, '没有发出请求');
      assert.ok(/\/v1\/chat\/completions$/.test(seen.url), seen.url);
      assert.strictEqual(seen.body.temperature, 0);
      assert.ok(seen.body.max_tokens >= 1200, 'max_tokens 太小会截断 JSON：' + seen.body.max_tokens);
      assert.ok(/只输出 JSON/.test(seen.body.messages[0].content));
      assert.ok(/canAnswer/.test(seen.body.messages[0].content));
      assert.ok(seen.body.messages[1].content.indexOf('可用画板') >= 0);
      assert.ok(seen.body.messages[1].content.indexOf(q('cnm_235_q2')) >= 0, '题面没进 prompt');
    });
});

test('LLM 返回被验证不过的参数 → 结果带 verified=false，不缓存', function () {
  L.setStore(freshStore());
  const f = fakeFetch('{"match":"quadratic-vertex","params":{"a":99,"h":9,"k":9},"intent":"最小值","reason":"瞎猜"}');
  return L.matchLab(q('cnm_235_q2'), F.CAPABILITIES, { itemId: 't-fake', fetchImpl: f, retries: 0 })
    .then(function (r) {
      assert.ok(r);
      assert.strictEqual(r.match, 'quadratic-vertex');
      assert.strictEqual(r.verified, false);
      assert.strictEqual(f.calls, 1);
      return L.matchLab(q('cnm_235_q2'), F.CAPABILITIES, { itemId: 't-fake', fetchImpl: f, retries: 0 });
    })
    .then(function (r2) {
      assert.strictEqual(f.calls, 2, '校验失败的结果不能被缓存（否则永远无图）');
      assert.strictEqual(r2.verified, false);
    });
});

/* ================================================================ */

console.log('\n--- 6. 缓存：命中不发请求，且只缓存成功 ---');

test('第一次发请求，第二次命中缓存不再发；from=cache', function () {
  L.setStore(freshStore());
  const f = fakeFetch(JSON.stringify(VERTEX_OK));
  return L.matchLab(q('cnm_235_q2'), F.CAPABILITIES, { itemId: 'cnm_235_q2', fetchImpl: f, retries: 0 })
    .then(function (r1) {
      assert.strictEqual(r1.verified, true, JSON.stringify(r1.why));
      assert.strictEqual(r1.from, 'llm');
      assert.strictEqual(f.calls, 1);
      return L.matchLab(q('cnm_235_q2'), F.CAPABILITIES, { itemId: 'cnm_235_q2', fetchImpl: f, retries: 0 });
    })
    .then(function (r2) {
      assert.strictEqual(f.calls, 1, '第二次渲染不能再发请求');
      assert.strictEqual(r2.from, 'cache');
      assert.strictEqual(r2.match, 'quadratic-vertex');
      assert.strictEqual(r2.intent, '最小值');
      assert.deepStrictEqual(r2.params, { a: 2, h: -1, k: -4 });
    });
});

test('缓存条目结构损坏（缺 intent / 参数非数值 / 非对象）→ 忽略，重新请求', function () {
  const s = freshStore();
  s.set(L.CACHE_KEY, {
    'cnm_235_q2': { match: 'quadratic-vertex', params: { a: 2, h: -1, k: -4 } },   // 缺 intent
    'xxx': 'not-an-object'
  });
  L.setStore(s);
  const f = fakeFetch(JSON.stringify(VERTEX_OK));
  return L.matchLab(q('cnm_235_q2'), F.CAPABILITIES, { itemId: 'cnm_235_q2', fetchImpl: f, retries: 0 })
    .then(function (r) {
      assert.strictEqual(f.calls, 1, '损坏的缓存应被忽略并重新请求');
      assert.strictEqual(r.from, 'llm');
    });
});

test('缓存里躺着已下线画板（linear-shift）→ 重新校验后丢弃，并发真实请求', function () {
  const s = freshStore();
  /* 旧版本缓存：画板后来被下线（平移题画板只会画出平移前的直线，已删） */
  s.set(L.CACHE_KEY, {
    'cnm_204_q2': { match: 'linear-shift', params: { k: 1, b: 3 }, intent: '平移后直线与坐标轴交点的坐标', at: 1 }
  });
  L.setStore(s);
  const f = fakeFetch('{"match":null,"params":{},"intent":"","reason":"清单里没有能回答这个问题的画板"}');
  return L.matchLab(q('cnm_204_q2'), F.CAPABILITIES, { itemId: 'cnm_204_q2', fetchImpl: f, retries: 0 })
    .then(function (r) {
      assert.strictEqual(f.calls, 1, '过期缓存必须被丢弃并发真实请求');
      assert.strictEqual(r.match, null);
      assert.ok(!s._raw[L.CACHE_KEY] || !s._raw[L.CACHE_KEY]['cnm_204_q2'], '过期条目应被删掉');
    });
});

test('validEntry 结构校验：合法/非法各一例', function () {
  assert.strictEqual(L.validEntry({ match: 'quadratic-vertex', params: { a: 1, h: 0, k: 0 }, intent: '顶点坐标' }), true);
  assert.strictEqual(L.validEntry({ match: '', params: { a: 1 }, intent: '顶点坐标' }), false);
  assert.strictEqual(L.validEntry({ match: 'quadratic-vertex', params: { a: 'x' }, intent: '顶点坐标' }), false);
  assert.strictEqual(L.validEntry(null), false);
});

/* ================================================================ */

console.log('\n--- 7. resolve：LLM 决策 → 挂载配置（mount 的入参契约） ---');

test('候选 + LLM 通过 → 返回可喂 mount 的配置（type/lab/intent/a,h,k/base）', function () {
  L.setStore(freshStore());
  const prompt = q('cnm_235_q2');
  const cand = F.labForScene('cnm_235', prompt, { itemId: 'cnm_235_q2' });
  assert.ok(cand, '候选为空，测试前提不成立');
  const f = fakeFetch(JSON.stringify(VERTEX_OK));
  return L.resolve({ prompt: prompt, lab: cand, itemId: 'cnm_235_q2' }, { fetchImpl: f, retries: 0 })
    .then(function (cfg) {
      assert.ok(cfg, 'resolve 应给出配置');
      assert.strictEqual(cfg.type, 'quadratic');
      assert.strictEqual(cfg.lab, 'quadratic-vertex');
      assert.strictEqual(cfg.intent, '最小值');
      assert.strictEqual(cfg.a, 2); assert.strictEqual(cfg.h, -1); assert.strictEqual(cfg.k, -4);
      assert.ok(cfg.base, 'base（原曲线）应当保留');
      // mount 的入参契约：intentSupported 必须通过（DOM 之外能验的部分）
      assert.strictEqual(F.intentSupported(cfg.lab, cfg.intent), true);
      assert.ok(F.noteText(cfg.lab, cfg.intent, cfg).indexOf('最小值') >= 0);
    });
});

test('LLM 拒绝 → resolve 返回 null（不挂图，不回退旧逻辑）', function () {
  L.setStore(freshStore());
  const prompt = q('cnm_208_q1');   // 两直线交点：清单里没有能回答的画板
  const cand = F.labForScene('cnm_208', prompt, { itemId: 'cnm_208_q1' });
  const f = fakeFetch('{"match":null,"params":{},"intent":"","reason":"清单里没有能回答这个问题的画板"}');
  return L.resolve({ prompt: prompt, lab: cand, itemId: 'cnm_208_q1' }, { fetchImpl: f, retries: 0 })
    .then(function (cfg) { assert.strictEqual(cfg, null); });
});

test('LLM 给了假参数 → resolve 返回 null（不挂图）', function () {
  L.setStore(freshStore());
  const prompt = q('cnm_235_q2');
  const cand = F.labForScene('cnm_235', prompt, { itemId: 'cnm_235_q2' });
  const f = fakeFetch('{"match":"quadratic-vertex","params":{"a":99,"h":9,"k":9},"intent":"最小值"}');
  return L.resolve({ prompt: prompt, lab: cand, itemId: 'x-fake' }, { fetchImpl: f, retries: 0 })
    .then(function (cfg) { assert.strictEqual(cfg, null); });
});

test('网关挂掉 → resolve 返回 null，且不抛异常（卡面验收 3 的单测版）', function () {
  L.setStore(freshStore());
  const prompt = q('cnm_235_q2');
  const cand = F.labForScene('cnm_235', prompt, { itemId: 'cnm_235_q2' });
  return L.resolve({ prompt: prompt, lab: cand, itemId: 'y-dead' }, { fetchImpl: deadFetch(), retries: 0 })
    .then(function (cfg) { assert.strictEqual(cfg, null); });
});

test('没有候选画板（几何题）→ 直接 null，不浪费一次 LLM 调用', function () {
  L.setStore(freshStore());
  const f = fakeFetch(JSON.stringify(VERTEX_OK));
  return L.resolve({ prompt: '在△ABC中，AB=AC，求角B。', lab: null, itemId: 'geo' }, { fetchImpl: f, retries: 0 })
    .then(function (cfg) {
      assert.strictEqual(cfg, null);
      assert.strictEqual(f.calls, 0);
    });
});

/* ================================================================ */

runAll();
