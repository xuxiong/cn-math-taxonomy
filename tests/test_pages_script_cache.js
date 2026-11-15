#!/usr/bin/env node
/* Pages 发布口径测试 —— 板主 2026-11-14 裁定后：`scripts/deploy-cf.sh` 保持删除，Pages 交给 CI 工作流。
 * 原文件里的脚本执行类用例（假 npx / 缓存目录 / 上传白名单）全部以脚本为被测对象，脚本已删即无处可测，
 * 因此按裁定只保留「脚本已删且仓库无残留引用」这一组判据；不删测试文件，也不放宽任何既有断言。 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/deploy-cf.sh');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    process.exitCode = 1;
    console.log('  FAIL ' + name);
    console.log('       ' + (e && e.message ? e.message : e));
  }
}
function walk(dir, out) {
  const acc = out || [];
  if (!fs.existsSync(dir)) return acc;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, acc);
    else acc.push(p);
  });
  return acc;
}

test('scripts/deploy-cf.sh 已按裁定删除', function () {
  assert.strictEqual(fs.existsSync(SCRIPT), false, 'scripts/deploy-cf.sh 仍存在：Pages 部署已改由 CI 工作流负责');
});

test('CI 工作流不调用 deploy-cf.sh', function () {
  const files = walk(WORKFLOWS).filter(function (f) { return /\.ya?ml$/.test(f); });
  assert.ok(files.length > 0, '.github/workflows/ 下没有任何工作流文件');
  files.forEach(function (f) {
    assert.strictEqual(fs.readFileSync(f, 'utf8').indexOf('deploy-cf.sh'), -1,
      path.relative(ROOT, f) + ' 仍在调用已删除的 deploy-cf.sh');
  });
});

test('package.json 脚本与其他 shell 脚本都不引用 deploy-cf.sh', function () {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const scripts = pkg.scripts || {};
  Object.keys(scripts).forEach(function (k) {
    assert.strictEqual(String(scripts[k]).indexOf('deploy-cf.sh'), -1, 'package.json scripts.' + k + ' 仍在调用 deploy-cf.sh');
  });
  walk(path.join(ROOT, 'scripts')).filter(function (f) { return /\.sh$/.test(f); }).forEach(function (f) {
    assert.strictEqual(fs.readFileSync(f, 'utf8').indexOf('deploy-cf.sh'), -1,
      path.relative(ROOT, f) + ' 仍在调用已删除的 deploy-cf.sh');
  });
});

test('文档仍保留 wrangler 缓存目录口径（可写目录；不许 sudo / chmod 777）', function () {
  const docs = ['CHANGELOG.md', 'DEPLOY.md', 'README.md'].map(function (n) { return path.join(ROOT, n); })
    .filter(function (p) { return fs.existsSync(p); });
  assert.ok(docs.length > 0, '缺少 CHANGELOG/README 等文档');
  assert.ok(docs.some(function (p) { return fs.readFileSync(p, 'utf8').indexOf('WRANGLER_CACHE_DIR') >= 0; }),
    '没有任何文档记录 WRANGLER_CACHE_DIR：缓存目录不可写会让发布在 CI 上再次失败');
});

console.log('\n' + passed + ' passed');
