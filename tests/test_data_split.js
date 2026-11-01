#!/usr/bin/env node
/* 首屏数据瘦身（C1）+ 立刻出界面（C2）守卫：node tests/test_data_split.js
 *
 * 背景（线上 50KB/s 手机冷启动实测 29.2s / 32.4s，上一版 25.4s）：
 *   脚本瘦身（A+B）被数据淹没 —— 首屏同时发起 topics.json(347KB gzip)、
 *   dependencies.json(114KB)、cn-curriculum-standards.js(45KB)，互相抢带宽；
 *   而整页在数据到齐前只有「加载数据中……」一行字。
 *
 * 本文件守两件事不再退化：
 *   C1 首屏只取 data/topics-lite.json（8 个白名单字段，gzip ≈60KB）+ id-aliases；
 *      说明类字段（description / mastery_criteria / diagnostic_question / standards）
 *      从全量 topics.json 懒取，且只取一次、原地补字段。
 *   C2 打开页面立刻有骨架（标题 / 学段按钮 / 搜索框 / 状态行），数据到货后原地替换。
 *
 * 测试目录没有 DOM 基座、不引 jsdom（整个仓库的测试都是纯 node），所以
 * app.js 那几条做源码级守卫 —— 与 test_pwa_load.js / test_engine.js 同风格：
 * 花括号配对取函数体文本再断言，不做运行期 DOM 断言。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOPICS_PATH = path.join(ROOT, 'data', 'topics.json');
const LITE_PATH = path.join(ROOT, 'data', 'topics-lite.json');
const APP = fs.readFileSync(path.join(ROOT, 'diagnose', 'app.js'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'diagnose', 'index.html'), 'utf8');

/** 白名单：首屏选题界面需要的全部字段。 */
const LITE_FIELDS = ['id', 'name', 'domain', 'grade', 'semester', 'chapter', 'type', 'subject'];
/** 只在详情 / 出题 / 课标对照才用的大字段：绝不许出现在 lite 里。 */
const HEAVY_FIELDS = ['description', 'mastery_criteria', 'diagnostic_question', 'standards'];
/** lite 的 gzip 预算（卡上目标 ≤110KB 首屏数据总量；lite 单独留 80KB 的闸）。 */
const LITE_GZIP_LIMIT = 80 * 1024;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); }
}

/* 花括号配对取函数体（先抹掉字符串字面量里的括号），与 test_pwa_load.js 同法。 */
function bodyAfter(src, startToken) {
  const at = src.indexOf(startToken);
  assert.ok(at >= 0, '源码里找不到：' + startToken);
  const open = src.indexOf('{', at + startToken.length - 1);
  assert.ok(open >= 0, '找不到起始花括号：' + startToken);
  const masked = src.slice(0, open) + src.slice(open).replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, function (s) { return s.replace(/[{}]/g, '_'); });
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  throw new Error('花括号不配对：' + startToken);
}

/** 与 scripts/build-topics-lite.mjs 同一套规则的独立实现（测试不复用被测代码，避免自证）。 */
function toLite(topic) {
  const out = {};
  LITE_FIELDS.forEach(function (k) {
    if (!Object.prototype.hasOwnProperty.call(topic, k)) return;
    const v = topic[k];
    if (v === null || v === undefined) return;
    if (typeof v === 'string' && v.trim() === '') return;
    if (Array.isArray(v) && !v.length) return;
    out[k] = v;
  });
  return out;
}

/* ------------------------------------------------------------ C1 数据文件 */
test('data/topics-lite.json 存在、是数组，条数与 data/topics.json 相同', function () {
  assert.ok(fs.existsSync(LITE_PATH), 'data/topics-lite.json 不存在（先跑 node scripts/build-topics-lite.mjs）');
  const lite = JSON.parse(fs.readFileSync(LITE_PATH, 'utf8'));
  const full = JSON.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));
  assert.ok(Array.isArray(lite), 'topics-lite.json 必须是数组');
  assert.ok(Array.isArray(full), 'topics.json 必须是数组');
  assert.strictEqual(lite.length, full.length, 'lite 条数应与全量相同：' + lite.length + ' vs ' + full.length);
  assert.ok(lite.length > 1000, '条数太少，像是被截断了：' + lite.length);
});

