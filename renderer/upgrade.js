/* Local upgrade-library UI and package runner. Packages are trusted local JS
 * files. They receive no Node API; the host exposes only byte/file/transport
 * helpers below. */
const Upgrade = (() => {
  const $ = (id) => document.getElementById(id);
  let host;
  let firmware = null;
  let packageInfo = null;
  let adapter = null;
  let state = 'idle'; // idle | armed | running | stopped
  let peer = null;
  let quietTimer = null;
  let parser = { loaded: false, api: null, styles: '' };

  const hex = (bytes) => Array.from(bytes || []).map((b) => Number(b).toString(16).padStart(2, '0')).join(' ').toUpperCase();
  const fromHex = (text) => {
    const cleaned = String(text || '').replace(/[^0-9a-fA-F]/g, '');
    if (!cleaned || cleaned.length % 2) throw new Error('应答 HEX 不能为空且必须是完整字节');
    return Array.from({ length: cleaned.length / 2 }, (_, i) => parseInt(cleaned.slice(i * 2, i * 2 + 2), 16));
  };
  const crc16 = (bytes) => {
    let crc = 0xffff;
    for (const value of bytes) { crc ^= Number(value) << 8; for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
    return crc >>> 0;
  };
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const value of bytes) { crc ^= Number(value); for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const checksum = async (bytes, type) => {
    const name = String(type || 'CRC32').toUpperCase();
    if (name === 'CRC16' || name === 'CRC16-CCITT') return `CRC16: ${crc16(bytes).toString(16).padStart(4, '0').toUpperCase()}`;
    if (name === 'CRC32') return `CRC32: ${crc32(bytes).toString(16).padStart(8, '0').toUpperCase()}`;
    if (name === 'MD5' || name === 'SHA-256' || name === 'SHA256') {
      const res = await window.libraryAPI.hash(bytes, name);
      return res.ok ? `${name}: ${res.value}` : `${name}: 计算失败`;
    }
    const algo = name;
    if (!crypto?.subtle) return `${name}: 此环境不支持`;
    const digest = await crypto.subtle.digest(algo, Uint8Array.from(bytes));
    return `${name}: ${hex(new Uint8Array(digest)).replaceAll(' ', '')}`;
  };
  const allowedSizes = () => packageInfo?.manifest?.chunkSizes || [128, 256, 512, 1024];
  const selectedChunkSize = () => Number($('up-chunk-size').value || 256);
  const firmwareVersion = () => String(firmware?.name || '').replace(/\.[^.]+$/, '').trim();
  const log = (message) => {
    const item = document.createElement('div');
    item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    $('up-log').prepend(item);
  };
  const setState = (next, message) => {
    state = next; $('up-state').textContent = message || next; renderButtons();
    host?.setUpgradeLock?.(state === 'armed' || state === 'running');
  };
  const renderButtons = () => {
    $('btn-up-start').disabled = state === 'running' || state === 'armed';
    $('btn-up-stop').disabled = !(state === 'running' || state === 'armed');
    $('btn-up-reset').disabled = state === 'running';
  };
  const updateProgress = (confirmed, total) => {
    const max = Math.max(1, Number(total || totalPackets()));
    const percent = Math.max(0, Math.min(100, Math.floor(Number(confirmed || 0) * 100 / max)));
    $('up-progress').value = percent;
    $('up-progress-text').textContent = `${percent}% (${Number(confirmed || 0)}/${max} 包)`;
  };
  const totalPackets = () => firmware ? Math.ceil(firmware.bytes.length / selectedChunkSize()) : 0;
  const resumeKey = () => `com-tool-upgrade:${packageInfo?.manifest?.id || 'unknown'}:${firmware?.checksum || ''}:${selectedChunkSize()}:${peer?.address || 'serial'}`;
  const persist = (data) => { try { localStorage.setItem(resumeKey(), JSON.stringify(data)); } catch (_) {} };
  const clearResume = () => { try { localStorage.removeItem(resumeKey()); } catch (_) {} };

  function packageContext() {
    return {
      firmware: firmware.bytes.slice(), firmwareName: firmware.name, firmwareVersion: firmwareVersion(), firmwareChecksum: firmware.checksum,
      chunkSize: selectedChunkSize(), totalPackets: totalPackets(), transport: host.getTransport(), peer,
      hex, fromHex, crc16, crc32,
      // The protocol defines a fixed payload length for every data packet.  The
      // last packet therefore has to be zero-padded; the package checksum is
      // calculated over this same padded image.
      getChunk: (index) => {
        const chunkSize = selectedChunkSize();
        const start = Number(index) * chunkSize;
        const chunk = firmware.bytes.slice(start, start + chunkSize);
        while (chunk.length < chunkSize) chunk.push(0);
        return chunk;
      },
      send: async (bytes) => host.send(Array.from(bytes), peer),
      log,
      progress: (confirmed, total) => updateProgress(confirmed, total),
      saveResume: (data) => persist(data),
      loadResume: () => { try { return JSON.parse(localStorage.getItem(resumeKey()) || 'null'); } catch (_) { return null; } },
      clearResume,
      setDeviceId: (id) => { peer = { ...(peer || {}), deviceId: String(id || '') }; },
      complete: (message) => { clearTimer(); setState('idle', message || '升级完成'); updateProgress(totalPackets(), totalPackets()); }
    };
  }
  function clearTimer() { if (quietTimer) { clearTimeout(quietTimer); quietTimer = null; } }
  async function runStart() {
    clearTimer();
    setState('running', '升级中');
    log('开始执行升级包起始流程');
    try { if (adapter?.start) await adapter.start(packageContext()); }
    catch (err) { setState('stopped', '升级失败'); log(`升级包启动失败：${err.message || err}`); }
  }
  async function replyAndWait() {
    try {
      await host.send(fromHex($('up-answer').value), peer);
      log(`已应答 ${peer.address}:${peer.port}，等待 5 秒静默`);
      clearTimer();
      quietTimer = setTimeout(runStart, 5000);
      setState('armed', '已应答，等待设备静默 5 秒');
    } catch (err) { setState('stopped', '应答失败'); log(`应答失败：${err.message || err}`); }
  }
  async function onIncoming(bytes, source) {
    if (state === 'armed' && host.getTransport() === 'network') {
      if (!peer) { peer = { address: source?.address, port: source?.port }; log(`锁定设备 ${peer.address}:${peer.port}`); }
      if (source?.address === peer.address && Number(source?.port) === Number(peer.port)) {
        if ($('up-network-answer-enabled').checked) await replyAndWait();
        else { log('未启用首包应答，收到首包后立即启动升级'); await runStart(); }
      }
      return;
    }
    if (state === 'running' && adapter?.onReceive) {
      try { await adapter.onReceive(Array.from(bytes), packageContext()); }
      catch (err) { setState('stopped', '升级包处理失败'); log(`收到数据处理失败：${err.message || err}`); }
    }
  }
  function createAdapter(code) {
    const module = { exports: {} };
    // Local packages are deliberately executable and must only be imported from trusted sources.
    new Function('module', 'exports', 'helpers', `'use strict';\n${code}`)(module, module.exports, { hex, fromHex, crc16, crc32 });
    const spec = module.exports?.default || module.exports;
    if (!spec || !spec.manifest || typeof spec.create !== 'function') throw new Error('升级包必须导出 manifest 和 create(context)');
    return { manifest: spec.manifest, create: spec.create, fileChecksum: spec.fileChecksum };
  }
  async function refreshLibraries() {
    const [parsers, packages, info] = await Promise.all([window.libraryAPI.list('parsers'), window.libraryAPI.list('packages'), window.libraryAPI.info()]);
    for (const [res, id, empty] of [[parsers, 'up-parser-list', '没有解析工具'], [packages, 'up-package-list', '没有升级包']]) {
      const select = $(id); select.innerHTML = '';
      if (!res.ok || !res.items.length) { select.add(new Option(empty, '')); continue; }
      for (const item of res.items) select.add(new Option(item.name, item.path));
    }
    if (info.ok) $('up-library-path').textContent = info.fallback ? `资料库：${info.root}（安装目录不可写，已回退）` : `资料库：${info.root}`;
  }
  async function loadPackage() {
    const filePath = $('up-package-list').value; if (!filePath) return;
    const res = await window.libraryAPI.read(filePath, 'packages');
    if (!res?.ok) { packageInfo = null; adapter = null; return alert(`升级包读取失败：${res?.error || '未知错误'}`); }
    try {
      const spec = createAdapter(res.text);
      packageInfo = spec; adapter = null;
      $('up-package-name').textContent = spec.manifest.name || filePath.split(/[\\/]/).pop();
      renderChunkSizes(); await refreshFirmwareSummary(); log(`已加载升级包：${$('up-package-name').textContent}`);
    } catch (err) { packageInfo = null; adapter = null; alert(`升级包加载失败：${err.message || err}`); }
  }
  function renderChunkSizes() {
    const current = selectedChunkSize(); const select = $('up-chunk-size'); select.innerHTML = '';
    for (const size of allowedSizes()) select.add(new Option(`${size} 字节`, size));
    select.value = allowedSizes().includes(current) ? String(current) : String(allowedSizes()[0]);
  }
  async function refreshFirmwareSummary() {
    if (!firmware) { $('up-file-info').textContent = '未导入升级文件'; $('up-firmware-version').textContent = '-'; $('up-checksum').textContent = '-'; $('up-total-packets').textContent = '-'; updateProgress(0, 1); return; }
    const type = packageInfo?.manifest?.checksum || 'CRC32';
    if (typeof packageInfo?.fileChecksum === 'function') {
      try {
        const value = await packageInfo.fileChecksum(firmware.bytes.slice(), selectedChunkSize(), totalPackets());
        firmware.checksum = typeof value === 'number'
          ? `${type}: ${value.toString(16).padStart(4, '0').toUpperCase()}`
          : `${type}: ${String(value)}`;
      } catch (err) { firmware.checksum = `${type}: 计算失败（${err.message || err}）`; }
    } else firmware.checksum = await checksum(firmware.bytes, type);
    $('up-file-info').textContent = `${firmware.name} · ${firmware.bytes.length} 字节`;
    $('up-firmware-version').textContent = firmwareVersion() || '文件名为空';
    $('up-checksum').textContent = firmware.checksum;
    $('up-total-packets').textContent = `${totalPackets()} 包（${selectedChunkSize()} 字节/包）`;
    updateProgress(0, totalPackets());
  }
  async function chooseFirmware() {
    const res = await window.libraryAPI.openFirmware();
    if (!res.ok) return;
    firmware = { name: res.name, path: res.path, bytes: res.bytes, checksum: '' };
    await refreshFirmwareSummary(); log(`已导入升级文件：${res.name}`);
  }
  async function start() {
    if (!host.isOpen()) return alert('请先打开串口或 UDP 网络');
    if (!firmware || !packageInfo) return alert('请先加载升级包和升级文件');
    try { adapter = packageInfo.create(packageContext()); }
    catch (err) { return alert(`升级包初始化失败：${err.message || err}`); }
    $('up-config').open = false;
    if (host.getTransport() === 'network') {
      peer = null; setState('armed', '等待第一包 UDP 数据');
      log($('up-network-answer-enabled').checked ? '网络升级已就绪，等待第一包数据后应答' : '网络升级已就绪，收到第一包数据后直接启动');
    } else await runStart();
  }
  function stop() { clearTimer(); setState('stopped', '已停止'); log('升级已停止'); }
  function reset() { clearTimer(); clearResume(); updateProgress(0, totalPackets()); if (host.getTransport() === 'network') { peer = null; setState('armed', '已复位，等待下一包 UDP 数据'); log('已复位，等待下一包 UDP 数据'); } else { setState('idle', '已复位，请点击开始升级'); log('已复位，请重新点击开始升级'); } }
  function detectParser(doc, win) {
    const input = doc.querySelector('#parse-input') || doc.querySelector('textarea') || doc.querySelector('input[type=text]');
    const result = doc.querySelector('#parse-result') || doc.querySelector('[id*=result i]') || doc.querySelector('.result-box');
    const button = [...doc.querySelectorAll('button,input[type=button]')].find((el) => /解析|parse|decode/i.test(el.textContent || el.value || ''));
    const fn = ['parseFrame', 'parse', 'decode'].find((name) => typeof win[name] === 'function');
    return { input, result, button, fn };
  }
  async function loadParser() {
    const filePath = $('up-parser-list').value; if (!filePath) return;
    const res = await window.libraryAPI.read(filePath, 'parsers');
    if (!res?.ok) { parser = { loaded: false, api: null, styles: '' }; return alert(`解析工具读取失败：${res?.error || '未知错误'}`); }
    const frame = $('up-parser-frame');
    await new Promise((resolve) => { frame.onload = resolve; frame.srcdoc = res.text; });
    parser = { loaded: true, api: detectParser(frame.contentDocument, frame.contentWindow), styles: (res.text.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || []).join('') };
    if (!parser.api.input || !parser.api.result || (!parser.api.button && !parser.api.fn)) { parser.loaded = false; return alert('无法识别解析工具的输入框、解析动作或结果区'); }
    $('up-parser-name').textContent = filePath.split(/[\\/]/).pop(); log(`已加载解析工具：${$('up-parser-name').textContent}`);
  }
  function parse(bytes) {
    if (!$('upgrade-view').classList.contains('active') || !parser.loaded) return;
    const frame = $('up-parser-frame'), { input, result, button, fn } = parser.api;
    try {
      input.value = hex(bytes); input.dispatchEvent(new frame.contentWindow.Event('input', { bubbles: true }));
      if (fn) frame.contentWindow[fn](); else button.click();
      $('up-result-frame').srcdoc = `<style>body{font:12px Consolas,monospace;padding:8px;color:#273447}${parser.styles}</style>${result.outerHTML}`;
    } catch (err) { log(`解析失败：${err.message || err}`); }
  }
  function open() { host?.setPanelOpen?.('upgrade', true); refreshLibraries(); }
  function close() { host?.setPanelOpen?.('upgrade', false); }
  async function importLibrary(kind, label) {
    try {
      const res = await window.libraryAPI.import(kind);
      if (!res?.ok) {
        if (res?.error) alert(`${label}添加失败：${res.error}`);
        return;
      }
      await refreshLibraries();
      const select = $(kind === 'parsers' ? 'up-parser-list' : 'up-package-list');
      select.value = res.path;
      if (kind === 'parsers') await loadParser(); else await loadPackage();
      log(`已添加${label}：${res.path.split(/[\\/]/).pop()}`);
    } catch (err) { alert(`${label}添加失败：${err.message || err}`); }
  }
  async function openLibrary(kind) {
    try {
      const res = await window.libraryAPI.open(kind);
      if (!res?.ok) alert(`打开资料库失败：${res?.error || '未知错误'}`);
    } catch (err) { alert(`打开资料库失败：${err.message || err}`); }
  }
  function init(nextHost) {
    host = nextHost;
    // Keep the upgrade page inside the same right-hand dock as protocol parsing.
    $('right').appendChild($('upgrade-right-split'));
    $('right').appendChild($('upgrade-view'));
    $('btn-show-upgrade').addEventListener('click', () => $('upgrade-view').classList.contains('active') ? close() : open()); $('btn-up-close').addEventListener('click', close);
    $('btn-up-import-parser').addEventListener('click', () => importLibrary('parsers', '协议解析工具'));
    $('btn-up-import-package').addEventListener('click', () => importLibrary('packages', '升级协议包'));
    $('btn-up-open-parser-dir').addEventListener('click', () => openLibrary('parsers'));
    $('btn-up-open-package-dir').addEventListener('click', () => openLibrary('packages'));
    $('btn-up-refresh').addEventListener('click', refreshLibraries); $('up-package-list').addEventListener('change', loadPackage);
    $('up-parser-list').addEventListener('change', loadParser); $('btn-up-firmware').addEventListener('click', chooseFirmware);
    $('up-chunk-size').addEventListener('change', refreshFirmwareSummary); $('btn-up-start').addEventListener('click', start);
    $('btn-up-stop').addEventListener('click', stop); $('btn-up-reset').addEventListener('click', reset); renderButtons();
  }
  return { init, open, onIncoming, parse, blocksNormalSend: () => state === 'armed' || state === 'running', isActive: () => state === 'armed' || state === 'running' };
})();
