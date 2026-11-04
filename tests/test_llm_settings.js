#!/usr/bin/env node
/* 直连百炼的设置层测试：node tests/test_llm_settings.js
 *
 * 纯 Node、无浏览器、不联网：自己塞一个假 localStorage，靠删除 require.cache
 * 重新加载 diagnose/llm-config.js，覆盖「保存 → 刷新生效 / 坏配置回退 / 清除」
 * 以及设置页与请求点的静态安全约束。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 5).join('\n       ')); }
}

/* 异步用例通道：同步用例仍按原样立即执行并计数；异步用例排入队列，文件末尾统一顺序跑完，
 * 每条用 `  ok   <name>` / `  FAIL <name>` 输出（与同步用例同格式），最后合并打印总数。
 * 不破坏现有同步用例的计数与输出格式（卡 TASK-fix403 第 4b 项硬约束）。 */
const asyncTests = [];
function asyncTest(name, fn) { asyncTests.push({ name: name, fn: fn }); }

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'diagnose', 'llm-config.js');
const STORE_KEY = 'cnmDiagnose.llm';
const LEGACY_KEY = 'cnmDiagnose.llmBase';

function makeStorage(initial) {
  const map = Object.assign({}, initial || {});
  return {
    getItem: function (k) {
      return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
    },
    setItem: function (k, v) { map[k] = String(v); },
    removeItem: function (k) { delete map[k]; },
    _map: map
  };
}

function loadFresh() {
  delete require.cache[require.resolve(CONFIG_PATH)];
  return require(CONFIG_PATH);
}

/** 每个用例独立的 localStorage；结束后恢复原样（Node 默认没有）。 */
function withStorage(fn, initial) {
  const had = Object.prototype.hasOwnProperty.call(global, 'localStorage');
  const prev = global.localStorage;
  global.localStorage = makeStorage(initial);
  try { return fn(); }
  finally {
    if (had) global.localStorage = prev;
    else delete global.localStorage;
  }
}

const PRESET = {
  label: '阿里云百炼',
  base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen3.8-flash',
  altModels: ['qwen3.8-flash', 'qwen3.8-27b']
};
const DEFAULT_MODEL = 'DeepSeek-V4.1-Flash-1017-Unlimited';

/* ================================================================
 * 1. 预设表
 * ================================================================ */

console.log('\n--- 预设表 ---');

test('PRESETS 只有百炼一个预设，字段与约定一致', () => {
  delete global.localStorage;
  const cfg = loadFresh();
  const keys = Object.keys(cfg.PRESETS);
  assert.deepStrictEqual(keys, ['dashscope']);
  const p = cfg.PRESETS.dashscope;
  assert.strictEqual(p.label, PRESET.label);
  assert.strictEqual(p.base, PRESET.base);
  assert.strictEqual(p.model, PRESET.model);
  assert.deepStrictEqual(p.altModels, PRESET.altModels);
});

test('未配置时 model 保持默认型号，resolveBase 走 Node 默认地址', () => {
  delete global.localStorage;
  const cfg = loadFresh();
  assert.strictEqual(cfg.model, DEFAULT_MODEL);
  assert.strictEqual(cfg.isConfigured(), false);
  assert.strictEqual(cfg.resolveBase(), cfg.upstream + '/v1');
  assert.deepStrictEqual(cfg.authHeaders(), {});
});

/* ================================================================
 * 2. 保存 → 刷新生效
 * ================================================================ */

console.log('\n--- 保存与刷新 ---');

test('saveConfig 只给 key 时 base/model 取预设，重新加载后 model/base 生效', () => {
  withStorage(function () {
    const cfg = loadFresh();
    assert.strictEqual(cfg.saveConfig({ key: 'sk-ws-0123456789HGpY' }), true);
    assert.strictEqual(cfg.isConfigured(), true);
    assert.deepStrictEqual(cfg.getConfig(), {
      base: PRESET.base,
      model: PRESET.model,
      key: 'sk-ws-0123456789HGpY'
    });

    const cfg2 = loadFresh();
    assert.strictEqual(cfg2.model, PRESET.model);
    assert.strictEqual(cfg2.isConfigured(), true);
    assert.strictEqual(cfg2.resolveBase(), PRESET.base);
    assert.notStrictEqual(cfg2.resolveBase().slice(-1), '/');
  });
});

test('saveConfig 写入的 base 末尾斜杠会被去掉', () => {
  withStorage(function () {
    const cfg = loadFresh();
    cfg.saveConfig({ base: 'https://example.test/v1///', model: 'm1', key: 'k' });
    assert.strictEqual(cfg.getConfig().base, 'https://example.test/v1');
    assert.strictEqual(cfg.resolveBase(), 'https://example.test/v1');
  });
});

test('?llm= 查询参数优先于已保存配置', () => {
  withStorage(function () {
    const cfg = loadFresh();
    cfg.saveConfig({ base: 'https://saved.test/v1', model: 'm', key: 'k' });
    const hadLoc = Object.prototype.hasOwnProperty.call(global, 'location');
    const prevLoc = global.location;
    global.location = { search: '?llm=' + encodeURIComponent('https://query.test/v1/') };
    try {
      assert.strictEqual(cfg.resolveBase(), 'https://query.test/v1');
    } finally {
      if (hadLoc) global.location = prevLoc;
      else delete global.location;
    }
  });
});

/* ================================================================
 * 3. 鉴权头
 * ================================================================ */

console.log('\n--- authHeaders ---');

