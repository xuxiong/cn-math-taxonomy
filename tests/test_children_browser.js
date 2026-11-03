#!/usr/bin/env node
/* 备份恢复浏览器测试：node tests/test_children_browser.js
 * 需要 Node 22+ 和 Chrome/Chromium，可用 CHROME 指定浏览器路径，无 npm 依赖。
 * 使用临时浏览器资料和隔离存储，验证实际文件下载、上传选择、跨浏览器恢复与合并。
 * 测试服务器关闭统计钩子；下载、测试文件和截图均写入系统临时目录。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const guard = require('./lib/chrome-guard');
const { until } = require('./lib/wait');
const root = path.resolve(__dirname, '..');
/* 临时目录走 guard.tempDir：退出/被打断时只删这一个自己 mkdtemp 出来的目录 */
const out = guard.tempDir('cnm-backup-browser-');
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    /* 连接断开时把未完成请求全部 reject，避免 await 永远挂着（挂死会留下空转的 Chrome） */
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error(p.method + ": CDP 连接已关闭"));
      this.pending.clear();
    });
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(p.method + ": " + m.error.message)); else p.resolve(m.result);
      } else this.handlers.forEach(fn => fn(m));
    });
  }
  /* 25s 无响应上限：失败上限，不是性能断言 */
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error('CDP 无响应（25s 上限）: ' + method));
      }, 25000);
      this.pending.set(id, { method, resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}
const server = http.createServer((req, res) => {
  let file = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (file.endsWith('/')) file += 'index.html';
  if (file === '/assets/stats-config.js') { res.setHeader('Content-Type', 'text/javascript'); res.end('window.CNM_STATS = {};'); return; }
  const full = path.resolve(root, '.' + file);
  if (!full.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[path.extname(full)] || 'application/octet-stream');
    res.end(data);
  });
});

