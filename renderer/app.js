/* Main renderer logic: serial I/O, receive packetization, selection,
   sending, statistics, and the protocol-parse / auto-baud orchestration. */
(() => {
  const $ = (id) => document.getElementById(id);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── state ────────────────────────────────────────────────────────────────
  let isOpen = false;
  let transport = 'serial';
  let preferredNetworkLocalAddress = '0.0.0.0';
  let packets = [];          // { id, time, dir, bytes:[] }
  let pktSeq = 0;
  const selected = new Set();
  let lastAnchor = null;     // for shift-range selection
  let curRx = null;          // 正在实时追加的接收行 { pkt, start: epochMs }
  let rxIdleTimer = null;    // 空闲收尾定时器
  let stats = { rx: 0, tx: 0, pkt: 0 };
  let sendTimer = null;
  let multiTimer = null;
  let scanning = false;
  let autoBaudExhausted = false;  // stop re-scanning once all candidates failed
  let autoScroll = true;
  let receivePaused = false;
  const STORAGE_KEY = 'com-tool-v2-settings';
  let persistenceReady = false;
  let preferredPortPath = '';
  let persistTimer = null;
  let protocolLibraryPath = '';

  Protocol.init();

  // ── byte/format helpers ──────────────────────────────────────────────────
  function bytesToHex(bytes, sep = ' ') {
    return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(sep);
  }
  function bytesToStr(bytes) {
    // keep printable ASCII + tab/CR/LF (so log text reads naturally), rest → '.'
    return bytes.map((b) => (b === 9 || b === 10 || b === 13 || (b >= 0x20 && b < 0x7f))
      ? String.fromCharCode(b) : '.').join('');
  }
  function parseHexInput(str) {
    const s = str.replace(/0x/gi, ' ').replace(/[^0-9a-fA-F]/g, '');
    const out = [];
    for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
    return out;
  }
  // 送解析器前，从可打印日志中提取最长的连续十六进制字节序列；二进制数据保持原样。
  function frameHexForParse(bytes) {
    const plain = bytesToHex(bytes);                  // 默认：整包字节的 HEX(空格分隔)
    if (printableRatio(bytes) < 0.9) return plain;    // 二进制帧 → 不动
    const text = bytesToStr(bytes);

    const cands = [];
    // ① 连续的"两位 HEX + 空格/逗号/Tab"片段(≥4 字节)——主路径
    const runRe = /(?:[0-9a-fA-F]{2}[ ,\t]+){3,}[0-9a-fA-F]{2}/g;
    let m;
    while ((m = runRe.exec(text))) cands.push(m[0]);
    // ② 单个无分隔的长偶数纯 HEX 字段(如 AT 回包里连续 HEX 字段)
    for (const f of text.split(/[,\s]+/)) {
      if (/^[0-9a-fA-F]{8,}$/.test(f) && f.length % 2 === 0) cands.push(f);
    }

    // 取清洗后字节数最多的候选当协议帧
    let best = '';
    for (const c of cands) {
      const h = c.replace(/[^0-9a-fA-F]/g, '');
      if (h.length > best.length) best = h;
    }
    return best.length >= 8 ? bytesToHex(parseHexInput(best)) : plain;
  }
  function fmtTime(d) {
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── baud rate combo (select + custom) ────────────────────────────────────
  function getBaud() {
    const sel = $('cfg-baud');
    if (sel.value === 'custom') return Math.max(1, parseInt($('cfg-baud-custom').value) || 9600);
    return parseInt(sel.value) || 9600;
  }
  function setBaudDisplay(v) {
    const sel = $('cfg-baud');
    const has = [...sel.options].some((o) => o.value === String(v));
    if (has) { sel.value = String(v); $('cfg-baud-custom').style.display = 'none'; }
    else { sel.value = 'custom'; $('cfg-baud-custom').style.display = ''; $('cfg-baud-custom').value = v; }
    updateBaudInfo();
  }
  function onBaudSelChange() {
    $('cfg-baud-custom').style.display = $('cfg-baud').value === 'custom' ? '' : 'none';
    // allow live baud change while the port is open (and not mid-scan)
    if (isOpen && !scanning) {
      window.serialAPI.setBaud(getBaud());
      $('conn-state').textContent = `已连接 @ ${getBaud()}`;
    }
    updateBaudInfo();
  }

  // ── port list ────────────────────────────────────────────────────────────
  async function refreshPorts() {
    const res = await window.serialAPI.list();
    const sel = $('cfg-port');
    const prev = preferredPortPath || sel.value;
    sel.innerHTML = '';
    if (res.ok && res.ports.length) {
      for (const p of res.ports) {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = p.path + (p.friendlyName ? ` (${p.friendlyName})` : (p.manufacturer ? ` (${p.manufacturer})` : ''));
        sel.appendChild(opt);
      }
      if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
      else if (prev) {
        const saved = document.createElement('option');
        saved.value = prev;
        saved.textContent = `${prev}（上次使用，当前未检测到）`;
        sel.appendChild(saved);
        sel.value = prev;
      }
    } else {
      const opt = document.createElement('option');
      if (prev) {
        opt.value = prev;
        opt.textContent = `${prev}（上次使用，当前未检测到）`;
      } else opt.textContent = res.ok ? '（无可用串口）' : ('错误: ' + res.error);
      sel.appendChild(opt);
      if (prev) sel.value = prev;
    }
    syncModalPortOptions();
    preferredPortPath = sel.value || preferredPortPath;
  }

  async function refreshNetworkAddresses() {
    const res = await window.networkAPI.listAddresses();
    const sel = $('cfg-network-local-address');
    const previous = preferredNetworkLocalAddress || sel.value || '0.0.0.0';
    sel.innerHTML = '';
    if (!res.ok) {
      const option = document.createElement('option');
      option.value = '0.0.0.0'; option.textContent = '0.0.0.0'; sel.appendChild(option);
      return;
    }
    res.addresses.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.address; option.textContent = item.label; sel.appendChild(option);
    });
    sel.value = [...sel.options].some((option) => option.value === previous) ? previous : '0.0.0.0';
    preferredNetworkLocalAddress = sel.value;
  }

  function syncModalPortOptions() {
    const modal = $('modal-port');
    if (!modal) return;
    modal.innerHTML = '';
    for (const option of $('cfg-port').options) modal.appendChild(option.cloneNode(true));
    modal.value = $('cfg-port').value;
  }

  // ── open / close ─────────────────────────────────────────────────────────
  async function openPort() {
    const flow = $('cfg-flow').value;
    const opts = {
      path: $('cfg-port').value,
      baudRate: getBaud(),
      dataBits: $('cfg-data').value,
      stopBits: $('cfg-stop').value,
      parity: $('cfg-parity').value,
      rtscts: flow === 'rtscts'
    };
    if (!opts.path || opts.path.startsWith('（') || opts.path.startsWith('错误')) {
      alert('请先选择有效的串口'); return;
    }
    const res = await window.serialAPI.open(opts);
    if (!res.ok) { alert('打开串口失败: ' + res.error); return; }
    autoBaudExhausted = false;
    setOpenState(true);
  }
  async function openNetwork() {
    const opts = { localAddress: $('cfg-network-local-address').value, localPort: Number($('cfg-network-local-port').value) };
    const res = await window.networkAPI.open(opts);
    if (!res.ok) { alert('打开网络失败: ' + res.error); return; }
    setOpenState(true);
  }
  async function openTransport() {
    if (transport === 'network') await openNetwork();
    else await openPort();
  }
  async function closePort() {
    stopTimedSend(); stopMultiSend();
    if (transport === 'network') await window.networkAPI.close();
    else await window.serialAPI.close();
    setOpenState(false);
  }
  function setOpenState(open) {
    isOpen = open;
    const label = transport === 'network' ? '网络' : '串口';
    $('btn-open').textContent = open ? `关闭${label}` : `打开${label}`;
    $('btn-open').classList.toggle('danger', open);
    $('btn-open').classList.toggle('primary', !open);
    const cs = $('conn-state');
    cs.textContent = open ? (transport === 'network' ? `UDP ${$('cfg-network-local-address').value}:${$('cfg-network-local-port').value}` : `已连接 @ ${getBaud()}`) : '未连接';
    cs.className = 'badge ' + (open ? 'badge-on' : 'badge-off');
    ['cfg-transport', 'cfg-port', 'cfg-data', 'cfg-stop', 'cfg-parity', 'cfg-flow', 'cfg-network-local-address', 'cfg-network-local-port'].forEach((i) => ($(i).disabled = open));
    $('status-port').textContent = open ? (transport === 'network' ? `UDP ${$('cfg-network-local-address').value}:${$('cfg-network-local-port').value} 已打开` : `${$('cfg-port').value} 已打开`) : `${label}未打开`;
    const dot = document.querySelector('.statusbar i');
    if (dot) dot.classList.toggle('on', open);
    if (transport === 'serial') updateBaudInfo();
  }

  function setTransportMode(value) {
    transport = value === 'network' ? 'network' : 'serial';
    $('cfg-transport').value = transport;
    document.querySelectorAll('.serial-only').forEach((el) => { el.style.display = transport === 'serial' ? '' : 'none'; });
    $('network-settings').style.display = transport === 'network' ? 'inline-flex' : 'none';
    $('cur-baud-wrap').style.display = transport === 'serial' ? '' : 'none';
    $('btn-open').textContent = transport === 'network' ? '打开网络' : '打开串口';
    schedulePersist();
  }

  // ── receive packetization ────────────────────────────────────────────────
  // 数据永远立即追加到“当前接收行”并就地显示。分包间隔 = 一行连续累计满 N ms
  // 就另起新行（=0 时每笔单独成行）；空闲后由定时器收尾。镜像 /recv 与自动解析
  // 在“行收尾”时各触发一次。
  function onSerialData(bytes) { onIncomingData(bytes); }
  function onNetworkData(payload) { onIncomingData(payload.bytes, { address: payload.remoteAddress, port: payload.remotePort }); }
  function onIncomingData(bytes, peer = null) {
    if (receivePaused) return;
    stats.rx += bytes.length;
    const arr = Array.from(bytes);
    Upgrade.onIncoming(arr, peer);
    const gap = parseInt($('rx-gap').value) || 0;
    const now = Date.now();

    // 显示绝对优先：收尾上一行时即使镜像/解析抛错，也不能挡住本次数据上屏
    const peerChanged = Boolean(curRx && JSON.stringify(curRx.peer) !== JSON.stringify(peer));
    if (!curRx || peerChanged || gap <= 0 || (now - curRx.start) >= gap) {
      try { finalizeRx(); } catch (e) { console.error('finalizeRx', e); }
      curRx = { pkt: addPacket('rx', arr, undefined, peer), start: now, peer };
    } else {
      curRx.pkt.bytes.push(...arr);                             // 追加到当前行
      updatePacketEl(curRx.pkt);                                // 就地重绘
    }

    // 空闲收尾：停止接收后把最后一行也镜像/解析（gap=0 时尽快收尾）
    if (rxIdleTimer) clearTimeout(rxIdleTimer);
    rxIdleTimer = setTimeout(() => { try { finalizeRx(); } catch (e) { console.error('finalizeRx', e); } }, gap > 0 ? gap : 1);
  }

  // 关闭当前接收行：自动解析 + 波特率自适应（每行仅一次）
  function finalizeRx() {
    if (rxIdleTimer) { clearTimeout(rxIdleTimer); rxIdleTimer = null; }
    if (!curRx) return;
    const pkt = curRx.pkt;
    curRx = null;

    // auto-parse (needs a loaded protocol)
    if ($('auto-parse').checked && Protocol.isLoaded()) autoParsePacket(pkt);

    // auto-baud: independent of protocol — judge garbled by raw bytes
    if (transport === 'serial' && $('auto-baud').checked && isOpen && !scanning && !autoBaudExhausted &&
        pkt.bytes.length >= 2) {
      if (dataLooksGood(pkt.bytes)) autoBaudExhausted = false;  // good data → keep watching
      else baudScan();
    }
  }

  function addPacket(dir, bytes, fmt, peer = null) {
    if (dir === 'tx') finalizeRx();   // 关掉正在追加的接收行，避免后续 rx 插到该 tx 之前
    const pkt = { id: ++pktSeq, time: new Date(), dir, bytes, fmt, peer };
    packets.push(pkt);
    if (dir === 'rx') { stats.pkt++; }
    if (packets.length > 5000) packets.shift();
    renderPacket(pkt);
    updateStats();
    return pkt;
  }

  function packetText(pkt) {
    const showTime = $('rx-time').checked;
    // TX echo shows in the format it was SENT (hex/str); RX follows the view mode.
    const mode = (pkt.dir === 'tx' && pkt.fmt) ? pkt.fmt : $('rx-mode').value;
    const isHex = mode === 'hex';
    const body = escapeHtml(isHex ? bytesToHex(pkt.bytes) : bytesToStr(pkt.bytes));
    const ts = showTime ? `<span class="ts">[${fmtTime(pkt.time)}]</span> ` : '';
    const peer = pkt.peer ? `<span class="ts">[${pkt.peer.address}:${pkt.peer.port}]</span> ` : '';
    // 收发都不加方向箭头前缀
    return ts + peer + body;
  }

  function renderPacket(pkt) {
    if (pkt.dir === 'tx' && !$('rx-showtx').checked) return;
    const div = document.createElement('div');
    div.className = `pkt ${pkt.dir}`;
    div.dataset.id = pkt.id;
    div.innerHTML = packetText(pkt);
    div.addEventListener('click', (e) => onPacketClick(pkt.id, e));
    pkt.el = div;                         // 记住 DOM 节点，供实时追加时就地重绘
    const list = $('rx-list');
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;   // always auto-scroll
  }

  // 当前接收行追加数据后就地刷新（不新建节点）
  function updatePacketEl(pkt) {
    if (!pkt.el) { renderPacket(pkt); return; }
    pkt.el.innerHTML = packetText(pkt);
    const list = $('rx-list');
    if (autoScroll) list.scrollTop = list.scrollHeight;
  }

  function rerenderAll() {
    const list = $('rx-list');
    list.innerHTML = '';
    for (const pkt of packets) renderPacket(pkt);
    for (const id of selected) {
      const el = list.querySelector(`.pkt[data-id="${id}"]`);
      if (el) el.classList.add('sel');
    }
  }

  // ── selection ────────────────────────────────────────────────────────────
  function onPacketClick(id, e) {
    if (e.shiftKey && lastAnchor != null) {
      const ids = packets.map((p) => p.id);
      const a = ids.indexOf(lastAnchor), b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        if (!(e.ctrlKey || e.metaKey)) selected.clear();
        for (let i = lo; i <= hi; i++) selected.add(ids[i]);
      }
    } else if (e.ctrlKey || e.metaKey) {
      selected.has(id) ? selected.delete(id) : selected.add(id);
      lastAnchor = id;
    } else {
      selected.clear(); selected.add(id); lastAnchor = id;
    }
    refreshSelectionUI();
    if ($('click-parse').checked) {
      setPanelOpen('protocol', true);
      parseSelectionNow();   // 选中即解析（无需再点按钮）
    }
  }
  function refreshSelectionUI() {
    document.querySelectorAll('#rx-list .pkt').forEach((el) => {
      el.classList.toggle('sel', selected.has(parseInt(el.dataset.id)));
    });
    Upgrade.parse(selectedBytes());
  }
  // 选中报文后自动调用协议工具解析（静默：未加载协议/空选择则不打扰）
  function parseSelectionNow() {
    if (!Protocol.isLoaded()) return;
    const bytes = selectedBytes();
    if (!bytes.length) return;
    const hex = frameHexForParse(bytes);
    const r = Protocol.parseHex(hex);
    const meta = `选中解析 · ${bytes.length}字节 · ${new Date().toLocaleTimeString()}<br>${hex}`;
    Protocol.showResult(
      r.html || `<span style="color:#cf222e">解析失败: ${escapeHtml(r.reason || '')}</span>`,
      meta, !(r.ok && r.valid));
  }
  function selectedBytes() {
    const out = [];
    for (const pkt of packets) if (selected.has(pkt.id)) out.push(...pkt.bytes);
    return out;
  }

  // ── stats ────────────────────────────────────────────────────────────────
  function updateStats() {
    $('stat-rx').textContent = stats.rx;
    $('stat-tx').textContent = stats.tx;
    $('stat-pkt').textContent = stats.pkt;
  }
  function resetStats() { stats = { rx: 0, tx: 0, pkt: 0 }; updateStats(); }
  // reflect the current send baud in the local-API info box
  function updateBaudInfo() { const el = $('cur-baud'); if (el) el.textContent = getBaud(); }

  // ── sending ──────────────────────────────────────────────────────────────
  async function writeBytes(bytes, fmt) {
    if (Upgrade.blocksNormalSend()) { alert('升级进行中，普通发送已锁定'); return false; }
    if (!isOpen) { alert(`请先打开${transport === 'network' ? '网络' : '串口'}`); return false; }
    if (!bytes.length) return false;
    const res = transport === 'network'
      ? await window.networkAPI.write(bytes, { address: $('cfg-network-remote-address').value.trim(), port: Number($('cfg-network-remote-port').value) })
      : await window.serialAPI.write(bytes);
    if (!res.ok) { alert('发送失败: ' + res.error); return false; }
    stats.tx += bytes.length;
    addPacket('tx', bytes, fmt);   // fmt: 'hex' | 'str' — controls echo display
    return true;
  }

  async function writeUpgradeBytes(bytes, lockedPeer = null) {
    if (!isOpen) throw new Error(`请先打开${transport === 'network' ? '网络' : '串口'}`);
    const target = lockedPeer || { address: $('cfg-network-remote-address').value.trim(), port: Number($('cfg-network-remote-port').value) };
    const res = transport === 'network'
      ? await window.networkAPI.write(bytes, { address: target.address, port: Number(target.port) })
      : await window.serialAPI.write(bytes);
    if (!res.ok) throw new Error(res.error || '发送失败');
    stats.tx += bytes.length;
    addPacket('tx', Array.from(bytes), 'hex', transport === 'network' ? { address: target.address, port: Number(target.port) } : null);
    return res.n;
  }
  async function doSend() {
    let bytes;
    const text = $('send-text').value;
    const hex = $('send-hex').checked;
    if (hex) {
      bytes = parseHexInput(text);
      if (!bytes.length) { alert('HEX 内容为空或无效'); return; }
    } else {
      bytes = Array.from(new TextEncoder().encode(text));
    }
    if ($('send-crlf').checked) bytes.push(0x0d, 0x0a);
    await writeBytes(bytes, hex ? 'hex' : 'str');
  }
  function startTimedSend() {
    stopTimedSend();
    const iv = Math.max(10, parseInt($('send-interval').value) || 1000);
    sendTimer = setInterval(doSend, iv);
    doSend();
  }
  function stopTimedSend() {
    if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
    $('send-timed').checked = false;
  }

  // ── multi send ───────────────────────────────────────────────────────────
  function autoCommandName(command, index) {
    return `指令 ${index}`;
  }

  function renumberMultiRows() {
    [...$('multi-rows').children].forEach((row, index) => {
      row.querySelector('.multi-order').value = index + 1;
    });
  }

  function addMultiRow(value = '', name = '') {
    const rows = $('multi-rows');
    const index = rows.children.length + 1;
    const row = document.createElement('div');
    row.className = 'multi-row';

    const enabled = document.createElement('input');
    enabled.type = 'checkbox'; enabled.checked = true; enabled.className = 'multi-enable';

    const command = document.createElement('input');
    command.type = 'text'; command.className = 'multi-command'; command.value = value;
    command.placeholder = `第 ${index} 条指令`;

    const nameButton = document.createElement('button');
    nameButton.type = 'button'; nameButton.className = 'multi-name';
    nameButton.textContent = name || autoCommandName(value, index);
    let clickTimer = null;
    let editingName = false;
    let previousName = '';
    const finishNameEdit = (cancel = false) => {
      if (!editingName) return;
      const edited = nameButton.textContent.trim();
      nameButton.textContent = cancel ? previousName : (edited || previousName || '未命名指令');
      nameButton.contentEditable = 'false';
      nameButton.classList.remove('editing');
      editingName = false;
      schedulePersist();
    };
    const beginNameEdit = () => {
      previousName = nameButton.textContent.trim();
      editingName = true;
      nameButton.contentEditable = 'true';
      nameButton.classList.add('editing');
      nameButton.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(nameButton);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    nameButton.addEventListener('click', (event) => {
      if (clickTimer) clearTimeout(clickTimer);
      if (event.detail >= 2) {
        clickTimer = null;
        beginNameEdit();
        return;
      }
      if (editingName) return;
      clickTimer = setTimeout(() => {
        clickTimer = null;
        sendOneRaw(command.value, $('multi-hex').checked);
      }, 240);
    });
    nameButton.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finishNameEdit(false);
        nameButton.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finishNameEdit(true);
        nameButton.blur();
      }
    });
    nameButton.addEventListener('blur', () => finishNameEdit(false));

    const order = document.createElement('input');
    order.type = 'number'; order.min = '1'; order.value = index; order.className = 'multi-order';

    const wait = document.createElement('input');
    wait.type = 'number'; wait.min = '10'; wait.value = $('multi-interval').value || '1000'; wait.className = 'multi-delay';

    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'multi-send'; remove.textContent = '×'; remove.title = '删除';
    remove.addEventListener('click', () => { row.remove(); renumberMultiRows(); schedulePersist(); });

    [enabled, command, order, wait].forEach((control) => {
      control.addEventListener('input', schedulePersist);
      control.addEventListener('change', schedulePersist);
    });

    row.append(enabled, command, nameButton, order, wait, remove);
    rows.appendChild(row);
    schedulePersist();
  }
  async function sendOneRaw(text, hex) {
    const bytes = hex ? parseHexInput(text) : Array.from(new TextEncoder().encode(text));
    await writeBytes(bytes, hex ? 'hex' : 'str');
  }
  async function runMultiSequence() {
    if (!isOpen) { alert(`请先打开${transport === 'network' ? '网络' : '串口'}`); return; }
    stopMultiSend();
    const entries = [...$('multi-rows').children]
      .filter((row) => row.querySelector('.multi-enable').checked && row.querySelector('.multi-command').value.trim())
      .map((row) => ({
        text: row.querySelector('.multi-command').value,
        order: parseInt(row.querySelector('.multi-order').value) || 0,
        delay: Math.max(10, parseInt(row.querySelector('.multi-delay').value) || parseInt($('multi-interval').value) || 1000)
      }))
      .sort((a, b) => a.order - b.order);
    const hex = $('multi-hex').checked;
    let running = true;
    const loop = $('multi-loop').checked;
    multiTimer = { stop: () => (running = false) };
    do {
      for (const entry of entries) {
        if (!running || !isOpen) return;
        await sendOneRaw(entry.text, hex);
        await delay(entry.delay);
      }
    } while (loop && running && isOpen);
  }
  function stopMultiSend() {
    if (multiTimer) { multiTimer.stop(); multiTimer = null; }
    $('multi-loop').checked = false;
  }

  // ── protocol parse ───────────────────────────────────────────────────────
  function parseSelected() {
    if (!Protocol.isLoaded()) { alert('请先加载协议解析工具'); return; }
    const bytes = selectedBytes();
    if (!bytes.length) { alert('请先在接收区选择一条或多条报文'); return; }
    const hex = frameHexForParse(bytes);
    const r = Protocol.parseHex(hex);
    const meta = `手动解析 · ${bytes.length}字节 · ${new Date().toLocaleTimeString()}<br>${hex}`;
    Protocol.showResult(
      r.html || `<span style="color:#cf222e">解析失败: ${escapeHtml(r.reason || '')}</span>`,
      meta, !(r.ok && r.valid));
  }

  function autoParsePacket(pkt) {
    const hex = frameHexForParse(pkt.bytes);
    const r = Protocol.parseHex(hex);
    const meta = `自动解析 · ${pkt.bytes.length}字节 · ${fmtTime(pkt.time)}<br>${hex}`;
    Protocol.showResult(
      r.html || `<span style="color:#cf222e">解析失败: ${escapeHtml(r.reason || '')}</span>`,
      meta, !(r.ok && r.valid));
  }

  // ── baud auto-detection ──────────────────────────────────────────────────
  // "Good" data = high printable-ASCII ratio (text/logs), OR a protocol tool is
  // loaded and successfully parses it (binary frames). Wrong baud → neither.
  function printableRatio(bytes) {
    if (!bytes.length) return 0;
    let p = 0;
    for (const b of bytes) if (b === 9 || b === 10 || b === 13 || (b >= 0x20 && b <= 0x7e)) p++;
    return p / bytes.length;
  }
  function dataLooksGood(bytes) {
    if (printableRatio(bytes) >= 0.75) return true;            // readable text/log
    if (Protocol.isLoaded()) return Protocol.parseHex(bytesToHex(bytes)).valid; // binary protocol
    return false;
  }

  function getCandidates() {
    const raw = $('baud-candidates').value.split(/[,\s]+/).map((s) => parseInt(s)).filter((n) => n > 0);
    return raw.length ? raw : [9600, 115200, 57600, 38400, 19200, 4800, 2400, 1200];
  }

  // Collect rx packets arriving in the next `dwell` ms, return the longest.
  function collectDuring(dwell) {
    return new Promise((resolve) => {
      const startLen = packets.length;
      setTimeout(() => {
        const grabbed = [];
        for (let i = startLen; i < packets.length; i++) if (packets[i].dir === 'rx') grabbed.push(packets[i]);
        grabbed.sort((a, b) => b.bytes.length - a.bytes.length);
        resolve(grabbed[0] || null);
      }, dwell);
    });
  }

  async function baudScan() {
    if (scanning || !isOpen) return;
    scanning = true;
    const original = getBaud();
    const cands = getCandidates();
    const dwell = 1500;
    setScanBadge(true);
    let found = null;
    for (const baud of cands) {
      $('baud-status').textContent = `波特率自适应：尝试 ${baud} bps …`;
      const r = await window.serialAPI.setBaud(baud);
      if (!r.ok) continue;
      setBaudDisplay(baud);
      $('conn-state').textContent = `扫描中 @ ${baud}`;
      curRx = null; if (rxIdleTimer) { clearTimeout(rxIdleTimer); rxIdleTimer = null; }
      const pkt = await collectDuring(dwell);
      if (!pkt) { $('baud-status').textContent = `波特率 ${baud}：暂无数据`; continue; }
      if (dataLooksGood(pkt.bytes)) {
        found = baud;
        const preview = bytesToStr(pkt.bytes).slice(0, 80);
        $('baud-status').textContent = `✅ 已自动锁定波特率：${baud} bps  ｜ 样例: ${preview}`;
        if (Protocol.isLoaded() && $('auto-parse').checked) {
          const res = Protocol.parseHex(bytesToHex(pkt.bytes));
          if (res.ok) Protocol.showResult(res.html, `✅ 波特率自适应 @ ${baud}bps<br>${bytesToHex(pkt.bytes)}`);
        }
        break;
      }
    }
    if (found) {
      setBaudDisplay(found);
      $('conn-state').textContent = `已连接 @ ${found}`;
      autoBaudExhausted = false;
    } else {
      await window.serialAPI.setBaud(original);
      setBaudDisplay(original);
      $('conn-state').textContent = `已连接 @ ${original}`;
      $('baud-status').textContent = `⚠ 候选波特率均为乱码（已恢复 ${original} bps）。可在上方补充候选值后重试。`;
      autoBaudExhausted = true;  // stop auto-retriggering until good data / re-toggle
    }
    setScanBadge(false);
    scanning = false;
  }
  function setScanBadge(on) {
    const cs = $('conn-state');
    cs.className = 'badge ' + (on ? 'badge-scan' : (isOpen ? 'badge-on' : 'badge-off'));
  }

  // ── resizable splitters (drag to resize the three panes) ─────────────────
  // Key fixes for smoothness:
  //  1) A transparent full-window overlay during drag, so the cursor moving over
  //     the result/parser <iframe> doesn't swallow mousemove (that caused the
  //     drag to freeze). The overlay keeps events flowing to the window.
  //  2) requestAnimationFrame throttling so we resize at most once per frame
  //     instead of thrashing layout/iframe reflow on every mousemove.
  function initSplitters() {
    let drag = null, lastX = 0, lastY = 0, raf = null;

    const overlay = document.createElement('div');
    overlay.id = 'drag-overlay';
    document.body.appendChild(overlay);

    function apply() {
      raf = null;
      if (!drag) return;
      if (drag.kind === 'left') {
        $('left').style.width = Math.min(480, Math.max(150, lastX)) + 'px';
      } else if (drag.kind === 'right') {
        $('right').style.width = (window.innerWidth - lastX) + 'px';
      } else if (drag.kind === 'right-inner') {
        const right = $('right').getBoundingClientRect();
        const width = lastX - right.left;
        $('multi-view').style.flex = `0 0 ${width}px`;
        $('multi-view').style.width = `${width}px`;
        $('protocol-view').style.flex = '1 1 0';
      } else if (drag.kind === 'right-upgrade') {
        const right = $('right').getBoundingClientRect();
        const width = Math.min(right.width - 180, Math.max(260, right.right - lastX));
        $('upgrade-view').style.flex = `0 0 ${width}px`;
        $('upgrade-view').style.width = `${width}px`;
      } else if (drag.kind === 'upgrade-inner') {
        const area = document.querySelector('.upgrade-split').getBoundingClientRect();
        const height = Math.min(area.height - 110, Math.max(120, lastY - area.top));
        $('up-log-section').style.flex = `0 0 ${height}px`;
        $('up-parser-section').style.flex = '1 1 0';
      } else if (drag.kind === 'send') {
        const center = $('center').getBoundingClientRect();
        const h = Math.min(center.height - 80, Math.max(70, center.bottom - lastY));
        $('center').querySelector('.send-area').style.height = h + 'px';
      }
    }

    document.querySelectorAll('.vsplit, .hsplit').forEach((sp) => {
      sp.addEventListener('mousedown', (e) => {
        drag = { kind: sp.dataset.resize };
        overlay.style.cursor = sp.classList.contains('hsplit') ? 'row-resize' : 'col-resize';
        overlay.style.display = 'block';
        e.preventDefault();
      });
    });
    function onMove(e) {
      if (!drag) return;
      lastX = e.clientX; lastY = e.clientY;
      if (!raf) raf = requestAnimationFrame(apply);   // throttle to one resize / frame
    }
    function onUp() {
      if (!drag) return;
      drag = null;
      overlay.style.display = 'none';
      if (raf) { cancelAnimationFrame(raf); raf = null; }
    }
    overlay.addEventListener('mousemove', onMove);
    window.addEventListener('mousemove', onMove);
    overlay.addEventListener('mouseup', onUp);
    window.addEventListener('mouseup', onUp);
  }

  function updateRightLayout() {
    const multiOpen = $('multi-view').classList.contains('active');
    const protocolOpen = $('protocol-view').classList.contains('active');
    const upgradeOpen = $('upgrade-view').classList.contains('active');
    const count = Number(multiOpen) + Number(protocolOpen) + Number(upgradeOpen);
    $('right').classList.toggle('closed', count === 0);
    $('right').classList.toggle('both-open', count >= 2);
    $('right-inner-split').style.display = multiOpen && protocolOpen ? '' : 'none';
    $('upgrade-right-split').style.display = upgradeOpen && (multiOpen || protocolOpen) ? '' : 'none';
    document.querySelector('.vsplit[data-resize="right"]').style.display = count === 0 ? 'none' : '';
    $('btn-show-multi').classList.toggle('active', multiOpen);
    $('btn-show-protocol').classList.toggle('active', protocolOpen);
    $('btn-show-upgrade').classList.toggle('active', upgradeOpen);
    if (count === 2) $('right').style.width = Math.round(window.innerWidth * 0.54) + 'px';
    else if (count === 3) $('right').style.width = Math.round(window.innerWidth * 0.76) + 'px';
    else {
      $('multi-view').style.removeProperty('flex');
      $('multi-view').style.removeProperty('width');
      $('protocol-view').style.removeProperty('flex');
      $('upgrade-view').style.removeProperty('flex');
      $('upgrade-view').style.removeProperty('width');
      if (count === 1 && parseInt($('right').style.width, 10) > 600) $('right').style.width = '455px';
    }
  }

  function setPanelOpen(name, open) {
    $(name + '-view').classList.toggle('active', open);
    updateRightLayout();
  }

  function togglePanel(name) {
    setPanelOpen(name, !$(name + '-view').classList.contains('active'));
  }

  function showRightView(name) {
    setPanelOpen(name, true);
  }

  function openSerialSettings() {
    syncModalPortOptions();
    $('modal-port').value = $('cfg-port').value;
    $('modal-baud').value = getBaud();
    $('modal-gap').value = $('rx-gap').value;
    $('left').style.display = 'flex';
  }

  function closeSerialSettings() { $('left').style.display = 'none'; }

  function applySerialSettings() {
    if (!isOpen) $('cfg-port').value = $('modal-port').value;
    setBaudDisplay(Math.max(1, parseInt($('modal-baud').value) || getBaud()));
    $('rx-gap').value = Math.max(0, parseInt($('modal-gap').value) || 0);
    $('serial-summary').textContent = `数据位 ${$('cfg-data').value}　停止位 ${$('cfg-stop').value}　校验 ${$('cfg-parity').selectedOptions[0].textContent}`;
    preferredPortPath = $('cfg-port').value;
    schedulePersist();
    closeSerialSettings();
  }

  function serializeMultiRows() {
    const lines = ['[COM-Tool Multi Strings]', `hex=${$('multi-hex').checked ? 1 : 0}`];
    [...$('multi-rows').children].forEach((row, index) => {
      const key = index + 1;
      lines.push(`${key}.enabled=${row.querySelector('.multi-enable').checked ? 1 : 0}`);
      lines.push(`${key}.name=${row.querySelector('.multi-name').textContent.replace(/[\r\n=]/g, ' ')}`);
      lines.push(`${key}.command=${row.querySelector('.multi-command').value.replace(/[\r\n]/g, ' ')}`);
      lines.push(`${key}.order=${row.querySelector('.multi-order').value}`);
      lines.push(`${key}.delay=${row.querySelector('.multi-delay').value}`);
    });
    return lines.join('\r\n');
  }

  function collectPersistedSettings() {
    return {
      transport,
      port: $('cfg-port').value || preferredPortPath,
      networkLocalAddress: $('cfg-network-local-address').value,
      networkLocalPort: $('cfg-network-local-port').value,
      networkRemoteAddress: $('cfg-network-remote-address').value,
      networkRemotePort: $('cfg-network-remote-port').value,
      baud: getBaud(),
      dataBits: $('cfg-data').value,
      stopBits: $('cfg-stop').value,
      parity: $('cfg-parity').value,
      flow: $('cfg-flow').value,
      gap: $('rx-gap').value,
      rts: $('sig-rts').checked,
      dtr: $('sig-dtr').checked,
      clickParse: $('click-parse').checked,
      multiHex: $('multi-hex').checked,
      multiLoop: $('multi-loop').checked,
      multiInterval: $('multi-interval').value,
      multi: [...$('multi-rows').children].map((row) => ({
        enabled: row.querySelector('.multi-enable').checked,
        command: row.querySelector('.multi-command').value,
        name: row.querySelector('.multi-name').textContent.trim(),
        order: row.querySelector('.multi-order').value,
        delay: row.querySelector('.multi-delay').value
      }))
    };
  }

  async function savePersistedSettings() {
    clearTimeout(persistTimer);
    persistTimer = null;
    if (!persistenceReady) return;
    const settings = collectPersistedSettings();
    try {
      const saved = await window.settingsAPI.save(settings);
      if (!saved?.ok) throw new Error(saved?.error || '未知错误');
    } catch (err) {
      // Keep a browser-cache fallback only when the user profile cannot be written.
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) { /* ignore storage failures */ }
      console.error('保存本地配置失败', err);
    }
  }

  function schedulePersist() {
    if (!persistenceReady) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(savePersistedSettings, 150);
  }

  async function restorePersistedSettings() {
    let saved = null;
    try {
      const result = await window.settingsAPI.load();
      if (result?.ok && result.exists) saved = result.data;
    } catch (err) { console.error('读取本地配置失败', err); }
    // One-time migration for lists created by older versions.
    if (!saved) {
      try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { return false; }
    }
    if (!saved || typeof saved !== 'object') return false;
    if (saved.networkLocalAddress) preferredNetworkLocalAddress = saved.networkLocalAddress;
    if (saved.networkLocalPort) $('cfg-network-local-port').value = saved.networkLocalPort;
    if (saved.networkRemoteAddress) $('cfg-network-remote-address').value = saved.networkRemoteAddress;
    if (saved.networkRemotePort) $('cfg-network-remote-port').value = saved.networkRemotePort;
    setTransportMode(saved.transport);
    preferredPortPath = String(saved.port || '');
    if (saved.baud) setBaudDisplay(saved.baud);
    if (saved.dataBits) $('cfg-data').value = String(saved.dataBits);
    if (saved.stopBits) $('cfg-stop').value = String(saved.stopBits);
    if (saved.parity) $('cfg-parity').value = saved.parity;
    if (saved.flow) $('cfg-flow').value = saved.flow;
    if (saved.gap !== undefined) $('rx-gap').value = saved.gap;
    $('sig-rts').checked = Boolean(saved.rts);
    $('sig-dtr').checked = Boolean(saved.dtr);
    if (saved.clickParse !== undefined) $('click-parse').checked = Boolean(saved.clickParse);
    if (saved.multiHex !== undefined) $('multi-hex').checked = Boolean(saved.multiHex);
    if (saved.multiLoop !== undefined) $('multi-loop').checked = Boolean(saved.multiLoop);
    if (saved.multiInterval) $('multi-interval').value = saved.multiInterval;
    if (Array.isArray(saved.multi)) {
      $('multi-rows').innerHTML = '';
      saved.multi.forEach((item, index) => {
        addMultiRow(String(item.command || ''), String(item.name || autoCommandName(item.command || '', index + 1)));
        const row = $('multi-rows').lastElementChild;
        row.querySelector('.multi-enable').checked = item.enabled !== false;
        row.querySelector('.multi-order').value = item.order || index + 1;
        row.querySelector('.multi-delay').value = item.delay || saved.multiInterval || 1000;
      });
      if (!saved.multi.length) addMultiRow('', '未命名指令');
    }
    $('serial-summary').textContent = `数据位 ${$('cfg-data').value}　停止位 ${$('cfg-stop').value}　校验 ${$('cfg-parity').selectedOptions[0].textContent}`;
    return true;
  }

  async function exportMultiRows() {
    const res = await window.dialogAPI.saveMulti(serializeMultiRows());
    if (res.ok) $('baud-status').textContent = '多字符串列表已导出：' + res.path;
  }

  async function importMultiRows() {
    const res = await window.dialogAPI.openMulti();
    if (!res.ok) return;
    const props = new Map();
    String(res.text).split(/\r?\n/).forEach((line) => {
      const pos = line.indexOf('=');
      if (pos > 0) props.set(line.slice(0, pos).trim(), line.slice(pos + 1).trim());
    });
    const indexes = [...props.keys()].map((key) => Number((key.match(/^(\d+)\./) || [])[1])).filter(Boolean);
    const max = indexes.length ? Math.max(...indexes) : 0;
    $('multi-rows').innerHTML = '';
    for (let index = 1; index <= max; index++) {
      const command = props.get(`${index}.command`) || '';
      const name = props.get(`${index}.name`) || autoCommandName(command, index);
      addMultiRow(command, name);
      const row = $('multi-rows').lastElementChild;
      row.querySelector('.multi-enable').checked = props.get(`${index}.enabled`) !== '0';
      row.querySelector('.multi-order').value = props.get(`${index}.order`) || index;
      row.querySelector('.multi-delay').value = props.get(`${index}.delay`) || $('multi-interval').value;
    }
    $('multi-hex').checked = props.get('hex') !== '0';
    if (!max) addMultiRow('', '未命名指令');
    schedulePersist();
    $('baud-status').textContent = '多字符串列表已导入：' + res.path;
  }

  // ── wire up UI ───────────────────────────────────────────────────────────
  function bind() {
    $('btn-new-window').addEventListener('click', () => window.windowAPI.create());
    $('btn-serial-settings').addEventListener('click', openSerialSettings);
    $('btn-more-settings').addEventListener('click', openSerialSettings);
    $('btn-settings-close').addEventListener('click', closeSerialSettings);
    $('btn-settings-cancel').addEventListener('click', closeSerialSettings);
    $('btn-settings-apply').addEventListener('click', applySerialSettings);
    $('left').addEventListener('click', (event) => { if (event.target === $('left')) closeSerialSettings(); });
    $('btn-show-multi').addEventListener('click', () => togglePanel('multi'));
    $('btn-show-protocol').addEventListener('click', () => togglePanel('protocol'));
    $('btn-refresh').addEventListener('click', refreshPorts);
    $('btn-refresh-network').addEventListener('click', refreshNetworkAddresses);
    $('cfg-transport').addEventListener('change', (event) => { if (!isOpen) setTransportMode(event.target.value); });
    $('cfg-network-local-address').addEventListener('change', () => { preferredNetworkLocalAddress = $('cfg-network-local-address').value; schedulePersist(); });
    ['cfg-network-local-port', 'cfg-network-remote-address', 'cfg-network-remote-port'].forEach((id) => $(id).addEventListener('change', schedulePersist));
    $('cfg-port').addEventListener('change', () => { preferredPortPath = $('cfg-port').value; schedulePersist(); });
    $('btn-open').addEventListener('click', () => (isOpen ? closePort() : openTransport()));
    $('cfg-baud').addEventListener('change', () => { onBaudSelChange(); schedulePersist(); });
    $('cfg-baud-custom').addEventListener('change', () => { if (isOpen && !scanning) { window.serialAPI.setBaud(getBaud()); $('conn-state').textContent = `已连接 @ ${getBaud()}`; } schedulePersist(); });
    ['cfg-data', 'cfg-stop', 'cfg-parity', 'cfg-flow', 'rx-gap', 'sig-dtr', 'sig-rts'].forEach((id) => $(id).addEventListener('change', schedulePersist));
    const applySignals = () => { if (transport === 'serial' && isOpen) window.serialAPI.setSignals({ dtr: $('sig-dtr').checked, rts: $('sig-rts').checked }); };
    $('sig-dtr').addEventListener('change', applySignals);
    $('sig-rts').addEventListener('change', applySignals);

    ['rx-mode', 'rx-time', 'rx-showtx'].forEach((i) => $(i).addEventListener('change', rerenderAll));
    $('click-parse').addEventListener('change', schedulePersist);
    $('rx-mode-check').addEventListener('change', (event) => {
      $('rx-mode').value = event.target.checked ? 'hex' : 'str';
      rerenderAll();
    });
    $('btn-auto-scroll').addEventListener('click', (event) => {
      autoScroll = !autoScroll;
      event.currentTarget.textContent = autoScroll ? '自动滚动' : '停止滚动';
      event.currentTarget.classList.toggle('primary', autoScroll);
    });
    $('btn-pause').addEventListener('click', (event) => {
      receivePaused = !receivePaused;
      event.currentTarget.textContent = receivePaused ? '继续接收' : '暂停';
      event.currentTarget.classList.toggle('primary', receivePaused);
    });
    $('btn-clear').addEventListener('click', () => {
      packets = []; selected.clear(); $('rx-list').innerHTML = '';
      curRx = null; if (rxIdleTimer) { clearTimeout(rxIdleTimer); rxIdleTimer = null; }
      resetStats();                       // 清空接收同时重置统计
    });
    $('btn-save').addEventListener('click', saveLog);
    $('btn-reset-stat').addEventListener('click', resetStats);

    // send tabs
    document.querySelectorAll('.stab').forEach((tab) => tab.addEventListener('click', () => {
      document.querySelectorAll('.stab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.send-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $('panel-' + tab.dataset.tab).classList.add('active');
    }));

    $('btn-send').addEventListener('click', doSend);
    $('btn-clear-send').addEventListener('click', () => { $('send-text').value = ''; });
    $('send-timed').addEventListener('change', (e) => (e.target.checked ? startTimedSend() : stopTimedSend()));
    $('btn-sendfile').addEventListener('click', sendFile);
    $('btn-add-multi').addEventListener('click', () => addMultiRow());
    $('btn-multi-start').addEventListener('click', runMultiSequence);
    $('btn-multi-import').addEventListener('click', importMultiRows);
    $('btn-multi-export').addEventListener('click', exportMultiRows);
    $('multi-loop').addEventListener('change', (e) => { if (!e.target.checked) stopMultiSend(); schedulePersist(); });
    ['multi-hex', 'multi-interval'].forEach((id) => {
      $(id).addEventListener('input', schedulePersist);
      $(id).addEventListener('change', schedulePersist);
    });

    // protocol
    $('btn-load-proto').addEventListener('click', addProtocolToLibrary);
    $('proto-library-list').addEventListener('change', loadProtocolFromLibrary);
    $('btn-proto-open-dir').addEventListener('click', openProtocolLibrary);
    $('btn-proto-refresh').addEventListener('click', () => refreshProtocolLibrary());
    $('btn-parse-sel').addEventListener('click', parseSelected);
    $('btn-clear-result').addEventListener('click', () => Protocol.clearResults());

    // protocol-tool generator window (报文生成 → 导入发送框)
    $('btn-gen-cmd').addEventListener('click', openGenerator);
    $('btn-gen-close').addEventListener('click', closeGenerator);
    $('btn-gen-import').addEventListener('click', () => importGenerated(false));
    $('btn-gen-import-multi').addEventListener('click', () => importGenerated(false, true));
    $('btn-gen-send').addEventListener('click', () => importGenerated(true));
    $('gen-modal').addEventListener('click', (e) => { if (e.target.id === 'gen-modal') closeGenerator(); });
    $('auto-baud').addEventListener('change', (e) => {
      $('baud-cfg-row').style.display = e.target.checked ? 'flex' : 'none';
      autoBaudExhausted = false;          // re-arm scanning when user toggles it on
    });
    $('auto-parse').addEventListener('change', (event) => {
      $('status-auto').textContent = event.target.checked ? '开启' : '关闭';
    });

    // serial events
    window.serialAPI.onData(onSerialData);
    window.serialAPI.onError((msg) => { $('baud-status').textContent = '串口错误: ' + msg; });
    window.serialAPI.onClosed(() => setOpenState(false));
    window.networkAPI.onData(onNetworkData);
    window.networkAPI.onError((msg) => { $('baud-status').textContent = '网络错误: ' + msg; });
    window.networkAPI.onClosed(() => setOpenState(false));

    updateBaudInfo();

    initSplitters();
    // Closing an Electron window destroys the renderer quickly.  Use the
    // synchronous IPC variant here so a just-added command cannot be lost.
    window.addEventListener('beforeunload', () => {
      if (!persistenceReady) return;
      try { window.settingsAPI.saveSync(collectPersistedSettings()); } catch (err) { console.error('退出前保存本地配置失败', err); }
    });
  }

  // ── protocol-tool generator: open its 报文生成 UI, import the built frame ────
  async function openGenerator() {
    if (!Protocol.isLoaded()) { alert('请先加载协议解析工具（需带"报文生成"功能）'); return; }
    $('gen-modal').style.display = 'flex';
    try {
      await Protocol.openGeneratorInto($('gen-frame'));
    } catch (err) {
      alert('打开生成器失败: ' + err.message);
      closeGenerator();
    }
  }
  function closeGenerator() { $('gen-modal').style.display = 'none'; }

  // Pull the generated HEX frame out of the tool and drop it into the send box.
  function importGenerated(alsoSend, toMulti = false) {
    const hex = Protocol.readGenerated($('gen-frame'));
    if (!hex) { alert('未读到生成的帧。请先在生成器里填好参数并点「生成帧」，再导入。'); return; }
    if (toMulti) {
      const generatedName = Protocol.readGeneratedName($('gen-frame'));
      addMultiRow(hex, generatedName || autoCommandName(hex, $('multi-rows').children.length + 1));
      showRightView('multi');
    } else {
      $('send-hex').checked = true;
      $('send-text').value = hex;
    }
    closeGenerator();
    $('baud-status').textContent = toMulti ? '已导入生成指令到多字符串列表: ' + hex : '已导入生成指令到发送框: ' + hex;
    if (alsoSend) doSend();
  }

  async function refreshProtocolLibrary(selectPath = protocolLibraryPath) {
    try {
      const [res, info] = await Promise.all([window.libraryAPI.list('parsers'), window.libraryAPI.info()]);
      const select = $('proto-library-list');
      select.innerHTML = '';
      if (!res.ok || !res.items.length) select.add(new Option('资料库中没有协议解析工具', ''));
      else for (const item of res.items) select.add(new Option(item.name, item.path));
      if (selectPath && [...select.options].some((item) => item.value === selectPath)) select.value = selectPath;
      if (info.ok) $('proto-library-path').textContent = info.fallback ? `资料库：${info.root}（安装目录不可写，已回退）` : `资料库：${info.root}`;
    } catch (err) { $('proto-library-path').textContent = `资料库读取失败：${err.message || err}`; }
  }

  async function loadProtocolFromLibrary() {
    const filePath = $('proto-library-list').value;
    if (!filePath) return;
    try {
      const info = await Protocol.loadFromLibrary(filePath);
      protocolLibraryPath = filePath;
      const b = $('proto-name');
      b.textContent = '协议: ' + info.name;
      b.className = 'badge badge-on';
      $('status-proto').textContent = info.name;
      showRightView('protocol');
    } catch (err) {
      alert('加载失败: ' + err.message);
      $('proto-name').textContent = '加载失败';
      $('proto-name').className = 'badge badge-off';
    }
  }

  async function addProtocolToLibrary() {
    try {
      const res = await window.libraryAPI.import('parsers');
      if (!res?.ok) {
        if (res?.error) alert(`协议解析工具添加失败：${res.error}`);
        return;
      }
      await refreshProtocolLibrary(res.path);
      await loadProtocolFromLibrary();
    } catch (err) { alert(`协议解析工具添加失败：${err.message || err}`); }
  }

  async function openProtocolLibrary() {
    try {
      const res = await window.libraryAPI.open('parsers');
      if (!res?.ok) alert(`打开资料库失败：${res?.error || '未知错误'}`);
    } catch (err) { alert(`打开资料库失败：${err.message || err}`); }
  }

  async function saveLog() {
    const viewMode = $('rx-mode').value;
    const text = packets.map((p) => {
      const ts = $('rx-time').checked ? `[${fmtTime(p.time)}] ` : '';
      const mode = (p.dir === 'tx' && p.fmt) ? p.fmt : viewMode;
      const body = mode === 'hex' ? bytesToHex(p.bytes) : bytesToStr(p.bytes);
      return `${ts}${p.dir === 'tx' ? '→' : '←'} ${body}`;
    }).join('\r\n');
    const res = await window.dialogAPI.saveLog(text);
    if (res.ok) $('baud-status').textContent = '已保存: ' + res.path;
  }

  async function sendFile() {
    const res = await window.dialogAPI.openSendFile();
    if (!res.ok) return;
    await writeBytes(res.bytes, 'hex');   // 文件多为二进制，按 HEX 回显
  }

  // ── go ───────────────────────────────────────────────────────────────────
  bind();
  Upgrade.init({
    isOpen: () => isOpen,
    getTransport: () => transport,
    networkTarget: () => ({ address: $('cfg-network-remote-address').value.trim(), port: Number($('cfg-network-remote-port').value) }),
    send: writeUpgradeBytes,
    setUpgradeLock: (locked) => {
      if (locked) { stopTimedSend(); stopMultiSend(); }
      ['btn-send', 'btn-sendfile', 'btn-multi-start', 'btn-add-multi', 'btn-multi-import', 'btn-multi-export', 'btn-gen-cmd', 'auto-baud', 'send-timed'].forEach((id) => { $(id).disabled = locked; });
    },
    setPanelOpen
  });
  (async () => {
    const restored = await restorePersistedSettings();
    if (!restored) addMultiRow('', '未命名指令');
    persistenceReady = true;
    // Write one canonical file after restore/migration.  The default row is not
    // allowed to overwrite the list before the restore result is known.
    await savePersistedSettings();
    refreshPorts();
    refreshNetworkAddresses();
    refreshProtocolLibrary();
    updateStats();
  })();
})();
