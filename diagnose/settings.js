/* 模型设置页（家长入口）：写入 localStorage['cnmDiagnose.llm']，供 diagnose 页面直连百炼。
 *
 * 安全红线：
 *   - key 只出现在 password 输入框的 value 和 Authorization 头里；
 *   - 不 console.log / console.error key，不把 key 写进 URL（含 fetch query string）；
 *   - 不进 DOM 文本；界面上只显示 maskKey() 的结果。
 *
 * 地址与型号一律从 window.LLMConfig.PRESETS 读，本文件不写任何服务地址字面量。
 */
(function () {
  'use strict';

  var CFG = (typeof LLMConfig !== 'undefined' && LLMConfig) ? LLMConfig : null;

  function $(id) { return document.getElementById(id); }

  var presetLabel = $('preset-label');
  var modelSelect = $('model-select');
  var keyInput = $('api-key');
  var toggleBtn = $('toggle-key');
  var testBtn = $('test-btn');
  var saveBtn = $('save-btn');
  var savedLine = $('saved-line');
  var savedTail = $('saved-tail');
  var clearBtn = $('clear-btn');
  var baseInput = $('base-input');
  var customModel = $('custom-model');
  var statusEl = $('status');

  var PRESET = (CFG && CFG.PRESETS && CFG.PRESETS.dashscope) || null;

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = String(msg == null ? '' : msg);
  }

  /** testConnection 专用：在原状态串后追加模型标注块 + 尾注。
   *  只在 testConnection 内部使用 —— doSave / doClear / fillPreset 等非测试场景仍走 setStatus，
   *  避免「已保存，正在返回…」这种与测试无关的状态串里冒出「本次测试的模型」造成措辞错乱。 */
  function setTestStatus(msg) {
    setStatus(String(msg == null ? '' : msg) + '\n' + buildModelAnnotation());
  }

  /** 生成「模型标注块」（TASK-fix403 第 3 项）：
   *  - 第一行：本次测试的模型（表单当前值，currentModel()）
   *  - 第二行：已保存的模型（CFG.getConfig().model）；拿不到时写「（未保存，讲解会用默认 <defaultModel>）」
   *  - 不一致时再追加一行警告（真实讲解用的是已保存的 <Y>）
   *  - 最末尾固定追加尾注「测试只验证能连通，不验证讲解速度。」
   *  型号名只从 CFG 读，不在本文件写死型号字面量（静态扫描禁止型号/百炼地址字面量）。
   *  默认型号取 CFG.defaultModel（常量，不随保存/清除变化）而非 CFG.model（模块加载时的快照，
   *  家长点「清除」后不刷新页面时 CFG.model 仍是旧值，会显示错的默认名）。 */
  function buildModelAnnotation() {
    var cur = currentModel();
    var saved = null;
    try {
      var cfg = CFG && typeof CFG.getConfig === 'function' ? CFG.getConfig() : null;
      if (cfg && typeof cfg.model === 'string' && cfg.model) saved = cfg.model;
    } catch (e) { saved = null; }

    var lines = [];
    lines.push('本次测试的模型：' + cur);
    if (saved) {
      lines.push('已保存的模型：' + saved);
      if (cur !== saved) {
        lines.push('本次测试的模型和已保存的不一致 —— 真实讲解用的是已保存的 ' + saved + '，请保存后再测一次。');
      }
    } else {
      var defaultName = (CFG && CFG.defaultModel) ? CFG.defaultModel : ((CFG && CFG.model) ? CFG.model : '');
      lines.push('已保存的模型：（未保存，讲解会用默认 ' + defaultName + '）');
    }
    lines.push('测试只验证能连通，不验证讲解速度。');
    return lines.join('\n');
  }

  function errText(e) {
    if (!e) return '未知错误';
    var name = e.name ? String(e.name) : '';
    var msg = e.message != null ? String(e.message) : String(e);
    return name && msg.indexOf(name) !== 0 ? name + ': ' + msg : msg;
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function currentBase() {
    var raw = baseInput ? String(baseInput.value || '') : '';
    raw = raw.replace(/\/+$/, '');
    if (raw) return raw;
    return PRESET ? PRESET.base : '';
  }

  function currentModel() {
    var custom = customModel ? String(customModel.value || '').replace(/^\s+|\s+$/g, '') : '';
    if (custom) return custom;
    return modelSelect ? String(modelSelect.value || '') : '';
  }

  /** 15s 超时：优先 AbortSignal.timeout，其次 AbortController + setTimeout。 */
  function timeoutSignal() {
    try {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(15000);
      }
    } catch (e) { /* 落到 AbortController */ }
    try {
      if (typeof AbortController !== 'undefined') {
        var ac = new AbortController();
        setTimeout(function () { try { ac.abort(); } catch (e) { /* ignore */ } }, 15000);
        return ac.signal;
      }
    } catch (e) { /* 不支持就无 signal */ }
    return undefined;
  }

  async function readBody(res, max) {
    try {
      return truncate(await res.text(), max);
    } catch (e) {
      return '（读取响应正文失败：' + errText(e) + '）';
    }
  }

  /** 读完整正文（不截断），供 JSON.parse 使用；只在展示给用户时才 truncate。 */
  async function readFull(res) {
    try {
      return { ok: true, text: await res.text() };
    } catch (e) {
      return { ok: false, text: '（读取响应正文失败：' + errText(e) + '）' };
    }
  }

  function fillPreset() {
    if (!PRESET) {
      setStatus('配置模块 llm-config.js 未加载或没有可用预设，无法设置。');
      if (testBtn) testBtn.disabled = true;
      if (saveBtn) saveBtn.disabled = true;
      return;
    }
    if (presetLabel) presetLabel.textContent = PRESET.label;

    var models = PRESET.altModels && PRESET.altModels.length ? PRESET.altModels : [PRESET.model];
    if (modelSelect) {
      modelSelect.innerHTML = '';
      for (var i = 0; i < models.length; i++) {
        var opt = document.createElement('option');
        opt.value = models[i];
        opt.textContent = models[i];
        modelSelect.appendChild(opt);
      }
      modelSelect.value = PRESET.model;
    }
    if (baseInput) baseInput.value = PRESET.base;
  }

  function prefillSaved() {
    if (!CFG || typeof CFG.getConfig !== 'function') return;
    var cfg = null;
    try { cfg = CFG.getConfig(); } catch (e) { cfg = null; }
    if (!cfg) return;

    if (baseInput) baseInput.value = cfg.base;
    if (keyInput) keyInput.value = cfg.key;
    if (modelSelect && cfg.model) {
      var found = false;
      for (var i = 0; i < modelSelect.options.length; i++) {
        if (modelSelect.options[i].value === cfg.model) { found = true; break; }
      }
      if (found) modelSelect.value = cfg.model;
      else if (customModel) customModel.value = cfg.model;
    }
    if (savedTail) savedTail.textContent = CFG.maskKey(cfg.key);
    if (savedLine) savedLine.hidden = false;
  }

  async function testConnection() {
    if (!CFG || !PRESET) { setTestStatus('配置模块未加载，无法测试。'); return; }

    var base = currentBase();
    var key = keyInput ? String(keyInput.value || '') : '';
    var model = currentModel();

    if (!base) { setTestStatus('基址为空，请先在「高级（家长）」里填写。'); return; }
    if (!key) { setTestStatus('请先填入 API Key 再测试。'); return; }
    if (!model) { setTestStatus('模型为空，请先选择或填写模型。'); return; }

    var auth = { Authorization: 'Bearer ' + key };
    var modelsUrl = base + '/models';

    setTestStatus('正在测试第 1 步：GET ' + modelsUrl + ' …');
    var res1;
    try {
      res1 = await fetch(modelsUrl, { method: 'GET', headers: auth, signal: timeoutSignal() });
    } catch (e) {
      setTestStatus('第 1 步 GET ' + modelsUrl + ' 请求失败：' + errText(e));
      return;
    }

    if (!res1.ok) {
      var badBody = await readBody(res1, 300);
      setTestStatus('第 1 步 GET ' + modelsUrl + ' 返回 HTTP ' + res1.status + '\n' + badBody);
      return;
    }

    var read1 = await readFull(res1);
    if (!read1.ok) {
      setTestStatus('第 1 步 GET ' + modelsUrl + ' 返回 HTTP ' + res1.status + '，' + read1.text);
      return;
    }
    var body1 = read1.text;
    var data1 = null;
    try { data1 = JSON.parse(body1); } catch (e) { data1 = null; }
    if (!data1) {
      setTestStatus('第 1 步 GET ' + modelsUrl + ' 返回 HTTP 200，但响应不是 JSON：\n' + truncate(body1, 300));
      return;
    }
    var list = (data1 && Array.isArray(data1.data)) ? data1.data
      : (data1 && Array.isArray(data1.models)) ? data1.models
        : Array.isArray(data1) ? data1 : null;
    if (!list) {
      setTestStatus('第 1 步 GET ' + modelsUrl + ' 返回 HTTP 200，但没列出模型：\n' + truncate(body1, 300));
      return;
    }

    var chatUrl = base + '/chat/completions';
    setTestStatus('第 1 步通过（' + list.length + ' 个模型）。\n正在测试第 2 步：POST ' + chatUrl + ' （模型 ' + model + '）…');
    var started = (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
    var res2;
    try {
      res2 = await fetch(chatUrl, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: '只回复两个字：通了' }],
          max_tokens: 64
        }),
        signal: timeoutSignal()
      });
    } catch (e) {
      setTestStatus('第 1 步通过（' + list.length + ' 个模型）。\n第 2 步 POST ' + chatUrl + ' 请求失败：' + errText(e));
      return;
    }

    var elapsed = (typeof Date !== 'undefined' && Date.now) ? (Date.now() - started) : 0;
    var read2 = await readFull(res2);
    if (!read2.ok) {
      setTestStatus('第 1 步通过（' + list.length + ' 个模型）。\n第 2 步 POST ' + chatUrl + ' 返回 HTTP ' + res2.status + '，' + read2.text);
      return;
    }
    var body2 = read2.text;
    if (!res2.ok) {
      setTestStatus('第 1 步通过（' + list.length + ' 个模型）。\n第 2 步 POST ' + chatUrl + ' 返回 HTTP ' + res2.status + '\n' + truncate(body2, 300));
      return;
    }

    var data2 = null;
    try { data2 = JSON.parse(body2); } catch (e) { data2 = null; }
    if (!data2) {
      setTestStatus('第 1 步通过（' + list.length + ' 个模型）。\n第 2 步返回 HTTP 200，但响应不是 JSON：\n' + truncate(body2, 300));
      return;
    }
    var choice = data2.choices && data2.choices[0];
    var msg = choice && choice.message;
    var content = msg && msg.content != null ? String(msg.content) : '';
    var finish = choice && choice.finish_reason != null ? String(choice.finish_reason) : '（无）';

    setTestStatus('连接成功。\n'
      + '第 1 步：GET ' + modelsUrl + ' → HTTP ' + res1.status + '，' + list.length + ' 个模型\n'
      + '第 2 步：POST ' + chatUrl + ' → HTTP ' + res2.status + '，耗时 ' + elapsed + ' ms\n'
      + '回复：' + (content || '（空）') + '\n'
      + 'finish_reason：' + finish);
  }

  function doSave() {
    if (!CFG || !PRESET || typeof CFG.saveConfig !== 'function') {
      setStatus('配置模块未加载，无法保存。');
      return;
    }
    var key = keyInput ? String(keyInput.value || '') : '';
    if (!key.replace(/^\s+|\s+$/g, '')) {
      setStatus('请先填入 API Key 再保存。');
      return;
    }
    var ok = CFG.saveConfig({ base: currentBase(), model: currentModel(), key: key });
    if (!ok) {
      setStatus('保存失败：浏览器拒绝了本地存储（可能是隐私模式或空间不足）。');
      return;
    }
    if (savedTail) savedTail.textContent = CFG.maskKey(key);
    if (savedLine) savedLine.hidden = false;
    setStatus('已保存，正在返回…');
    setTimeout(function () { location.href = 'index.html'; }, 500);
  }

  function doClear() {
    if (CFG && typeof CFG.clearConfig === 'function') CFG.clearConfig();
    if (keyInput) keyInput.value = '';
    if (savedTail) savedTail.textContent = '';
    if (savedLine) savedLine.hidden = true;
    setStatus('已清除，已回到默认配置。');
  }

  function toggleKey() {
    if (!keyInput || !toggleBtn) return;
    var showing = keyInput.type === 'text';
    keyInput.type = showing ? 'password' : 'text';
    toggleBtn.textContent = showing ? '显示' : '隐藏';
  }

  fillPreset();
  prefillSaved();

  if (toggleBtn) toggleBtn.addEventListener('click', toggleKey);
  if (testBtn) testBtn.addEventListener('click', function () { testConnection(); });
  if (saveBtn) saveBtn.addEventListener('click', doSave);
  if (clearBtn) clearBtn.addEventListener('click', doClear);
})();
