#!/usr/bin/env node
/* 浏览器侧模块依赖接线单测：node tests/test_browser_module_wiring.js
 * 零依赖、零网络、零 LLM。
 *
 * 为什么需要这个文件：其余套件全在 Node 里 require('../diagnose/construct.js')，
 * 而 construct.js 的 Node 分支自己 require('./construct-num.js')，依赖天然齐全 ——
 * 浏览器侧只认 app.js 里那份 LAZY_CONSTRUCT 字符串清单，没有任何测试按它加载过。
 * 卡1 漏把 construct-num.js 写进清单时，全量套件依然全绿，而线上的算术点必然不出题。
 *
 * 口径：
 *   1. LAZY_CONSTRUCT 只作「浏览器会按什么顺序加载」的**输入**（从 app.js 源码解析），
 *      断言本身是行为断言，不是读源码比对；
 *   2. 在 vm 沙箱里 self=window=ctx，按该数组顺序逐个 runInContext，
 *      **不 require、不手动补任何模块**（补了就等于替浏览器把依赖接上了，测不出漏洞）；
 *   3. 被测点集不写死：从 data/gen-plan.json 动态读出 strategy=construct && verifier=arithmetic
 *      的全部 topicId，逐个出题并过 gate。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DIAG = path.join(ROOT, 'diagnose');
const PLAN = path.join(ROOT, 'data', 'gen-plan.json');

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; return true; }
  failures.push(msg);
  return false;
}

/* ---------------------------------------------------------------- 输入 1：加载清单 */

/** 从 app.js 源码里解析出 LAZY_CONSTRUCT 数组（只取字符串字面量，保持声明顺序）。 */
function lazyConstructFiles() {
  const src = fs.readFileSync(path.join(DIAG, 'app.js'), 'utf8');
  const decl = /const\s+LAZY_CONSTRUCT\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!decl) return { files: null, why: 'diagnose/app.js 里找不到 LAZY_CONSTRUCT 数组声明' };
  const files = [];
  const lit = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = lit.exec(decl[1])) !== null) files.push(m[1]);
  if (!files.length) return { files: null, why: 'LAZY_CONSTRUCT 数组里没有解析出任何文件名' };
  return { files: files, why: null };
}

/** 按浏览器的方式加载：self=window=ctx，顺序照清单，runInContext 而不是 require。 */
function loadAsBrowser(files) {
  const sandbox = { console: { log: function () {}, warn: function () {}, error: function () {} } };
  /* 必须在 createContext 之前挂上：模块取的是 `typeof self !== 'undefined' ? self : this`，
   * 而 root.DiagXxx 必须落在同一份全局上，后面才读得到。 */
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  files.forEach(function (f) {
    const p = path.join(DIAG, f);
    if (!fs.existsSync(p)) {
      failures.push('app.js 声明的懒加载文件不存在：' + f + '（' + p + '）');
      return;
    }
    vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: p });
  });
  return sandbox;
}

/* ---------------------------------------------------------------- 被测点集（不写死） */

function arithTopicIds() {
  const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
  return plan.nodes
    .filter(function (n) { return n.strategy === 'construct' && n.verifier === 'arithmetic'; })
    .map(function (n) { return n.topicId; });
}

/* ---------------------------------------------------------------- 主体 */

function main() {
  console.log('== 浏览器侧模块依赖接线（LAZY_CONSTRUCT 按 app.js 声明加载） ==');

  const decl = lazyConstructFiles();
  console.log('LAZY_CONSTRUCT = [' + (decl.files || []).join(', ') + ']');
  if (!ok(decl.files !== null, decl.why || '解析 LAZY_CONSTRUCT 失败')) return;

  const ctx = loadAsBrowser(decl.files);

  /* 断言 1：数值层与构造器都到货，且构造器自报数值层可用。 */
  ok(typeof ctx.DiagConstructNum === 'object' && ctx.DiagConstructNum !== null,
    '浏览器侧 window.DiagConstructNum 未定义：construct-num.js 没有被 LAZY_CONSTRUCT 加载（' +
    'typeof = ' + typeof ctx.DiagConstructNum + '）');
  ok(ctx.DiagConstruct && typeof ctx.DiagConstruct === 'object',
    '浏览器侧 window.DiagConstruct 未定义：construct.js 没有被加载');

  const C = ctx.DiagConstruct;
  ok(!!C && typeof C.numReady === 'function' && C.numReady() === true,
    '浏览器侧 DiagConstruct.numReady() 不是 true（实际 ' +
    (C && typeof C.numReady === 'function' ? String(C.numReady()) : 'numReady 不可调用') +
    '）：构造器拿到的数值层是空的');

  if (!C || typeof C.genConstruct !== 'function') {
    failures.push('浏览器侧 DiagConstruct.genConstruct 不可调用，后续行为断言无法进行');
    return;
  }

  /* 断言 2 + 3：全部算术点逐个出题（点集从 gen-plan.json 动态读，数量不写死）。 */
  const tids = arithTopicIds();
  console.log('gen-plan.json 里 strategy=construct && verifier=arithmetic 的点：' + tids.length + ' 个');
  ok(tids.length > 0, 'data/gen-plan.json 里读不出任何 construct/arithmetic 点（判据失效）');

  let produced = 0;
  tids.forEach(function (tid) {
    let q = null;
    try {
      q = C.genConstruct(tid, 0, { seed: 7 });
    } catch (e) {
      failures.push(tid + '：genConstruct 抛错 —— ' + (e && e.message ? e.message : String(e)));
      return;
    }
    if (!ok(q !== null && q !== undefined, tid + '：genConstruct 返回空（浏览器侧出不了题，线上会落进 construct-exhausted）')) return;
    ok(typeof q.prompt === 'string' && q.prompt.length > 0,
      tid + '：题面 prompt 为空');
    ok(typeof q.answer === 'string' && q.answer.length > 0,
      tid + '：答案 answer 为空（实际 ' + JSON.stringify(q.answer) + '）');
    let bad = 'gate-threw';
    try {
      bad = C.gate(q);
    } catch (e) {
      failures.push(tid + '：gate(q) 抛错 —— ' + (e && e.message ? e.message : String(e)));
      return;
    }
    ok(!bad, tid + '：gate(q) 未通过，违例 ' + JSON.stringify(bad));
    /* 断言 3：必须真的是算术族（防这个测试退化成「只要构造器能出题就算过」）。 */
    ok(q.constructFamily === 'arithmetic',
      tid + '：constructFamily 不是 arithmetic（实际 ' + JSON.stringify(q.constructFamily) + '）');
    produced++;
  });

  console.log('实际出题并过 gate 的点：' + produced + '/' + tids.length);
  /* 每个点都必须出题：不让「读到 N 个点、只有前几个成功」蒙混过关。 */
  ok(produced === tids.length, '有 ' + (tids.length - produced) + ' 个算术点没能在浏览器侧出题');
}

main();

if (failures.length) {
  console.error('\n失败 ' + failures.length + ' 项（通过 ' + passed + ' 项）：');
  failures.forEach(function (f, i) { console.error('  ' + (i + 1) + ') ' + f); });
  process.exitCode = 1;
} else {
  console.log('\n全部通过：' + passed + ' 项断言');
  process.exitCode = 0;
}