test('lite 每条只有白名单字段，没有 description / standards / mastery_criteria / diagnostic_question', function () {
  const lite = JSON.parse(fs.readFileSync(LITE_PATH, 'utf8'));
  const bad = [];
  lite.forEach(function (t, i) {
    Object.keys(t).forEach(function (k) {
      if (LITE_FIELDS.indexOf(k) < 0) bad.push('#' + i + ' 多了字段 ' + k);
    });
    HEAVY_FIELDS.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(t, k)) bad.push('#' + i + ' 含重字段 ' + k);
    });
  });
  assert.deepStrictEqual(bad.slice(0, 5), [], 'lite 里出现了白名单之外的字段（前 5 条）：' + bad.slice(0, 5).join('；'));
});

test('lite 的 id 集合与全量完全一致（不丢不错、不重复）', function () {
  const lite = JSON.parse(fs.readFileSync(LITE_PATH, 'utf8'));
  const full = JSON.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));
  const fullIds = new Set(full.map(function (t) { return t.id; }));
  const liteIds = new Set(lite.map(function (t) { return t.id; }));
  assert.strictEqual(liteIds.size, lite.length, 'lite 里有重复 id');
  assert.strictEqual(liteIds.size, fullIds.size, 'id 数量不一致：' + liteIds.size + ' vs ' + fullIds.size);
  const missing = [];
  lite.forEach(function (t) { if (!fullIds.has(t.id)) missing.push('多出 ' + t.id); });
  fullIds.forEach(function (id) { if (!liteIds.has(id)) missing.push('丢了 ' + id); });
  assert.deepStrictEqual(missing.slice(0, 5), [], 'id 集合与全量不一致（前 5 条）：' + missing.slice(0, 5).join('；'));
});

test('lite 的 name / chapter / grade / semester 与全量逐条相同（抽样 200+ 条逐条比）', function () {
  const lite = JSON.parse(fs.readFileSync(LITE_PATH, 'utf8'));
  const full = JSON.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));
  const byId = new Map();
  full.forEach(function (t) { byId.set(t.id, t); });
  /* 等距抽样 + 前 20 条，保证 ≥200 条，且覆盖各学段（不只看开头的小学） */
  const step = Math.max(1, Math.floor(lite.length / 220));
  const picked = [];
  for (let i = 0; i < lite.length && picked.length < 240; i += step) picked.push(lite[i]);
  for (let i = 0; i < 20 && i < lite.length; i++) if (picked.indexOf(lite[i]) < 0) picked.push(lite[i]);
  assert.ok(picked.length >= 200, '抽样条数不足 200：' + picked.length);
  const diff = [];
  picked.forEach(function (t) {
    const f = byId.get(t.id);
    assert.ok(f, '全量里找不到 ' + t.id);
    ['name', 'chapter', 'grade', 'semester'].forEach(function (k) {
      if (JSON.stringify(t[k]) !== JSON.stringify(f[k])) diff.push(t.id + '.' + k + ': ' + JSON.stringify(t[k]) + ' ≠ ' + JSON.stringify(f[k]));
    });
  });
  assert.deepStrictEqual(diff.slice(0, 5), [], '抽样字段与全量不一致（前 5 条）：' + diff.slice(0, 5).join('；'));
});

test('空值字段不出现在 lite 里（不输出 "subject": "" / null）', function () {
  const lite = JSON.parse(fs.readFileSync(LITE_PATH, 'utf8'));
  const bad = [];
  lite.forEach(function (t, i) {
    Object.keys(t).forEach(function (k) {
      const v = t[k];
      if (v === '' || v === null || v === undefined) bad.push('#' + i + '.' + k + ' 是空值');
      if (typeof v === 'string' && v.trim() === '') bad.push('#' + i + '.' + k + ' 是空白串');
    });
  });
  assert.deepStrictEqual(bad.slice(0, 5), [], 'lite 里有空值字段（前 5 条）：' + bad.slice(0, 5).join('；'));
  /* 反向确认：确实存在「全量有 subject、lite 省略」的条目，否则这条断言等于没测 */
  const full = JSON.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));
  const omitted = full.filter(function (t) { return !Object.prototype.hasOwnProperty.call(t, 'subject') || t.subject === ''; }).length;
  assert.ok(omitted > 0, '全量里没有缺 subject 的条目，本断言失去意义');
});

