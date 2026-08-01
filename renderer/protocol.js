/*
 * Protocol-tool integration engine.
 *
 * A "protocol tool" is a self-contained HTML page that
 * has: an input field for a HEX frame, a parse trigger (a global function or a
 * button), and a container where it renders the decoded result.
 *
 * We load it into a hidden iframe via `srcdoc` (so it stays same-origin and we
 * can script it fully), drive it programmatically, then mirror its natively
 * rendered result into a visible iframe in the side panel.
 */
const Protocol = (() => {
  let loaded = false;
  let toolStyles = '';            // <style> blocks extracted from the tool
  let toolText = '';              // raw HTML of the tool (for the generator window)
  let api = null;                 // { inputSel, resultSel, trigger }
  const resultBlocks = [];        // rendered history (newest first)
  let parserFrame, resultFrame;

  function init() {
    parserFrame = document.getElementById('parser-frame');
    resultFrame = document.getElementById('result-frame');
    rebuildResults();
  }

  // Extract every <style>…</style> block from the raw tool HTML.
  function extractStyles(html) {
    const out = [];
    const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let m;
    while ((m = re.exec(html))) out.push(m[1]);
    return out.join('\n');
  }

  function waitForFrame(frame) {
    return new Promise((resolve) => {
      frame.onload = () => resolve();
    });
  }

  // Discover how to drive the loaded tool. Defaults match the sample tool but we
  // fall back to heuristics so other tools work too.
  function detectApi(win, doc) {
    const a = { inputSel: null, resultSel: null, triggerFn: null, triggerBtn: null };

    // input: prefer a textarea, else a text input
    let input = doc.querySelector('#parse-input') ||
                doc.querySelector('textarea') ||
                doc.querySelector('input[type=text]');
    if (input) a.inputSel = input;

    // result container
    let result = doc.querySelector('#parse-result') ||
                 doc.querySelector('[id*="result" i]') ||
                 doc.querySelector('.result-box');
    if (result) a.resultSel = result;

    // trigger: prefer the page's explicit parse button. A global parseFrame may
    // be an internal decoder that expects arguments rather than a UI entrypoint.
    const btns = Array.from(doc.querySelectorAll('button, input[type=button]'));
    a.triggerBtn = btns.find((b) => /解析|parse|decode|分析/i.test(b.textContent || b.value || '')) || null;
    if (!a.triggerBtn) {
      const fnNames = ['parseFrame', 'parse', 'doParse', 'onParse', 'decode'];
      for (const fn of fnNames) {
        if (typeof win[fn] === 'function') { a.triggerFn = fn; break; }
      }
    }
    return a;
  }

  async function loadText(text, filePath) {
    if (!text) throw new Error('协议工具文件为空或读取失败');
    toolStyles = extractStyles(text);
    toolText = text;

    const done = waitForFrame(parserFrame);
    parserFrame.srcdoc = text;
    await done;

    const win = parserFrame.contentWindow;
    const doc = parserFrame.contentDocument;
    api = detectApi(win, doc);
    if (!api.inputSel || !api.resultSel || (!api.triggerFn && !api.triggerBtn)) {
      loaded = false;
      throw new Error('无法识别该协议工具的输入/解析/结果区域，请确认它包含输入框、解析按钮和结果区。');
    }
    loaded = true;
    return { name: filePath.split(/[\\/]/).pop() };
  }

  async function load(filePath) {
    const res = await window.dialogAPI.readProtocol(filePath);
    if (!res.ok) throw new Error(res.error || '读取协议工具失败');
    return loadText(res.text, filePath);
  }

  async function loadFromLibrary(filePath) {
    const res = await window.libraryAPI.read(filePath, 'parsers');
    if (!res.ok) throw new Error(res.error || '读取资料库协议工具失败');
    return loadText(res.text, filePath);
  }

  // Run one parse. Returns { ok, html, text, valid, reason }.
  function parseHex(hex) {
    if (!loaded) return { ok: false, html: '', text: '', valid: false, reason: '未加载协议工具' };
    const win = parserFrame.contentWindow;
    const doc = parserFrame.contentDocument;
    try {
      api.inputSel.value = hex;
      // fire input/change in case the tool listens for them
      api.inputSel.dispatchEvent(new win.Event('input', { bubbles: true }));
      if (api.triggerFn) win[api.triggerFn]();
      else if (api.triggerBtn) api.triggerBtn.click();

      const html = api.resultSel.innerHTML || '';
      const text = api.resultSel.textContent || '';
      const ev = evaluate(html, text);
      return { ok: true, html, text, valid: ev.valid, reason: ev.reason };
    } catch (err) {
      return { ok: false, html: '', text: '', valid: false, reason: String(err && err.message || err) };
    }
  }

  // Heuristic: did the tool decode the frame successfully (vs garbled / error)?
  // Used by auto-baud to decide whether the current baud rate is correct.
  function evaluate(html, text) {
    const t = (text || '').trim();
    if (!t) return { valid: false, reason: '无结果' };
    const lc = (html + ' ' + text).toLowerCase();

    // explicit error/garbled markers commonly emitted by parse tools
    const errMarkers = ['crc-fail', 'crc ✗', 'crc✗', '错误', '乱码', '无效', '无法识别',
                        '帧头不是', '帧尾不是', '帧太短', 'error', 'invalid', 'fail', '✗'];
    for (const m of errMarkers) {
      if (lc.includes(m)) return { valid: false, reason: '检测到错误标记: ' + m };
    }
    // success signals
    const okMarkers = ['crc ✓', 'crc✓', '✓', '正确', 'field', 'tag', '功能码', 'success'];
    const hasOk = okMarkers.some((m) => lc.includes(m));
    // also require some structure / reasonable length
    if (hasOk || t.length > 24) return { valid: true, reason: 'ok' };
    return { valid: false, reason: '结果过短/无结构' };
  }

  // ── result rendering (mirror native styling into the visible iframe) ───────
  // Replace-only: each parse REPLACES the previous result, so the panel always
  // shows just the current frame's decode (and, on error, the reason) — picking
  // a wrong/garbled frame wipes the previously-correct output.
  function showResult(html, meta, isError) {
    const head = `<div class="ct-head ${isError ? 'ct-head-err' : ''}">${meta || ''}</div>`;
    const banner = isError ? '<div class="ct-errbar">❌ 当前报文解析失败 / 乱码（详见下方原因）</div>' : '';
    resultBlocks.length = 0;
    resultBlocks.push(`<div class="ct-block ${isError ? 'ct-block-err' : ''}">${head}${banner}${html}</div>`);
    rebuildResults();
  }

  function rebuildResults() {
    const wrap = `
      <style>${toolStyles}</style>
      <style>
        body{margin:0;padding:6px 8px;background:#fff;
             font-family:Consolas,'Courier New',monospace;font-size:12px;color:#1f2328}
        .ct-block{border:1px solid #e1e4e8;border-radius:6px;margin-bottom:10px;overflow:hidden}
        .ct-head{background:#f6f8fa;border-bottom:1px solid #e1e4e8;padding:4px 8px;
                 font-size:11px;color:#57606a;word-break:break-all}
        .ct-head-err{background:#fff0f0;color:#cf222e}
        .ct-block-err{border-color:#ffb3b3}
        .ct-errbar{background:#cf222e;color:#fff;padding:5px 8px;font-weight:bold;font-size:12px}
        .ct-empty{color:#8b949e;padding:20px;text-align:center}
        .result-box{display:block!important;margin:0;border:none}
      </style>
      <body>${resultBlocks.length
        ? resultBlocks.join('')
        : '<div class="ct-empty">解析结果将显示在这里。<br>加载协议工具 → 选中报文 → 解析选中，或开启“自动解析”。</div>'}</body>`;
    resultFrame.srcdoc = wrap;
  }

  function clearResults() {
    resultBlocks.length = 0;
    rebuildResults();
  }

  // ── generator window (the loaded tool's own "报文生成/build" UI) ─────────────
  // The sample tool (and many like it) has a frame-builder tab. We load a fresh,
  // independent instance of the tool into a VISIBLE iframe so the user can drive
  // its generator UI by hand, then pull the generated HEX out for the send box.

  // Load the tool into `frame` (once per tool) and try to switch to its build tab.
  async function openGeneratorInto(frame) {
    if (!loaded) throw new Error('未加载协议工具');
    if (frame.dataset.toolLoaded !== '1' || frame.dataset.toolKey !== String(toolText.length)) {
      const done = waitForFrame(frame);
      frame.srcdoc = toolText;
      await done;
      frame.dataset.toolLoaded = '1';
      frame.dataset.toolKey = String(toolText.length);
    }
    // jump to the generate/build tab if the tool exposes one
    try {
      const win = frame.contentWindow, doc = frame.contentDocument;
      if (typeof win.switchTab === 'function') { win.switchTab('build'); return; }
      const tab = Array.from(doc.querySelectorAll('[onclick],button,.tab,a'))
        .find((el) => /报文生成|生成帧|生成报文|组帧|构造|build|generate/i.test(el.textContent || ''));
      if (tab) tab.click();
    } catch { /* tool without a build tab: user uses whatever it shows */ }
  }

  // Pull the generated frame's HEX out of the generator iframe: the longest run
  // of hex byte-pairs anywhere in its rendered text (= the built frame). Returns
  // a normalized HEX string, or '' if nothing frame-like is shown.
  function readGenerated(frame) {
    try {
      const doc = frame.contentDocument;
      const text = (doc.body.innerText || doc.body.textContent || '');
      const re = /(?:[0-9a-fA-F]{2}[ ,]+){5,}[0-9a-fA-F]{2}/g;  // ≥6 byte run
      let best = '', m;
      while ((m = re.exec(text))) if (m[0].length > best.length) best = m[0];
      return best.replace(/[,\s]+/g, ' ').trim().toUpperCase();
    } catch { return ''; }
  }

  // Read a human-friendly command name from the generator UI. Prefer the
  // selected command name because it describes the generated instruction.
  function readGeneratedName(frame) {
    try {
      const doc = frame.contentDocument;
      const explicit = doc.querySelector('#command-name,#cmd-name,#build-name,[data-command-name]');
      if (explicit) {
        const value = String(explicit.value || explicit.textContent || '').trim();
        if (value) return value;
      }

      const idNames = Array.from(doc.querySelectorAll('.b-id-sel'))
        .map((select) => select.selectedOptions && select.selectedOptions[0])
        .filter(Boolean)
        .map((option) => String(option.textContent || '').replace(/^\s*\d+\s*[–—-]\s*/, '').trim())
        .filter(Boolean);
      if (idNames.length) return idNames.join('、').slice(0, 60);

      const genericId = doc.querySelector('select[id*="id" i]');
      if (genericId && genericId.selectedOptions && genericId.selectedOptions[0]) {
        const value = String(genericId.selectedOptions[0].textContent || '').replace(/^\s*\d+\s*[–—-]\s*/, '').trim();
        if (value) return value;
      }

      return '';
    } catch { return ''; }
  }

  return {
    init, load, loadFromLibrary, parseHex, showResult, clearResults, isLoaded: () => loaded,
    openGeneratorInto, readGenerated, readGeneratedName
  };
})();