test('有 key 返回 Bearer，无 key 返回 {}', () => {
  withStorage(function () {
    const cfg = loadFresh();
    assert.deepStrictEqual(cfg.authHeaders(), {});
    cfg.saveConfig({ key: 'sk-abc' });
    assert.deepStrictEqual(cfg.authHeaders(), { Authorization: 'Bearer sk-abc' });
  });
});

test('没有 localStorage（Node / 隐私模式）时 authHeaders 返回 {} 且不抛', () => {
  delete global.localStorage;
  const cfg = loadFresh();
  assert.deepStrictEqual(cfg.authHeaders(), {});
  assert.strictEqual(cfg.isConfigured(), false);
});

/* ================================================================
 * 4. 脱敏
 * ================================================================ */

console.log('\n--- maskKey ---');

test('maskKey 只露前 5 后 4，中间段不出现', () => {
  delete global.localStorage;
  const cfg = loadFresh();
  const out = cfg.maskKey('sk-ws-0123456789HGpY');
  assert.strictEqual(out, 'sk-ws...HGpY');
  assert.ok(out.indexOf('HGpY') !== -1);
  assert.ok(out.indexOf('0123456789') === -1);
});

test('maskKey 对空串与过短 key 返回空串', () => {
  delete global.localStorage;
  const cfg = loadFresh();
  assert.strictEqual(cfg.maskKey(''), '');
  assert.strictEqual(cfg.maskKey(null), '');
  assert.strictEqual(cfg.maskKey('sk-short'), '');
  assert.strictEqual(cfg.maskKey('12345678901'), '');
});

/* ================================================================
 * 5. 坏配置回退
 * ================================================================ */

console.log('\n--- 坏配置回退 ---');

test('非法 JSON 当作未配置，resolveBase 回退到旧键 cnmDiagnose.llmBase', () => {
  withStorage(function () {
    const cfg = loadFresh();
    localStorage.setItem(STORE_KEY, '{not json');
    localStorage.setItem(LEGACY_KEY, 'https://legacy.test/v1/');
    assert.strictEqual(cfg.getConfig(), null);
    assert.strictEqual(cfg.isConfigured(), false);
    assert.strictEqual(cfg.resolveBase(), 'https://legacy.test/v1');
    assert.strictEqual(cfg.model, DEFAULT_MODEL);
  });
});

test('只有 base 的残缺配置当作未配置，回退旧键，再删旧键回默认', () => {
  withStorage(function () {
    localStorage.setItem(STORE_KEY, JSON.stringify({ base: 'https://partial.test/v1' }));
    localStorage.setItem(LEGACY_KEY, 'https://legacy.test/v1');
    const cfg = loadFresh();
    assert.strictEqual(cfg.isConfigured(), false);
    assert.strictEqual(cfg.resolveBase(), 'https://legacy.test/v1');

    localStorage.removeItem(LEGACY_KEY);
    assert.strictEqual(cfg.resolveBase(), cfg.upstream + '/v1');
  });
});

test('getItem 抛错（隐私模式）时不抛，按未配置处理', () => {
  const had = Object.prototype.hasOwnProperty.call(global, 'localStorage');
  const prev = global.localStorage;
  global.localStorage = {
    getItem: function () { throw new Error('SecurityError'); },
    setItem: function () { throw new Error('SecurityError'); },
    removeItem: function () { throw new Error('SecurityError'); }
  };
  try {
    const cfg = loadFresh();
    assert.strictEqual(cfg.getConfig(), null);
    assert.strictEqual(cfg.isConfigured(), false);
    assert.deepStrictEqual(cfg.authHeaders(), {});
    assert.strictEqual(cfg.model, DEFAULT_MODEL);
    assert.strictEqual(cfg.resolveBase(), cfg.upstream + '/v1');
  } finally {
    if (had) global.localStorage = prev;
    else delete global.localStorage;
  }
});

/* ================================================================
 * 6. 清除
 * ================================================================ */

console.log('\n--- clearConfig ---');

test('clearConfig 后回到默认（未配置 / 默认基址 / 空鉴权头）', () => {
  withStorage(function () {
    const cfg = loadFresh();
    cfg.saveConfig({ key: 'sk-ws-0123456789HGpY' });
    assert.strictEqual(cfg.isConfigured(), true);
    assert.strictEqual(cfg.clearConfig(), true);
    assert.strictEqual(cfg.isConfigured(), false);
    assert.strictEqual(cfg.getConfig(), null);
    assert.strictEqual(cfg.resolveBase(), cfg.upstream + '/v1');
    assert.deepStrictEqual(cfg.authHeaders(), {});

    const cfg2 = loadFresh();
    assert.strictEqual(cfg2.model, DEFAULT_MODEL);
  });
});

/* ================================================================
 * 7. 写入失败
 * ================================================================ */

console.log('\n--- 写入失败 ---');

test('setItem 抛错（配额/隐私模式）时 saveConfig 返回 false', () => {
  const had = Object.prototype.hasOwnProperty.call(global, 'localStorage');
  const prev = global.localStorage;
  global.localStorage = {
    getItem: function () { return null; },
    setItem: function () { throw new Error('QuotaExceededError'); },
    removeItem: function () {}
  };
  try {
    const cfg = loadFresh();
    assert.strictEqual(cfg.saveConfig({ key: 'k' }), false);
    assert.strictEqual(cfg.isConfigured(), false);
  } finally {
    if (had) global.localStorage = prev;
    else delete global.localStorage;
  }
});

