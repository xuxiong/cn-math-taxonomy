#!/usr/bin/env node
/* 学生可见文案的渲染层不变量（t_31414d0d）：node tests/test_funclab_notes.js
 *
 * 背景：画板下方的说明文案走的是 `note.textContent = ...`（不解析 Markdown），
 * 文案里写 `**强调**` 学生看到的就是字面星号。批1 起 NOTE_INTENT 里就混进了这种
 * 强调符（quadratic-vertex 的「顶点坐标」等，基点 d155a60 已存在），批4 的 E2E
 * 把它暴露出来。本文件把「学生可见文案零 **」做成机器判据，防止再写回去。
 *
 * 判据范围 = 真会被渲染/读到的文案：
 *   1. NOTE_INTENT 全部模板（画板下方 note）；
 *   2. CAPABILITIES[*].note（能力清单里的画板说明）；
 *   3. NOTE_BY_INTENT 旧兼容视图（旧测试/外部脚本读的那张表）；
 *   4. noteText() 实际产出的文案（含多曲线「无交点」兜底分支）。
 * 不在范围内：源码注释、CAPABILITIES[*].paramsDoc（喂 LLM 的提示词，不是学生文案）。
 */
'use strict';
const assert = require('assert');
const F = require('../diagnose/funclab.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 6).join('\n       ')); }
}

const HINT = '（渲染层是 textContent，不解析 Markdown，学生看到的就是字面 **）';

function assertNoStar(label, text) {
  assert.ok(text != null && String(text).trim(), label + ' 文案为空');
  assert.ok(String(text).indexOf('**') < 0, label + ' 出现 **' + HINT + '：' + text);
}

console.log('\n--- 1. 静态模板：NOTE_INTENT / CAPABILITIES.note / NOTE_BY_INTENT 零 ** ---');

test('NOTE_INTENT 全部画板 × 全部 intent 零 **', function () {
  const labs = Object.keys(F.NOTE_INTENT);
  assert.ok(labs.length >= 21, 'NOTE_INTENT 画板数应 ≥21，实际 ' + labs.length);
  labs.forEach(function (lab) {
    Object.keys(F.NOTE_INTENT[lab]).forEach(function (it) {
      assertNoStar(lab + ' / ' + it, F.NOTE_INTENT[lab][it]);
    });
  });
});

test('CAPABILITIES 全部画板的 note 零 **', function () {
  const labs = Object.keys(F.CAPABILITIES);
  assert.ok(labs.length >= 21, 'CAPABILITIES 画板数应 ≥21，实际 ' + labs.length);
  labs.forEach(function (lab) {
    assertNoStar(lab + ' / note', F.CAPABILITIES[lab].note);
  });
});

test('NOTE_BY_INTENT 旧兼容视图零 **', function () {
  Object.keys(F.NOTE_BY_INTENT).forEach(function (it) {
    assertNoStar('NOTE_BY_INTENT[' + it + ']', F.NOTE_BY_INTENT[it]);
  });
});

console.log('\n--- 2. 实际产出的 noteText 零 ** ---');

test('每个 (画板, canAnswer intent) 的 noteText 输出零 **', function () {
  Object.keys(F.CAPABILITIES).forEach(function (lab) {
    F.capabilityIntents(lab).forEach(function (it) {
      const t = F.noteText(lab, it, {});
      assertNoStar(lab + ' / ' + it + ' → noteText', t);
    });
  });
});

test('多曲线「无交点」兜底分支零 **（图上不标交点时走这条）', function () {
  const parallel = [{ type: 'linear', k: 1, b: 1 }, { type: 'linear', k: 1, b: 3 }];
  const t = F.noteText('two-curves-intersect', '两条曲线的交点坐标', { curves: parallel });
  assert.ok(t && t.indexOf('它们有几个公共点') >= 0, '没有走到无交点兜底分支：' + t);
  assertNoStar('two-curves-intersect 无交点兜底', t);
});

console.log('\n--- 3. 卡面点名的 quadratic-vertex「顶点坐标」 ---');

test('顶点坐标文案：问句形态保留、强调符去掉', function () {
  const t = F.NOTE_INTENT['quadratic-vertex']['顶点坐标'];
  assertNoStar('quadratic-vertex / 顶点坐标', t);
  assert.ok(t.indexOf('你能读出它的横、纵坐标是多少吗？') >= 0, '问句形态被改掉了：' + t);
  assert.ok(t.indexOf('红色是抛物线的顶点') >= 0, '文案开头被改掉了：' + t);
  /* 实际渲染路径也要干净：顶点坐标题挂的就是这条模板 */
  assertNoStar('noteText(quadratic-vertex, 顶点坐标)',
    F.noteText('quadratic-vertex', '顶点坐标', { a: 1, h: 2, k: -4 }));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