test('build-topics-lite.mjs 幂等：临时目录跑两次，输出字节完全相同', function () {
  const script = path.join(ROOT, 'scripts', 'build-topics-lite.mjs');
  assert.ok(fs.existsSync(script), 'scripts/build-topics-lite.mjs 不存在');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnm-lite-'));
  const a = path.join(tmp, 'a.json');
  const b = path.join(tmp, 'b.json');
  try {
    execFileSync(process.execPath, [script, '--out', a], { cwd: ROOT, stdio: 'pipe' });
    execFileSync(process.execPath, [script, '--out', b], { cwd: ROOT, stdio: 'pipe' });
    const ba = fs.readFileSync(a);
    const bb = fs.readFileSync(b);
    assert.ok(ba.length > 0, '生成的文件是空的');
    assert.strictEqual(ba.length, bb.length, '两次输出长度不同：' + ba.length + ' vs ' + bb.length);
    assert.ok(ba.equals(bb), '两次输出字节不同（不幂等）');
    /* 临时目录跑出来的结果必须与仓库里提交的那份一致，否则仓库文件是过期的 */
    assert.ok(ba.equals(fs.readFileSync(LITE_PATH)), 'scripts/build-topics-lite.mjs 的输出与已提交的 data/topics-lite.json 不一致（忘了重新生成？）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('lite 的 gzip 体积 < 80KB（防止大字段被塞回来）', function () {
  const raw = fs.readFileSync(LITE_PATH);
  const gz = zlib.gzipSync(raw).length;
  assert.ok(gz < LITE_GZIP_LIMIT, 'lite gzip ' + (gz / 1024).toFixed(1) + 'KB 超过 ' + (LITE_GZIP_LIMIT / 1024) + 'KB 闸线');
  /* 与全量对比：必须真的省下来了，不是把全量原样复制一份 */
  const fullGz = zlib.gzipSync(fs.readFileSync(TOPICS_PATH)).length;
  assert.ok(gz < fullGz * 0.5, 'lite（' + gz + 'B）应不到全量 gzip（' + fullGz + 'B）的一半');
});

test('lite 用的是紧凑 JSON：没有缩进换行，中文没有被转义成 \\uXXXX', function () {
  const text = fs.readFileSync(LITE_PATH, 'utf8');
  assert.strictEqual(text.indexOf('\\u'), -1, 'lite 里出现了 \\uXXXX 转义（中文应原样输出）');
  assert.ok(text.indexOf('[\n  {') < 0, 'lite 不应是带缩进的格式（每项一行会白白多出几十 KB）');
  assert.ok(/^\[{"id":/.test(text), 'lite 应以紧凑的 [{"id": 开头');
});

/* ------------------------------------------------------------ C2 首屏阶段 */
test('app.js：首屏阶段不再 await topics.json / dependencies.json / 课标', function () {
  const body = bodyAfter(APP, 'async function loadData()');
  assert.ok(body.indexOf('topics-lite.json') >= 0, 'loadData 应只取 topics-lite.json');
  assert.strictEqual(body.indexOf('questions.json'), -1, 'loadData 里不许出现题库（保持 A+B 的结论）');
  ['topics.json', 'dependencies.json', 'cn-curriculum-standards'].forEach(function (needle) {
    const lines = body.split('\n').filter(function (l) { return l.indexOf(needle) >= 0; });
    lines.forEach(function (l) {
      assert.ok(!/await/.test(l), 'loadData 里不许 await ' + needle + '：' + l.trim());
    });
  });
  /* 三份大文件必须各有自己的按需入口，且都不在首屏链上 */
  assert.ok(/function ensureDeps\s*\(/.test(APP), '缺 ensureDeps()（阶段 2：先修关系）');
  assert.ok(/function ensureFullTopics\s*\(/.test(APP), '缺 ensureFullTopics()（阶段 2：说明类字段懒取）');
  assert.ok(/function ensureStandards\s*\(/.test(APP), '缺 ensureStandards()（阶段 3：课标条目正文）');
  const flow = bodyAfter(APP, 'async function loadQuestions()');
  assert.ok(/await fetch\('\.\.\/data\/questions\.json'\)/.test(flow), '题库时序不变：仍由 loadQuestions() 后台加载');
});

test('app.js：骨架分支（阶段 0）存在，且 renderStart 在数据到货后才被调用', function () {
  const skel = bodyAfter(APP, 'function renderSkeleton()');
  assert.ok(/正在载入知识库/.test(skel), '骨架里必须有「正在载入知识库…」这行文字（不能只靠转圈）');
  assert.ok(/class: 'skel'|skel-bar/.test(skel), '骨架里必须有占位条');
  assert.ok(/disabled/.test(skel), '骨架里的搜索框应是禁用状态');
  const init = bodyAfter(APP, 'async function init()');
  const iSkel = init.indexOf('renderSkeleton()');
  const iLoad = init.indexOf('await loadData()');
  const iStart = init.indexOf('renderStart()');
  assert.ok(iSkel >= 0, 'init 里应先渲染骨架（阶段 0）');
  assert.ok(iSkel < iLoad, '骨架必须在 await loadData() 之前渲染，才可能 0ms 出界面');
  assert.ok(iStart > iLoad, 'renderStart（阶段 1）必须在 loadData 到货之后调用');
  /* 静态骨架：HTML 里先画出来，脚本没到也有东西看 */
  assert.ok(HTML.indexOf('正在载入知识库') >= 0, 'diagnose/index.html 里应有静态骨架（脚本未执行时也有可看的界面）');
  assert.ok(HTML.indexOf('skel-bar') >= 0, 'diagnose/index.html 的骨架里应有占位条');
  assert.strictEqual(HTML.indexOf('加载数据中'), -1, 'index.html 不应再只给一行「加载数据中……」');
});

test('app.js：全量 topics.json 只取一次、只补缺口不覆盖；详情缺字段时给占位文字', function () {
  const body = bodyAfter(APP, 'function ensureFullTopics()');
  assert.ok(/fullTopicsPromise/.test(body), 'ensureFullTopics 必须缓存 Promise（只取一次）');
  assert.ok(/if \(fullTopicsLoaded\) return Promise\.resolve/.test(body) || /fullTopicsLoaded/.test(body), 'ensureFullTopics 要有已加载短路');
  assert.ok(!/t\[k\] = /.test(body) || /if \(!\(k in t\)\)/.test(body), '补字段必须先判缺口（不许覆盖 lite 已有字段）');
  assert.ok(/if \(!\(k in t\)\) t\[k\] = full\[k\]/.test(body), '补字段的写法应是「只补 lite 里没有的键」');
  /* 占位文字：详情面板没拿到 description 时不许空白/报错 */
  const desc = bodyAfter(APP, 'function descNode(t)');
  assert.ok(/正在载入说明/.test(desc), '详情面板缺 description 时应显示「正在载入说明…」');
  assert.ok(/desc-pending/.test(desc), '占位节点要带 desc-pending 类，供到货后原地替换');
  const pending = bodyAfter(APP, 'function refreshPending()');
  assert.ok(/desc-pending/.test(pending), 'refreshPending 应就地换掉 desc-pending 节点（不整页重绘）');
});

test('sw.js：预热清单含 data/topics-lite.json，且老的大文件仍然预热（离线可用）', function () {
  const m = /var DATA = \[([\s\S]*?)\];/.exec(SW);
  assert.ok(m, 'sw.js 里应有 var DATA = [...]');
  const items = m[1].match(/'(?:[^'\\]|\\.)*'/g) || [];
  assert.ok(items.indexOf("'data/topics-lite.json'") >= 0, 'DATA 里应含 data/topics-lite.json');
  ['data/topics.json', 'data/dependencies.json', 'data/cn-curriculum-standards.json', 'data/id-aliases.json'].forEach(function (p) {
    assert.ok(items.indexOf("'" + p + "'") >= 0, 'DATA 里仍应有 ' + p + '（离线要用）');
  });
  /* 预热仍然逐项独立 catch、仍然不进 waitUntil */
  const warm = bodyAfter(SW, 'function warm()');
  assert.ok(/catch\(/.test(warm), '预热每一项仍要独立 catch');
  const act = SW.slice(SW.indexOf("addEventListener('activate'"));
  assert.ok(!/await\s+warm\(/.test(act.slice(0, act.indexOf('});'))), '预热仍不许 await（会拖慢激活）');
});

test('app.js：全量 topics 取失败时给「载入失败，可刷新重试」，不是无限「正在载入」', function () {
  assert.ok(/fullTopicsFailed/.test(APP), '缺 fullTopicsFailed 标记，取失败后占位文字会永远停在「正在载入…」');
  ['说明载入失败', '掌握标准载入失败', '课标条目载入失败'].forEach(function (s) {
    assert.ok(APP.indexOf(s) >= 0, '缺失败提示文案：' + s);
  });
  assert.ok(/standardsFailed/.test(APP), '缺 standardsFailed 标记');
  assert.ok(/课标原文载入失败/.test(APP), '课标正文取失败时也应有提示，而不是一直「正在载入课标原文…」');
  /* 失败后不再自己重试（避免占位文本来回跳），但 promise 置空以便下次渲染再试 */
  const body = bodyAfter(APP, 'function ensureFullTopics()');
  assert.ok(/if \(!ok\) \{ fullTopicsPromise = null; fullTopicsFailed = true; \}/.test(body), '失败后应清 promise 标记失败，供下次渲染重试');
});

test('app.js：课标对照卡的结构也等全量到货，到货后整卡原地换掉（不是先画「无。」）', function () {
  const card = bodyAfter(APP, 'function standardsCard(sum)');
  assert.ok(/!fullTopicsLoaded \?/.test(card), 'standardsCard 在全量到货前应渲染占位，而不是按空 standards 判「无。」');
  assert.ok(/正在载入课标条目/.test(card), '占位文案缺失');
  const pending = bodyAfter(APP, 'function refreshPending()');
  assert.ok(/getElementById\('standards'\)/.test(pending), 'refreshPending 到货后应重建 #standards 卡（结构依赖全量 standards 引用）');
  assert.ok(/std-block-pending/.test(pending) && /mastery-pending/.test(pending), '详情里的课标条目/掌握标准占位也要原地换掉');
});

/* ------------------------------------------------------------ 自检（测试有效性） */
test('自检：把 description 塞进 lite 第一条，白名单断言必须报红（证明上面那条测试真的有效）', function () {
  const lite = JSON.parse(fs.readFileSync(LITE_PATH, 'utf8'));
  const dirty = lite.slice();
  dirty[0] = Object.assign({}, dirty[0], { description: '这是一段说明文字，只该出现在全量 topics.json 里。' });
  /* 复用与第 2 条相同的判据 */
  const bad = [];
  dirty.forEach(function (t, i) {
    Object.keys(t).forEach(function (k) { if (LITE_FIELDS.indexOf(k) < 0) bad.push('#' + i + ' 多了字段 ' + k); });
    HEAVY_FIELDS.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(t, k)) bad.push('#' + i + ' 含重字段 ' + k); });
  });
  assert.ok(bad.length > 0, '塞进 description 后判据没有报红 —— 上面的白名单测试是假的');
  /* 再确认 gzip 闸也会被这类塞法顶起来：把 description 全量塞回去，体积必须超过闸线的一半 */
  const allDirty = JSON.parse(fs.readFileSync(TOPICS_PATH, 'utf8')).map(function (t, i) {
    return i === 0 ? t : toLite(t);
  });
  const gzDiag = zlib.gzipSync(Buffer.from(JSON.stringify(allDirty, null, 0))).length;
  assert.ok(gzDiag > LITE_GZIP_LIMIT || gzDiag > zlib.gzipSync(fs.readFileSync(LITE_PATH)).length,
    '把大字段塞回去后 gzip 应明显变大，否则体积闸测不出问题');
});

console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