/* ================================================================
 * 8. 静态安全扫描
 * ================================================================ */

console.log('\n--- 静态扫描 ---');

function jsFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir))
    .filter(function (n) { return n.endsWith('.js'); })
    .map(function (n) { return path.join(ROOT, dir, n); });
}

test('diagnose/*.js（除 llm-config.js）与 scripts/*.js 不含百炼地址/型号字面量', () => {
  const files = jsFiles('diagnose').filter(function (p) {
    return path.basename(p) !== 'llm-config.js';
  }).concat(jsFiles('scripts'));
  const bad = [];
  const literals = ['dashscope.aliyuncs.com', 'qwen3.8'];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const lit of literals) {
      if (text.indexOf(lit) !== -1) bad.push(path.relative(ROOT, file) + ' 含「' + lit + '」');
    }
  }
  assert.deepStrictEqual(bad, []);
});

test('diagnose/*.html 也不含百炼地址/型号字面量（设置页只从 PRESETS 读）', () => {
  const files = fs.readdirSync(path.join(ROOT, 'diagnose'))
    .filter(function (n) { return n.endsWith('.html'); })
    .map(function (n) { return path.join(ROOT, 'diagnose', n); });
  const bad = [];
  const literals = ['dashscope.aliyuncs.com', 'qwen3.8'];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const lit of literals) {
      if (text.indexOf(lit) !== -1) bad.push(path.relative(ROOT, file) + ' 含「' + lit + '」');
    }
  }
  assert.deepStrictEqual(bad, []);
});

/* ================================================================
 * 9. 设置页 testConnection 状态串的模型标注（TASK-fix403 第 3/4b 项）
 *    纯 Node、无浏览器：搭最小假 document + 假 fetch，require settings.js 执行 IIFE，
 *    捕获 test-btn 的 click 处理函数，触发后 poll status.textContent 直到出现尾注。
 * ================================================================ */

console.log('\n--- testConnection 状态串模型标注 ---');

const SETTINGS_PATH = path.join(ROOT, 'diagnose', 'settings.js');

/** 假元素：覆盖 settings.js 用到的全部 DOM 属性（value/textContent/hidden/options/innerHTML/appendChild/addEventListener/type/disabled）。 */
function makeFakeEl() {
  return {
    value: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    type: 'text',
    options: [],
    _listeners: {},
    appendChild: function (child) { this.options.push(child); return child; },
    addEventListener: function (type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    click: function () {
      (this._listeners.click || []).forEach(function (fn) { fn(); });
    }
  };
}

/**
 * 搭一个最小假环境，加载 settings.js（执行 IIFE，注册 click handler）。
 * @param {object} opts
 *   - savedConfig: localStorage 里保存的 {base,model,key}（null=不保存）
 *   - fetchImpl: 假 fetch 函数
 *   - afterLoad: IIFE 执行后、click 之前的回调，用来覆盖表单值（模拟用户改了表单）
 * @returns {{elements: object, restore: function}}
 */
function setupSettingsEnv(opts) {
  opts = opts || {};
  const saved = [];

  /* 1. 假 localStorage（带 savedConfig） */
  const hadLS = Object.prototype.hasOwnProperty.call(global, 'localStorage');
  const prevLS = global.localStorage;
  const lsMap = {};
  if (opts.savedConfig) {
    lsMap[STORE_KEY] = JSON.stringify(opts.savedConfig);
  }
  global.localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(lsMap, k) ? lsMap[k] : null; },
    setItem: function (k, v) { lsMap[k] = String(v); saved.push(k); },
    removeItem: function (k) { delete lsMap[k]; }
  };

  /* 2. 假 document + 假元素 */
  const ids = ['preset-label', 'model-select', 'api-key', 'toggle-key', 'test-btn',
    'save-btn', 'saved-line', 'saved-tail', 'clear-btn', 'base-input', 'custom-model', 'status'];
  const elements = {};
  for (const id of ids) elements[id] = makeFakeEl();
  const hadDoc = Object.prototype.hasOwnProperty.call(global, 'document');
  const prevDoc = global.document;
  global.document = {
    getElementById: function (id) { return elements[id] || null; },
    createElement: function () { return makeFakeEl(); }
  };

  /* 3. 假 fetch */
  const hadFetch = Object.prototype.hasOwnProperty.call(global, 'fetch');
  const prevFetch = global.fetch;
  global.fetch = opts.fetchImpl;

  /* 3b. 假 location：doSave 成功路径会 setTimeout(location.href = 'index.html')，
   *     不给假 location 会在 restore 之后抛 ReferenceError（unhandled）。
   *     这里给一个空壳，setTimeout 改 href 只是设属性，不跳转。 */
  const hadLoc = Object.prototype.hasOwnProperty.call(global, 'location');
  const prevLoc = global.location;
  global.location = { href: '' };

  /* 4. globalThis.LLMConfig：用上面的假 localStorage 重新加载 llm-config.js */
  delete require.cache[require.resolve(CONFIG_PATH)];
  const cfg = require(CONFIG_PATH);
  globalThis.LLMConfig = cfg;

  /* 5. require settings.js（执行 IIFE：fillPreset + prefillSaved + 注册 click handler） */
  delete require.cache[require.resolve(SETTINGS_PATH)];
  require(SETTINGS_PATH);

  /* 6. IIFE 执行后允许覆盖表单值（模拟用户在表单输入了别的）。
   *    afterLoad(elements, cfg) 第二个参数传入 LLMConfig 实例，供用例调 clearConfig 等。 */
  if (typeof opts.afterLoad === 'function') opts.afterLoad(elements, cfg);

  return {
    elements: elements,
    cfg: cfg,
    restore: function () {
      if (hadLS) global.localStorage = prevLS; else delete global.localStorage;
      if (hadDoc) global.document = prevDoc; else delete global.document;
      if (hadFetch) global.fetch = prevFetch; else delete global.fetch;
      if (hadLoc) global.location = prevLoc; else delete global.location;
      delete globalThis.LLMConfig;
      delete require.cache[require.resolve(SETTINGS_PATH)];
      delete require.cache[require.resolve(CONFIG_PATH)];
    }
  };
}