let chrome, source, target, browser;
(async () => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const chromePath = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && fs.existsSync(p));
  if (!chromePath) throw new Error('找不到 Chrome/Chromium，请设置 CHROME 环境变量');
  /* guard.launch：spawn 之后立刻登记 pid，失败路径也杀得掉 */
  chrome = guard.launch(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-extensions', '--disable-component-update',
    '--remote-debugging-port=0', '--user-data-dir=' + path.join(out, 'profile'), 'about:blank'
  ], { logFile: path.join(out, 'chrome.log') });
  const activePort = path.join(out, 'profile', 'DevToolsActivePort');
  await until(() => fs.existsSync(activePort), 'Chrome debugger');
  const port = fs.readFileSync(activePort, 'utf8').split('\n')[0];
  async function connect(targetId) {
    const tabs = await fetch('http://127.0.0.1:' + port + '/json').then(r => r.json());
    const tab = targetId ? tabs.find(t => t.id === targetId) : tabs.find(t => t.type === 'page');
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    return new CDP(ws);
  }
  source = await connect();
  const browserInfo = await fetch('http://127.0.0.1:' + port + '/json/version').then(r => r.json());
  const browserSocket = new WebSocket(browserInfo.webSocketDebuggerUrl);
  await new Promise((resolve,reject) => { browserSocket.addEventListener('open',resolve); browserSocket.addEventListener('error',reject); });
  browser = new CDP(browserSocket);
  const errors = [];
  async function initialize(cdp) {
    cdp.handlers.push(m => { if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails); });
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
    await cdp.send('Network.setBypassServiceWorker', { bypass: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  }
  await initialize(source);
  await source.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: out });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function page(cdp, pathname='/children/') {
    await cdp.send('Page.navigate', { url: base + pathname });
    await until(() => cdp.eval('document.readyState === "complete" && !!window.CnmChildren'), 'page load');
  }
  const snapshot = cdp => cdp.eval('({profiles:localStorage.getItem("cnmChildren.v1"),records:localStorage.getItem("cnmChildren.records.v1")})');
  async function choose(cdp, file) {
    const { root: document } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: document.nodeId, selector: '#import-backup' });
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [file] });
  }
  async function preview(file) {
    await choose(target, file);
    await until(() => target.eval('!document.getElementById("import-preview").hidden && !document.getElementById("confirm-import").disabled'), 'import preview');
  }
  async function confirm() {
    await target.eval('document.getElementById("confirm-import").click()');
    assert.ok(await target.eval('!document.getElementById("import-status").hidden && document.getElementById("import-status").textContent.includes("导入完成")'));
  }
  await page(source);
  assert.equal(await source.eval('document.getElementById("export-backup").disabled'), true);
  await source.eval(`(() => {
    CnmChildren.add({name:'小满',grade:'三年级',textbook:'人教版'});
    CnmChildren.add({name:'小禾',grade:'五年级',textbook:'沪教版'});
    const kids=CnmChildren.list(); CnmChildren.setCurrent(kids[1].id);
    ['math','chinese','english','physics'].forEach((subject,i) => {
      const id=['cnm_p001','cnc_p001','cne_p001','cnp_001'][i];
      CnmChildren.saveRecord(kids[0].id,{key:subject+'|seed|'+id,subject,label:'测试诊断 '+i,mode:'target',asked:8,targets:[id],
        counts:{weak:1,shaky:0,mastered:0,untested:0},weak:[id],roots:[id],shaky:[],mastered:[]});
    });
  })()`);
  await page(source);
  const original = await snapshot(source);
  await source.eval('document.getElementById("export-backup").click()');
  const filename = await until(() => fs.readdirSync(out).find(f => /^children-backup-.*\.json$/.test(f)), 'actual export download');
  const file = path.join(out, filename);
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(backup.profiles, JSON.parse(original.profiles));
  assert.deepStrictEqual(backup.records, JSON.parse(original.records));
  assert.deepStrictEqual(await snapshot(source), original);
  const { browserContextId } = await browser.send('Target.createBrowserContext');
  const { targetId } = await browser.send('Target.createTarget', { url:'about:blank', browserContextId });
  target = await connect(targetId); await initialize(target); await page(target);
  assert.deepStrictEqual(await snapshot(target), {profiles:null,records:null});
  await preview(file);
  assert.deepStrictEqual(await snapshot(target), {profiles:null,records:null});
  await target.eval('document.getElementById("cancel-import").click()');
  assert.deepStrictEqual(await snapshot(target), {profiles:null,records:null});
  await preview(file); await confirm();
  const restored=await snapshot(target);
  assert.deepStrictEqual(JSON.parse(restored.profiles),backup.profiles);
  assert.deepStrictEqual(JSON.parse(restored.records),backup.records);
  await page(target,'/children/history.html?child='+backup.profiles.children[0].id);
  await until(() => target.eval('document.querySelectorAll(".rec").length === 4'), 'four subjects in restored history');
  assert.equal(await target.eval('document.querySelectorAll(".wk-name").length'),4);
  await page(target);
  await preview(file); await confirm();
  assert.deepStrictEqual(await snapshot(target),restored);
  console.log('PASS: actual JSON download -> isolated browser context -> preview/cancel -> restore -> history/weak points -> idempotent reimport');

  await target.eval(`(() => {
    const p=JSON.parse(localStorage.getItem('cnmChildren.v1'));
    const r=JSON.parse(localStorage.getItem('cnmChildren.records.v1'));
    const first=p.children[0]; p.children=[{...first,grade:'六年级'}];
    localStorage.setItem('cnmChildren.v1',JSON.stringify({...p,current:first.id}));
    r[first.id]=[
      {...r[first.id][0],updatedAt:'2026-10-30T00:00:00.000Z',label:'保留本机较新结果'},
      {...r[first.id][1],savedAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z',label:'本机旧结果'},
      {...r[first.id][0],key:'local-only',label:'本机独有记录'}
    ];
    delete r[${JSON.stringify(backup.profiles.children[1].id)}];
    localStorage.setItem('cnmChildren.records.v1',JSON.stringify(r));
    CnmChildren.add({name:'小禾',grade:'二年级',textbook:'人教版'});
  })()`);
  await page(target); await preview(file);
  assert.ok(await target.eval('document.getElementById("import-children").textContent.includes("小禾（导入）")'));
  // 预览期间由另一页面修改当前孩子，确认必须先停下重新预览。
  await target.eval('CnmChildren.setCurrent(CnmChildren.list()[1].id)');
  const changed=await snapshot(target);
  await target.eval('document.getElementById("confirm-import").click()');
  assert.ok(await target.eval('document.getElementById("import-error").textContent.includes("重新预览")'));
  assert.deepStrictEqual(await snapshot(target),changed);
  await confirm();
  const merged=await snapshot(target);
  const mp=JSON.parse(merged.profiles), mr=JSON.parse(merged.records);
  assert.equal(mp.children.length,3); assert.equal(mp.current,JSON.parse(changed.profiles).current);
  assert.equal(mp.children[0].grade,'六年级');
  assert.equal(mp.children.find(c=>c.id===backup.profiles.children[1].id).name,'小禾（导入）');
  assert.equal(mr[backup.profiles.children[0].id].length,5);
  assert.equal(mr[backup.profiles.children[0].id][0].label,'保留本机较新结果');
  await preview(file); await confirm(); assert.deepStrictEqual(await snapshot(target),merged);
  console.log('PASS: preserve local profiles/current selection, rename same-name children, newest-record merge, stale preview, repeat merge');

  await preview(file);
  await target.send('Emulation.setDeviceMetricsOverride',{width:375,height:1100,deviceScaleFactor:1,mobile:true});
  assert.equal(await target.eval('document.documentElement.scrollWidth <= innerWidth'),true);
  fs.writeFileSync(path.join(out, 'backup-mobile.png'),Buffer.from((await target.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await target.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});
  fs.writeFileSync(path.join(out, 'backup-dark.png'),Buffer.from((await target.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await target.send('Emulation.setDeviceMetricsOverride',{width:1280,height:1100,deviceScaleFactor:1,mobile:false});
  await target.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
  fs.writeFileSync(path.join(out, 'backup-desktop.png'),Buffer.from((await target.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await target.eval(`window.__originalSet=Storage.prototype.setItem; Storage.prototype.setItem=function(k,v){
    if(k==='cnmChildren.v1')throw new DOMException('Quota','QuotaExceededError'); return window.__originalSet.call(this,k,v);
  };document.getElementById('confirm-import').click();`);
  assert.ok(await target.eval('document.getElementById("import-error").textContent.includes("原有档案和记录未改变")'));
  assert.deepStrictEqual(await snapshot(target),merged);
  await target.eval('Storage.prototype.setItem=window.__originalSet');
  for(const [name,text] of [['broken.json','{broken'],['version.json',JSON.stringify({...backup,version:2})],['large.json',' '.repeat(10*1024*1024+1)]]){
    const bad=path.join(out,name); fs.writeFileSync(bad,text); await choose(target,bad);
    await until(()=>target.eval('!document.getElementById("import-error").hidden'),'invalid file error');
    assert.deepStrictEqual(await snapshot(target),merged);
  }
  assert.deepStrictEqual(errors,[]);
  console.log('PASS: quota-failure rollback, malformed/unknown-version/oversized files, 375px layout and light/dark themes; no page exceptions');
  console.log('Downloads and fixtures: '+out);
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{
  if(browser)browser.ws.close();if(target)target.ws.close();if(source)source.ws.close();if(chrome)guard.kill(chrome);
  await new Promise(resolve=>server.close(resolve));
});
