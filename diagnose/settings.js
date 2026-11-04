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

  /** HTTP 状态码 → 一句人话，拼在「返回 HTTP <status>」之后，让英文正文前面先有句能看懂的。 */
  function httpHint(status) {
    if (status === 401) return ' —— 可能 API Key 不对或已失效';
    if (status === 403) return ' —— 可能没有权限，或额度已用完';
    if (status === 404) return ' —— 这个基址上找不到该接口，检查基址是否少了或少了一段（比如 /v1）';
    if (status === 429) return ' —— 请求太频繁，或额度已用完';
    if (status >= 500 && status < 600) return ' —— 服务端出错，不是你的配置问题，稍后再试';
    return '';
  }

  /** 报错时显示 fetch 实际解析后的真实 URL（res.url）：
   *  基址写成全角冒号等错误时，请求根本没到填写的地址（被当相对路径解析到本站），必须让家长看出来。 */
  function actualUrlNote(res, requested) {
    var u = (res && res.url) ? String(res.url) : '';
    if (!u) return '';                       // 拿不到就不硬编
    var out = '真实请求：' + u;
    if (u !== String(requested)) out += '\n（和填写的地址不一致 —— 基址写错了，注意别用中文输入法打冒号）';
    return out;
  }

  /** 网络层错误特征：浏览器断网 / CORS 被拦时 fetch 抛 TypeError: Failed to fetch。 */
  function isNetworkErrorLike(e) {
    if (!e) return false;
    if (String(e.name || '') === 'TypeError') return true;
    var msg = String(e.message == null ? e : e.message);
    return msg.indexOf('Failed to fetch') >= 0;
  }

  /** 超时特征：timeoutSignal() 到 15s 会 abort，fetch 抛 AbortError / TimeoutError ——
   *  此时请求其实已经发出、只是没等到回应，不能说「没有发出去」。
   *  兜底匹配 message（老浏览器 / 不同措辞，如 abort() 的 "The operation was aborted"）。 */
  function isTimeoutLike(e) {
    if (!e) return false;
    var name = String(e.name || '');
    if (name === 'AbortError' || name === 'TimeoutError') return true;   // AbortSignal.timeout / AbortController.abort
    var msg = String(e.message == null ? e : e.message);
    return /aborted|timeout|timed out/i.test(msg);                        // 兜底：老浏览器 / 不同措辞
  }

  /** fetch 抛错时的一句人话，第 1 步 / 第 2 步共用：
   *  超时 = 请求已发出但 15 秒没等到回应（查网络 / 换端点）；其余 = 请求根本没发出去（查基址）。 */
  function sendFailureLine(e) {
    if (isTimeoutLike(e)) return '请求发出去了，但 15 秒内没有回应（超时）—— 检查网络，或换个端点再试。';
    return '请求没有发出去（未到达任何服务器）。';
  }

  function pageOrigin() {
    try {
      if (typeof location === 'undefined' || !location || !location.href) return null;
      var u = new URL(location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;   // file:// 也算拿不到
      return u.origin;
    } catch (e) { return null; }
  }

  function isCrossOriginTarget(url) {
    try {
      var u = new URL(String(url));                 // 必须是绝对地址；相对地址 new URL 会抛
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      var origin = pageOrigin();                    // null = 拿不到本页地址（Node 测试环境 / file://）
      return origin ? u.origin !== origin : true;   // 拿不到本页地址时，绝对 http(s) 目标一律当跨域
    } catch (e) { return false; }
  }

  /* 只写「标准 dashscope 端点」和路径段，不写完整域名（静态扫描禁百炼地址字面量）。 */
  var CORS_HINT = '该端点可能不支持浏览器直连（CORS），请换用标准 dashscope 端点（…/compatible-mode/v1）。';

  /** 归一化基址：去首尾空白类字符，中文输入法全角标点（：／）→ 半角，去尾部斜杠。 */
  function normalizeBase(raw) {
    var s = String(raw == null ? '' : raw);
    // 首尾：普通空白、零宽字符(U+200B/200C/200D)、BOM(U+FEFF)、不换行空格(U+00A0)、全角空格(U+3000)
    s = s.replace(/^[\s\u200b\u200c\u200d\ufeff\u00a0\u3000]+/, '')
      .replace(/[\s\u200b\u200c\u200d\ufeff\u00a0\u3000]+$/, '');
    // 中文输入法全角标点 → 半角
    s = s.replace(/\uff1a/g, ':').replace(/\uff0f/g, '/');
    // 沿用原 currentBase 的行为：去尾部斜杠
    s = s.replace(/\/+$/, '');
    return s;
  }

  function currentBase() {
    var base = normalizeBase(baseInput ? baseInput.value : '');
    if (!base) base = PRESET ? PRESET.base : '';
    /* 归一化/回退结果与原值不同时写回输入框，让家长看到被修正的结果（doSave 调用同样受益）。 */
    if (baseInput && String(baseInput.value) !== base) baseInput.value = base;
    return base;
  }

  /** 是否为绝对 http(s) 地址（含 host）。相对地址、全角冒号地址都会在这里被拦下。 */
  function isAbsoluteHttpUrl(s) {
    s = String(s == null ? '' : s);
    if (!/^https?:\/\//i.test(s)) return false;
    try {
      var u = new URL(s);
      return !!u.host && (u.protocol === 'http:' || u.protocol === 'https:');
    } catch (e) { return false; }
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
    if (!isAbsoluteHttpUrl(base)) {
      setTestStatus('基址要以 https:// 开头（形如 https://<域名>/compatible-mode/v1）。现在填的是：' + base + '\n请求没有发出去。');
      return;
    }
    if (!key) { setTestStatus('请先填入 API Key 再测试。'); return; }
    if (!model) { setTestStatus('模型为空，请先选择或填写模型。'); return; }

    var auth = { Authorization: 'Bearer ' + key };
    var modelsUrl = base + '/models';
    var step1Prefix = '第 1 步 GET ' + modelsUrl;

    setTestStatus('正在测试第 1 步：GET ' + modelsUrl + ' …');
    var res1;
    try {
      res1 = await fetch(modelsUrl, { method: 'GET', headers: auth, signal: timeoutSignal() });
    } catch (e) {
      setTestStatus([
        step1Prefix + ' 请求失败：' + errText(e),
        sendFailureLine(e),
        (isNetworkErrorLike(e) && isCrossOriginTarget(modelsUrl)) ? CORS_HINT : ''
      ].filter(Boolean).join('\n'));
      return;
    }

    if (!res1.ok) {
      var badBody = await readBody(res1, 300);
      setTestStatus([
        step1Prefix + ' 返回 HTTP ' + res1.status + httpHint(res1.status),
        '服务端原文：' + badBody,
        actualUrlNote(res1, modelsUrl)
      ].filter(Boolean).join('\n'));
      return;
    }

    var read1 = await readFull(res1);
    if (!read1.ok) {
      setTestStatus([
        step1Prefix + ' 返回 HTTP ' + res1.status + '，' + read1.text,
        actualUrlNote(res1, modelsUrl)
      ].filter(Boolean).join('\n'));
      return;
    }
    var body1 = read1.text;
    var data1 = null;
    try { data1 = JSON.parse(body1); } catch (e) { data1 = null; }
    if (!data1) {
      setTestStatus([
        step1Prefix + ' 返回 HTTP 200，但响应不是 JSON：',
        truncate(body1, 300),
        actualUrlNote(res1, modelsUrl)
      ].filter(Boolean).join('\n'));
      return;
    }
    var list = (data1 && Array.isArray(data1.data)) ? data1.data
      : (data1 && Array.isArray(data1.models)) ? data1.models
        : Array.isArray(data1) ? data1 : null;
    if (!list) {
      setTestStatus([
        step1Prefix + ' 返回 HTTP 200，但没列出模型：',
        truncate(body1, 300),
        actualUrlNote(res1, modelsUrl)
      ].filter(Boolean).join('\n'));
      return;
    }

    var chatUrl = base + '/chat/completions';
    var step1Done = '第 1 步通过（' + list.length + ' 个模型）。';
    var step2Prefix = '第 2 步 POST ' + chatUrl;
    setTestStatus(step1Done + '\n正在测试第 2 步：POST ' + chatUrl + ' （模型 ' + model + '）…');
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
      setTestStatus([
        step1Done,
        step2Prefix + ' 请求失败：' + errText(e),
        sendFailureLine(e),
        (isNetworkErrorLike(e) && isCrossOriginTarget(chatUrl)) ? CORS_HINT : ''
      ].filter(Boolean).join('\n'));
      return;
    }

    var elapsed = (typeof Date !== 'undefined' && Date.now) ? (Date.now() - started) : 0;
    var read2 = await readFull(res2);
    if (!read2.ok) {
      setTestStatus([
        step1Done,
        step2Prefix + ' 返回 HTTP ' + res2.status + '，' + read2.text,
        actualUrlNote(res2, chatUrl)
      ].filter(Boolean).join('\n'));
      return;
    }
    var body2 = read2.text;
    if (!res2.ok) {
      setTestStatus([
        step1Done,
        step2Prefix + ' 返回 HTTP ' + res2.status + httpHint(res2.status),
        '服务端原文：' + truncate(body2, 300),
        actualUrlNote(res2, chatUrl)
      ].filter(Boolean).join('\n'));
      return;
    }

    var data2 = null;
    try { data2 = JSON.parse(body2); } catch (e) { data2 = null; }
    if (!data2) {
      setTestStatus([
        step1Done,
        '第 2 步返回 HTTP 200，但响应不是 JSON：',
        truncate(body2, 300),
        actualUrlNote(res2, chatUrl)
      ].filter(Boolean).join('\n'));
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