/** 等 status 文本满足谓词，5 秒超时（testConnection 是 async，click handler 不 await 它）。
 *  注意：testConnection 内所有 setTestStatus 都追加尾注，包括「正在测试第 1 步…」这类中间状态。
 *  所以谓词不能只等尾注出现，要等到 testConnection 的最终状态（不含「正在测试」）。 */
async function waitForStatus(elements, predicate, timeoutMs) {
  const t0 = Date.now();
  timeoutMs = timeoutMs || 5000;
  while (Date.now() - t0 < timeoutMs) {
    const t = elements.status.textContent;
    if (t.indexOf('正在测试') < 0 && predicate(t)) return;
    await new Promise(function (r) { setTimeout(r, 30); });
  }
  throw new Error('等待 status 超时（' + timeoutMs + 'ms），当前文本：\n' + elements.status.textContent);
}

/** 造一个假 fetch 响应：GET /models 返回 200 + 模型列表；POST /chat/completions 按 opts 行为。
 *  opts.ok2 / opts.status2 / opts.body2 控制第 2 步响应；throw2=true 时第 2 步抛错。
 *  可选扩展（默认行为不变，仅供新增盲点用例使用）：
 *  - ok1 / status1 / body1 / res1Url：定制第 1 步响应（含 res.url 字段）；
 *  - throw1 / throw1Error：第 1 步 fetch 直接抛 throw1Error || new TypeError('Failed to fetch')；
 *  - res2Url：给第 2 步响应加 res.url 字段；
 *  - throw2Error：配合现有 throw2 覆盖第 2 步抛出的错误对象（不传仍是 Error('mock network error')）。 */
function makeFetchForTestConnection(opts) {
  opts = opts || {};
  const calls = [];
  const fn = async function (url, init) {
    calls.push({ url: String(url), method: init && init.method });
    const u = String(url);
    if (u.indexOf('/models') >= 0 && (!init || init.method === 'GET' || !init.method)) {
      if (opts.throw1) throw (opts.throw1Error || new TypeError('Failed to fetch'));
      const modelsBody = opts.body1 != null ? opts.body1 : JSON.stringify({ data: ['m-a', 'm-b', 'm-c'] });
      const res1 = {
        ok: opts.ok1 != null ? !!opts.ok1 : true,
        status: opts.status1 != null ? opts.status1 : 200,
        text: async function () { return modelsBody; },
        json: async function () { return JSON.parse(modelsBody); }
      };
      if (opts.res1Url != null) res1.url = opts.res1Url;
      return res1;
    }
    /* 第 2 步 POST /chat/completions */
    if (opts.throw2) throw (opts.throw2Error || new Error('mock network error'));
    const res2 = {
      ok: !!opts.ok2,
      status: opts.status2 != null ? opts.status2 : 200,
      text: async function () { return opts.body2 != null ? opts.body2 : JSON.stringify({ choices: [{ message: { content: '通了' }, finish_reason: 'stop' }] }); },
      json: async function () { return JSON.parse(opts.body2 != null ? opts.body2 : JSON.stringify({ choices: [{ message: { content: '通了' }, finish_reason: 'stop' }] })); }
    };
    if (opts.res2Url != null) res2.url = opts.res2Url;
    return res2;
  };
  fn.calls = calls;
  return fn;
}

asyncTest('testConnection 成功态 + 一致：状态串含两行模型标注 + 尾注，不含不一致警告', async () => {
  const fetchImpl = makeFetchForTestConnection({ ok2: true, status2: 200 });
  const env = setupSettingsEnv({
    savedConfig: { base: 'https://t.test/v1', model: PRESET.model, key: 'k-saved-1234567890' },
    fetchImpl: fetchImpl
  });
  try {
    /* savedConfig.model 是 qwen3.8-flash，fillPreset 后 modelSelect.value=qwen3.8-flash；
     * prefillSaved 找到该 option → modelSelect.value 仍是 qwen3.8-flash，customModel.value 为空。
     * currentModel() = qwen3.8-flash，与已保存一致 → 不应出现不一致警告。 */
    env.elements['test-btn'].click();
    await waitForStatus(env.elements, function (t) { return t.indexOf('测试只验证能连通，不验证讲解速度。') >= 0; });
    const s = env.elements.status.textContent;
    assert.ok(s.indexOf('本次测试的模型：') >= 0, '应含「本次测试的模型：」：\n' + s);
    assert.ok(s.indexOf('已保存的模型：') >= 0, '应含「已保存的模型：」：\n' + s);
    assert.ok(s.indexOf(PRESET.model) >= 0, '应含型号名 ' + PRESET.model + '：\n' + s);
    assert.ok(s.indexOf('测试只验证能连通，不验证讲解速度。') >= 0, '应含尾注：\n' + s);
    assert.ok(s.indexOf('不一致') < 0, '一致时不应含「不一致」警告：\n' + s);
  } finally {
    env.restore();
  }
});

asyncTest('testConnection 不一致：表单 m-other / 已保存 m-saved → 状态串含警告行且警告行含 m-saved', async () => {
  const fetchImpl = makeFetchForTestConnection({ ok2: true, status2: 200 });
  const env = setupSettingsEnv({
    savedConfig: { base: 'https://t.test/v1', model: 'm-saved', key: 'k-saved-1234567890' },
    fetchImpl: fetchImpl,
    afterLoad: function (elements) {
      /* prefillSaved 因 m-saved 不在 altModels 里 → customModel.value=m-saved；
       * 模拟用户又把表单改成 m-other → 覆盖 customModel.value。 */
      elements['custom-model'].value = 'm-other';
    }
  });
  try {
    env.elements['test-btn'].click();
    await waitForStatus(env.elements, function (t) { return t.indexOf('测试只验证能连通，不验证讲解速度。') >= 0; });
    const s = env.elements.status.textContent;
    assert.ok(s.indexOf('本次测试的模型：m-other') >= 0, '应含「本次测试的模型：m-other」：\n' + s);
    assert.ok(s.indexOf('已保存的模型：m-saved') >= 0, '应含「已保存的模型：m-saved」：\n' + s);
    assert.ok(s.indexOf('不一致') >= 0, '应含「不一致」警告：\n' + s);
    assert.ok(s.indexOf('m-saved') >= 0, '警告行应出现已保存型号 m-saved：\n' + s);
    assert.ok(s.indexOf('测试只验证能连通，不验证讲解速度。') >= 0, '应含尾注：\n' + s);
  } finally {
    env.restore();
  }
});

asyncTest('testConnection 未保存：getConfig() 为 null → 状态串含「（未保存，讲解会用默认 」+ 默认型号名（取 CFG.defaultModel）', async () => {
  const fetchImpl = makeFetchForTestConnection({ ok2: true, status2: 200 });
  const env = setupSettingsEnv({
    savedConfig: null,
    fetchImpl: fetchImpl,
    afterLoad: function (elements) {
      /* 未保存时 prefillSaved 直接 return；fillPreset 已把 baseInput.value 设为 PRESET.base、
       * modelSelect.value 设为 PRESET.model。补一个 key 让 testConnection 不被「请先填入 API Key」挡住。 */
      elements['api-key'].value = 'k-fake-1234567890';
    }
  });
  try {
    env.elements['test-btn'].click();
    await waitForStatus(env.elements, function (t) { return t.indexOf('测试只验证能连通，不验证讲解速度。') >= 0; });
    const s = env.elements.status.textContent;
    assert.ok(s.indexOf('（未保存，讲解会用默认 ') >= 0, '应含「（未保存，讲解会用默认 」：\n' + s);
    /* 默认型号名取 CFG.defaultModel（常量，不随保存/清除变化），不用 CFG.model（模块加载快照）。
     * 此场景下未配置，CFG.model === CFG.defaultModel，两者一致；但口径要对齐实现 —— 断言用 defaultModel。 */
    const expectedDefault = env.cfg.defaultModel;
    assert.ok(expectedDefault && s.indexOf(expectedDefault) >= 0,
      '应含默认型号名 ' + expectedDefault + '（CFG.defaultModel）：\n' + s);
    assert.ok(s.indexOf('测试只验证能连通，不验证讲解速度。') >= 0, '应含尾注：\n' + s);
  } finally {
    env.restore();
  }
});

asyncTest('testConnection 清除后不刷新：CFG.model 是旧快照，默认型号仍显示 CFG.defaultModel 而非旧值', async () => {
  /* 真机瑕疵复现：先保存一个自定义模型（CFG.model 在模块加载时快照为该自定义值），
   * 再 clearConfig（CFG.model 不变，仍是旧快照），不刷新页面直接 testConnection。
   * 修复前 buildModelAnnotation 用 CFG.model → 显示旧的自定义型号名（错的）；
   * 修复后用 CFG.defaultModel → 显示真正的默认型号名。 */
  const customModel = 'm-custom-saved-then-cleared';
  const fetchImpl = makeFetchForTestConnection({ ok2: true, status2: 200 });
  const env = setupSettingsEnv({
    savedConfig: { base: 'https://t.test/v1', model: customModel, key: 'k-saved-1234567890' },
    fetchImpl: fetchImpl,
    afterLoad: function (elements, cfg) {
      /* 模拟家长点了「清除」：clearConfig 后 getConfig() 返回 null，但 CFG.model 仍是模块加载时的快照
       * （= customModel，因为 setupSettingsEnv 加载 llm-config.js 时 localStorage 里有 savedConfig）。
       * 补一个 key 让 testConnection 不被「请先填入 API Key」挡住。 */
      cfg.clearConfig();
      elements['api-key'].value = 'k-fake-after-clear';
    }
  });
  try {
    /* 确认前提：CFG.model 是旧快照（customModel），CFG.defaultModel 是常量（DEFAULT_MODEL），
     * 两者不同 —— 否则这条测试无法区分修复前后。 */
    assert.strictEqual(env.cfg.model, customModel, '前提：CFG.model 应为旧快照 ' + customModel);
    assert.notStrictEqual(env.cfg.model, env.cfg.defaultModel,
      '前提：CFG.model 与 CFG.defaultModel 应不同，否则无法验证修复');

    env.elements['test-btn'].click();
    await waitForStatus(env.elements, function (t) { return t.indexOf('测试只验证能连通，不验证讲解速度。') >= 0; });
    const s = env.elements.status.textContent;
    assert.ok(s.indexOf('（未保存，讲解会用默认 ') >= 0, '清除后未保存，应含「（未保存，讲解会用默认 」：\n' + s);
    /* 关键断言：默认型号应显示 CFG.defaultModel，而不是旧快照 CFG.model（customModel）。
     * 只检查「已保存的模型：」那一行 —— customModel 出现在「本次测试的模型：」行是合理的
     * （表单 customModel.value 没清，currentModel() 仍返回它，这是表单状态，不是标注 bug）。 */
    var savedLineMatch = s.match(/已保存的模型：[^\n]*/);
    assert.ok(savedLineMatch, '应存在「已保存的模型：」行：\n' + s);
    var savedLine = savedLineMatch[0];
    assert.ok(savedLine.indexOf(env.cfg.defaultModel) >= 0,
      '「已保存的模型」行应含 CFG.defaultModel（' + env.cfg.defaultModel + '）：\n' + savedLine);
    assert.ok(savedLine.indexOf(customModel) < 0,
      '「已保存的模型」行不应含旧快照型号 ' + customModel + '：\n' + savedLine);
    assert.ok(s.indexOf('测试只验证能连通，不验证讲解速度。') >= 0, '应含尾注：\n' + s);
  } finally {
    env.restore();
  }
});

asyncTest('testConnection 失败态：第 2 步 POST 403 → 状态串仍含两行模型标注 + 尾注', async () => {
  const fetchImpl = makeFetchForTestConnection({ ok2: false, status2: 403, body2: JSON.stringify({ error: 'Free quota exhausted' }) });
  const env = setupSettingsEnv({
    savedConfig: { base: 'https://t.test/v1', model: PRESET.model, key: 'k-saved-1234567890' },
    fetchImpl: fetchImpl
  });
  try {
    env.elements['test-btn'].click();
    await waitForStatus(env.elements, function (t) { return t.indexOf('测试只验证能连通，不验证讲解速度。') >= 0; });
    const s = env.elements.status.textContent;
    assert.ok(s.indexOf('403') >= 0, '失败态应含 403：\n' + s);
    assert.ok(s.indexOf('本次测试的模型：') >= 0, '失败态也应含「本次测试的模型：」：\n' + s);
    assert.ok(s.indexOf('已保存的模型：') >= 0, '失败态也应含「已保存的模型：」：\n' + s);
    assert.ok(s.indexOf('测试只验证能连通，不验证讲解速度。') >= 0, '失败态也应含尾注：\n' + s);
  } finally {
    env.restore();
  }
});

asyncTest('doSave 状态串不含模型标注：点保存后状态串是「已保存，正在返回…」，不含「本次测试的模型」', async () => {
  const fetchImpl = makeFetchForTestConnection({ ok2: true, status2: 200 });
  const env = setupSettingsEnv({
    savedConfig: { base: 'https://t.test/v1', model: PRESET.model, key: 'k-old-1234567890' },
    fetchImpl: fetchImpl,
    afterLoad: function (elements) {
      /* 填一个合法 key，让 doSave 走成功路径（saveConfig → setStatus('已保存，正在返回…')）。
       * doSave 成功后会 setTimeout(location.href)，setupSettingsEnv 已给假 location 兜住。 */
      elements['api-key'].value = 'sk-new-1234567890XYZ';
    }
  });
  try {
    env.elements['save-btn'].click();
    /* doSave 是同步的（setStatus 立即写 textContent，setTimeout 是异步跳转），
     * 直接读 status 即可，不需要 waitForStatus。 */
    const s = env.elements.status.textContent;
    assert.ok(s.indexOf('已保存') >= 0, '保存后应含「已保存」：\n' + s);
    assert.ok(s.indexOf('本次测试的模型') < 0,
      'doSave 状态串不应含「本次测试的模型」（保存不是测试，措辞不应带模型标注）：\n' + s);
    assert.ok(s.indexOf('测试只验证能连通') < 0,
      'doSave 状态串不应含测试尾注：\n' + s);
    /* 等 setTimeout(500ms) 跑完再 restore，避免 restore 后 setTimeout 触发访问已删 location */
    await new Promise(function (r) { setTimeout(r, 600); });
  } finally {
    env.restore();
  }
});

/* ================================================================
 * 10. 「测试连接」盲点修复（kanban t_30c17629）：
 *     全角冒号归一化 / 非绝对地址不发请求 / 报错显示真实请求 URL / CORS 人话
 * ================================================================ */

asyncTest('testConnection 全角冒号：归一化后写回输入框，fetch 拿到半角 URL', async () => {
  const fetchImpl = makeFetchForTestConnection({ ok2: true, status2: 200 });
  const env = setupSettingsEnv({
    savedConfig: { base: 'https://t.test/v1', model: PRESET.model, key: 'k-saved-1234567890' },
    fetchImpl: fetchImpl,
    afterLoad: function (elements) {
      /* 家长用中文输入法打出全角冒号 U+FF1A */
      elements['base-input'].value = 'https\uff1a//api.example.test/v1';
    }
  });
  try {
    env.elements['test-btn'].click();
    await waitForStatus(env.elements, function (t) { return t.indexOf('连接成功') >= 0; });
    assert.ok(fetchImpl.calls.length > 0, '应发出 fetch');
    assert.strictEqual(fetchImpl.calls[0].url, 'https://api.example.test/v1/models',
      '第 1 个 fetch 应拿到全角冒号归一化后的半角 URL：' + fetchImpl.calls[0].url);
    assert.strictEqual(env.elements['base-input'].value, 'https://api.example.test/v1',
      '归一化结果应写回输入框，当前值：' + env.elements['base-input'].value);
    assert.ok(env.elements.status.textContent.indexOf('连接成功') >= 0, '状态串应含「连接成功」');
  } finally {
    env.restore();
  }
});

asyncTest('testConnection 首尾零宽/不换行空格 + 全角斜杠：归一化后写回输入框', async () => {
  const fetchImpl = makeFetchForTestConnection({ ok2: true, status2: 200 });
  const env = setupSettingsEnv({
    savedConfig: { base: 'https://t.test/v1', model: PRESET.model, key: 'k-saved-1234567890' },
    fetchImpl: fetchImpl,
    afterLoad: function (elements) {
      /* 首部零宽空格 + 不换行空格，尾部普通空格 + BOM，全角冒号和全角斜杠混在里面 */
      elements['base-input'].value = '\u200b\u00a0https\uff1a//api.example.test\uff0fv1 \ufeff';
    }
  });
  try {
    env.elements['test-btn'].click();
    await waitForStatus(env.elements, function (t) { return t.indexOf('连接成功') >= 0; });
    assert.ok(fetchImpl.calls.length > 0, '应发出 fetch');
    assert.ok(/\/v1\/models$/.test(fetchImpl.calls[0].url),
      '第 1 个 fetch url 应以 /v1/models 结尾：' + fetchImpl.calls[0].url);
    assert.strictEqual(env.elements['base-input'].value, 'https://api.example.test/v1',
      '归一化结果应写回输入框，当前值：' + env.elements['base-input'].value);
  } finally {
    env.restore();
  }
});

asyncTest('testConnection 基址不是 http/https 绝对地址：不发请求、提示以 https:// 开头', async () => {
  const fetchImpl = makeFetchForTestConnection({ ok2: true, status2: 200 });
  const env = setupSettingsEnv({
    savedConfig: { base: 'https://t.test/v1', model: PRESET.model, key: 'k-saved-1234567890' },
    fetchImpl: fetchImpl,
    afterLoad: function (elements) {
      elements['base-input'].value = 'api.example.test/v1';
    }
  });
  try {
    env.elements['test-btn'].click();
    await waitForStatus(env.elements, function (t) { return t.indexOf('基址要以 https:// 开头') >= 0; });
    assert.strictEqual(fetchImpl.calls.length, 0, '基址不是绝对地址时不应发出任何 fetch');
    const s = env.elements.status.textContent;
    assert.ok(s.indexOf('基址要以 https:// 开头') >= 0, '应提示以 https:// 开头：\n' + s);
    assert.ok(s.indexOf('请求没有发出去') >= 0, '应说明请求没有发出去：\n' + s);
    assert.ok(s.indexOf('测试只验证能连通，不验证讲解速度。') >= 0,
      '校验失败状态串仍应带模型标注尾注（走 setTestStatus）：\n' + s);
  } finally {
    env.restore();
  }
});

asyncTest('testConnection HTTP 404 且真实请求地址与填写基址不同：显示 res.url 并提示不一致', async () => {
  /* 复现盲点 1 的后果：全角冒号 URL 被 fetch 当相对路径解析到 pages 自己的域，返回 404 HTML */
  const res1Url = 'https://pages.example.test/cn-math-taxonomy/diagnose/https%EF%BC%9A//api.example.test/v1/models';
  const fetchImpl = makeFetchForTestConnection({
    ok1: false, status1: 404, body1: '<html>404</html>', res1Url: res1Url
  });
  const env = setupSettingsEnv({
    savedConfig: { base: 'https://t.test/v1', model: PRESET.model, key: 'k-saved-1234567890' },
    fetchImpl: fetchImpl,
    afterLoad: function (elements) {
      elements['base-input'].value = 'https://api.example.test/v1';
    }
  });
  try {
    env.elements['test-btn'].click();
    await waitForStatus(env.elements, function (t) { return t.indexOf('真实请求：') >= 0; });
    const s = env.elements.status.textContent;
    assert.ok(s.indexOf('真实请求：https://pages.example.test/') >= 0, '应显示 res.url（真实请求）：\n' + s);
    assert.ok(s.indexOf('不一致') >= 0, '真实地址与填写不同时应提示不一致：\n' + s);
    assert.ok(s.indexOf('404') >= 0, '应含 404：\n' + s);
    assert.ok(s.indexOf('服务端原文：') >= 0, '应含「服务端原文：」标签：\n' + s);
    assert.ok(s.indexOf('k-saved-1234567890') < 0, '状态串不得含 API Key：\n' + s);
  } finally {
    env.restore();
  }
});

asyncTest('testConnection fetch 抛 TypeError（跨域被拦）：说请求没有发出去 + 补 CORS 人话', async () => {
  const fetchImpl = makeFetchForTestConnection({ throw1: true, throw1Error: new TypeError('Failed to fetch') });
  const env = setupSettingsEnv({
    savedConfig: { base: 'https://t.test/v1', model: PRESET.model, key: 'k-saved-1234567890' },
    fetchImpl: fetchImpl
  });
  try {
    env.elements['test-btn'].click();
    await waitForStatus(env.elements, function (t) { return t.indexOf('请求没有发出去') >= 0; });
    const s = env.elements.status.textContent;
    assert.ok(s.indexOf('请求没有发出去（未到达任何服务器）') >= 0, '应说明请求没有发出去：\n' + s);
    assert.ok(s.indexOf('CORS') >= 0, 'TypeError 应补 CORS 人话：\n' + s);
    assert.ok(s.indexOf('compatible-mode/v1') >= 0, 'CORS 人话应指向标准端点 compatible-mode/v1：\n' + s);
  } finally {
    env.restore();
  }
});

asyncTest('testConnection fetch 抛普通 Error：说请求没有发出去，但不补 CORS 人话', async () => {
  const fetchImpl = makeFetchForTestConnection({ throw1: true, throw1Error: new Error('boom') });
  const env = setupSettingsEnv({
    savedConfig: { base: 'https://t.test/v1', model: PRESET.model, key: 'k-saved-1234567890' },
    fetchImpl: fetchImpl
  });
  try {
    env.elements['test-btn'].click();
    await waitForStatus(env.elements, function (t) { return t.indexOf('请求没有发出去') >= 0; });
    const s = env.elements.status.textContent;
    assert.ok(s.indexOf('请求没有发出去') >= 0, '应说明请求没有发出去：\n' + s);
    assert.ok(s.indexOf('CORS') < 0, '普通 Error 不是跨域拦截，不应补 CORS 人话：\n' + s);
  } finally {
    env.restore();
  }
});

asyncTest('testConnection 第 2 步 POST 返回 403：状态串含 res2.url', async () => {
  const res2Url = 'https://t.test/v1/chat/completions';
  const fetchImpl = makeFetchForTestConnection({
    ok2: false, status2: 403, body2: JSON.stringify({ error: 'Free quota exhausted' }), res2Url: res2Url
  });
  const env = setupSettingsEnv({
    savedConfig: { base: 'https://t.test/v1', model: PRESET.model, key: 'k-saved-1234567890' },
    fetchImpl: fetchImpl
  });
  try {
    env.elements['test-btn'].click();
    await waitForStatus(env.elements, function (t) { return t.indexOf('403') >= 0; });
    const s = env.elements.status.textContent;
    assert.ok(s.indexOf('真实请求：' + res2Url) >= 0, '应含 res2.url（真实请求）：\n' + s);
    assert.ok(s.indexOf('403') >= 0, '应含 403：\n' + s);
  } finally {
    env.restore();
  }
});

asyncTest('testConnection 超时（AbortError）：说请求发出去了但没回应，不说「没有发出去」', async () => {
  /* timeoutSignal() 15s 后 abort，fetch 抛 AbortError —— 请求其实已发出、只是没等到回应，
   * 不能说「请求没有发出去」（那会让家长去查基址而不是查网络/换端点）。 */
  const abortErr = new Error('The operation was aborted.');
  abortErr.name = 'AbortError';
  const fetchImpl = makeFetchForTestConnection({ throw1: true, throw1Error: abortErr });
  const env = setupSettingsEnv({
    savedConfig: { base: 'https://t.test/v1', model: PRESET.model, key: 'k-saved-1234567890' },
    fetchImpl: fetchImpl
  });
  try {
    env.elements['test-btn'].click();
    await waitForStatus(env.elements, function (t) { return t.indexOf('请求失败') >= 0; });
    const s = env.elements.status.textContent;
    assert.ok(s.indexOf('请求发出去了，但 15 秒内没有回应（超时）') >= 0,
      '超时应说「请求发出去了，但 15 秒内没有回应（超时）」：\n' + s);
    assert.ok(s.indexOf('请求没有发出去') < 0,
      '超时时请求其实已发出，不应说「请求没有发出去」：\n' + s);
    assert.ok(s.indexOf('CORS') < 0,
      '超时不是 CORS 拦截，不应出现 CORS 提示：\n' + s);
  } finally {
    env.restore();
  }
});

asyncTest('testConnection 第 2 步 POST 超时：同样说请求发出去了但没回应', async () => {
  const abortErr = new Error('The operation was aborted.');
  abortErr.name = 'AbortError';
  const fetchImpl = makeFetchForTestConnection({ throw2: true, throw2Error: abortErr });
  const env = setupSettingsEnv({
    savedConfig: { base: 'https://t.test/v1', model: PRESET.model, key: 'k-saved-1234567890' },
    fetchImpl: fetchImpl
  });
  try {
    env.elements['test-btn'].click();
    await waitForStatus(env.elements, function (t) { return t.indexOf('请求失败') >= 0; });
    const s = env.elements.status.textContent;
    assert.ok(s.indexOf('请求发出去了') >= 0, '第 2 步超时应说「请求发出去了」：\n' + s);
    assert.ok(s.indexOf('请求没有发出去') < 0, '第 2 步超时不应说「请求没有发出去」：\n' + s);
  } finally {
    env.restore();
  }
});

/* ================================================================
 * 收尾：先跑完同步用例（已在文件加载时执行），再顺序跑异步用例，最后合并打印总数。
 * 异步用例的输出格式与同步用例一致（  ok   /  FAIL ），不破坏既有计数。
 * ================================================================ */

(async function () {
  for (const t of asyncTests) {
    try {
      await t.fn();
      passed++;
      console.log('  ok   ' + t.name);
    } catch (e) {
      failed++;
      console.log('  FAIL ' + t.name + '\n       ' + String((e && e.stack) || e).split('\n').slice(0, 5).join('\n       '));
    }
  }
  console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
})();
