// COM-Tool V2.1 main process: one independent serial session per window.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const os = require('os');
const net = require('net');
const crypto = require('crypto');

const LIBRARY_DIRS = { parsers: 'protocol-tools', packages: 'upgrade-packages' };

function canUseDirectory(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.com-tool-write-${process.pid}.tmp`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (_) { return false; }
}

function libraryRoot() {
  // Portable builds expose their containing directory. Installed applications may
  // live under a protected directory, so fall back to the app profile safely.
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  const besideExecutable = portableDir || path.dirname(process.execPath);
  if (canUseDirectory(besideExecutable)) return besideExecutable;
  const fallback = path.join(app.getPath('userData'), 'library');
  canUseDirectory(fallback);
  return fallback;
}

function libraries() {
  const root = libraryRoot();
  const result = { root, fallback: root.startsWith(app.getPath('userData')) };
  for (const [key, name] of Object.entries(LIBRARY_DIRS)) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    result[key] = dir;
  }
  return result;
}

function safeCopyToLibrary(source, targetDir) {
  const original = path.basename(source);
  const parsed = path.parse(original);
  let target = path.join(targetDir, original);
  let suffix = 1;
  while (fs.existsSync(target)) target = path.join(targetDir, `${parsed.name}-${suffix++}${parsed.ext}`);
  fs.copyFileSync(source, target);
  return target;
}

// The application uses its own profile and single-instance lock.
app.setPath('userData', process.env.COMTOOL_USER_DATA || path.join(app.getPath('appData'), 'COM-Tool-V2'));

function settingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettingsFile() {
  const filePath = settingsFilePath();
  if (!fs.existsSync(filePath)) return { ok: true, exists: false, data: null };
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { ok: true, exists: true, data };
  } catch (err) {
    return { ok: false, exists: true, error: `配置文件读取失败：${err.message}` };
  }
}

function writeSettingsFile(data) {
  const filePath = settingsFilePath();
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
    return { ok: false, error: `配置文件保存失败：${err.message}` };
  }
}

let SerialPortMod = null;
function loadSerialPort() {
  if (!SerialPortMod) SerialPortMod = require('serialport');
  return SerialPortMod;
}

const sessions = new Map(); // webContents.id -> { id, win, port, portPath, currentBaud }
let lastFocusedId = null;

function sessionForSender(sender) {
  return sender ? sessions.get(sender.id) : null;
}

function activeSession() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) {
    const hit = sessions.get(focused.webContents.id);
    if (hit) return hit;
  }
  if (lastFocusedId && sessions.has(lastFocusedId)) return sessions.get(lastFocusedId);
  return sessions.values().next().value || null;
}

function sendToSession(session, channel, payload) {
  if (session && session.win && !session.win.isDestroyed()) {
    session.win.webContents.send(channel, payload);
  }
}

function closeSessionPort(session) {
  return new Promise((resolve) => {
    if (!session) return resolve();
    const current = session.port;
    session.port = null;
    if (current && current.isOpen) current.close(() => resolve());
    else resolve();
  });
}

function closeSessionNetwork(session) {
  return new Promise((resolve) => {
    if (!session) return resolve();
    const current = session.socket;
    session.socket = null;
    session.networkConfig = null;
    if (!current) return resolve();
    current.once('close', resolve);
    try { current.close(); } catch (_) { resolve(); }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'COM-Tool V2.1 串口调试助手',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  win.setMenuBarVisibility(false);
  const session = {
    id: win.webContents.id,
    win,
    port: null,
    portPath: null,
    currentBaud: 9600,
    socket: null,
    networkConfig: null
  };
  sessions.set(session.id, session);
  lastFocusedId = session.id;

  win.on('focus', () => { lastFocusedId = session.id; });
  win.on('closed', () => {
    sessions.delete(session.id);
    closeSessionPort(session);
    closeSessionNetwork(session);
    if (lastFocusedId === session.id) lastFocusedId = sessions.keys().next().value || null;
  });
  win.webContents.on('did-finish-load', () => {
    sendToSession(session, 'window:session', session.id);
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    app.whenReady().then(() => {
      const win = createWindow();
      win.show();
      win.focus();
    });
  });

  app.whenReady().then(() => {
    createWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('window:new', () => {
  const win = createWindow();
  win.show();
  return { ok: true, id: win.webContents.id };
});

async function listSerialPorts() {
  try {
    const { SerialPort } = loadSerialPort();
    return { ok: true, ports: await SerialPort.list() };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

ipcMain.handle('serial:list', listSerialPorts);

ipcMain.handle('serial:open', async (event, opts) => {
  const session = sessionForSender(event.sender);
  if (!session) return { ok: false, error: 'window session not found' };
  try {
    const { SerialPort } = loadSerialPort();
    await closeSessionNetwork(session);
    await closeSessionPort(session);
    const openedPort = new SerialPort({
      path: opts.path,
      baudRate: Number(opts.baudRate) || 9600,
      dataBits: Number(opts.dataBits) || 8,
      stopBits: Number(opts.stopBits) || 1,
      parity: opts.parity || 'none',
      rtscts: !!opts.rtscts,
      autoOpen: false
    });
    session.port = openedPort;
    session.portPath = opts.path;
    session.currentBaud = Number(opts.baudRate) || 9600;

    await new Promise((resolve, reject) => openedPort.open((err) => (err ? reject(err) : resolve())));
    openedPort.on('data', (buf) => sendToSession(session, 'serial:data', Array.from(buf)));
    openedPort.on('error', (err) => sendToSession(session, 'serial:error', String(err && err.message || err)));
    openedPort.on('close', () => {
      if (session.port === openedPort) session.port = null;
      sendToSession(session, 'serial:closed', null);
    });
    return { ok: true, sessionId: session.id };
  } catch (err) {
    session.port = null;
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('serial:setBaud', async (event, baudRate) => {
  const session = sessionForSender(event.sender);
  try {
    if (!session || !session.port || !session.port.isOpen) return { ok: false, error: 'port not open' };
    await new Promise((resolve, reject) => {
      session.port.update({ baudRate: Number(baudRate) }, (err) => (err ? reject(err) : resolve()));
    });
    session.currentBaud = Number(baudRate);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('serial:close', async (event) => {
  await closeSessionPort(sessionForSender(event.sender));
  return { ok: true };
});

function listNetworkAddresses() {
  const seen = new Set(['0.0.0.0', '127.0.0.1']);
  const addresses = [{ address: '0.0.0.0', label: '0.0.0.0' }];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal || seen.has(entry.address)) continue;
      seen.add(entry.address);
      addresses.push({ address: entry.address, label: entry.address });
    }
  }
  addresses.push({ address: '127.0.0.1', label: '127.0.0.1' });
  return addresses;
}

ipcMain.handle('network:listAddresses', () => ({ ok: true, addresses: listNetworkAddresses() }));

ipcMain.handle('network:open', async (event, opts) => {
  const session = sessionForSender(event.sender);
  const localAddress = String(opts?.localAddress || '0.0.0.0');
  const localPort = Number(opts?.localPort);
  if (!session) return { ok: false, error: 'window session not found' };
  if (net.isIP(localAddress) !== 4) return { ok: false, error: '本地主机地址无效' };
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) return { ok: false, error: '本地主机端口必须为 1–65535' };
  try {
    await closeSessionPort(session);
    await closeSessionNetwork(session);
    const socket = dgram.createSocket('udp4');
    session.socket = socket;
    session.networkConfig = { localAddress, localPort };
    socket.on('message', (buffer, remote) => sendToSession(session, 'network:data', {
      bytes: Array.from(buffer), remoteAddress: remote.address, remotePort: remote.port
    }));
    socket.on('error', (err) => sendToSession(session, 'network:error', String(err && err.message || err)));
    socket.on('close', () => {
      if (session.socket === socket) { session.socket = null; session.networkConfig = null; }
      sendToSession(session, 'network:closed', null);
    });
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(localPort, localAddress, () => { socket.removeListener('error', reject); resolve(); });
    });
    return { ok: true, sessionId: session.id };
  } catch (err) {
    session.socket = null;
    session.networkConfig = null;
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('network:close', async (event) => {
  await closeSessionNetwork(sessionForSender(event.sender));
  return { ok: true };
});

ipcMain.handle('network:write', async (event, bytes, target) => {
  const session = sessionForSender(event.sender);
  const address = String(target?.address || '');
  const port = Number(target?.port);
  if (!session?.socket) return { ok: false, error: '网络未打开' };
  if (net.isIP(address) !== 4) return { ok: false, error: '远端主机地址无效' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: '远端端口必须为 1–65535' };
  try {
    const buffer = Buffer.from(bytes);
    await new Promise((resolve, reject) => session.socket.send(buffer, port, address, (err) => (err ? reject(err) : resolve())));
    return { ok: true, n: buffer.length };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

async function writeSession(session, bytes) {
  if (!session || !session.port || !session.port.isOpen) throw new Error('port not open');
  const buf = Buffer.from(bytes);
  await new Promise((resolve, reject) => session.port.write(buf, (err) => (err ? reject(err) : resolve())));
  await new Promise((resolve) => session.port.drain(resolve));
  return buf.length;
}

ipcMain.handle('serial:write', async (event, bytes) => {
  try {
    return { ok: true, n: await writeSession(sessionForSender(event.sender), bytes) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('serial:setSignals', async (event, sig) => {
  const session = sessionForSender(event.sender);
  try {
    if (!session || !session.port || !session.port.isOpen) return { ok: false, error: 'port not open' };
    await new Promise((resolve, reject) => session.port.set(sig, (err) => (err ? reject(err) : resolve())));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

function parentWindow(event) {
  return BrowserWindow.fromWebContents(event.sender) || activeSession()?.win || null;
}

ipcMain.handle('dialog:openProtocol', async (event) => {
  const res = await dialog.showOpenDialog(parentWindow(event), {
    title: '选择协议解析工具（HTML）',
    filters: [{ name: '协议工具', extensions: ['html', 'htm'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  return { ok: true, path: res.filePaths[0] };
});

ipcMain.handle('protocol:read', async (_event, filePath) => {
  try {
    return { ok: true, text: fs.readFileSync(filePath, 'utf8') };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('library:info', () => {
  try { return { ok: true, ...libraries() }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

ipcMain.handle('library:list', (_event, kind) => {
  try {
    const dir = libraries()[kind];
    if (!dir) return { ok: false, error: 'unknown library type' };
    const extensions = kind === 'parsers' ? new Set(['.html', '.htm']) : new Set(['.js', '.ctup']);
    const items = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }));
    return { ok: true, dir, items };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

ipcMain.handle('library:import', async (event, kind) => {
  try {
    const dir = libraries()[kind];
    if (!dir) return { ok: false, error: '未知资料库类型' };
    const filters = kind === 'parsers'
      ? [{ name: '协议解析工具（HTML）', extensions: ['html', 'htm'] }]
      : [{ name: '升级协议包（JS / CTUP）', extensions: ['js', 'ctup'] }];
    const res = await dialog.showOpenDialog(parentWindow(event), { title: '添加到本地资料库', filters, properties: ['openFile'] });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: safeCopyToLibrary(res.filePaths[0], dir) };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

ipcMain.handle('library:read', (_event, filePath, kind) => {
  try {
    const dir = path.resolve(libraries()[kind] || '');
    const target = path.resolve(String(filePath || ''));
    if (!dir || !(target === dir || target.startsWith(dir + path.sep))) throw new Error('file is outside local library');
    return { ok: true, text: fs.readFileSync(target, 'utf8') };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

ipcMain.handle('library:open', async (event, kind) => {
  try {
    const { shell } = require('electron');
    const dir = libraries()[kind];
    if (!dir) return { ok: false, error: 'unknown library type' };
    const error = await shell.openPath(dir);
    return error ? { ok: false, error } : { ok: true, path: dir };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

ipcMain.handle('upgrade:openFirmware', async (event) => {
  const res = await dialog.showOpenDialog(parentWindow(event), { title: '选择升级文件', properties: ['openFile'] });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  try {
    const buf = fs.readFileSync(res.filePaths[0]);
    return { ok: true, path: res.filePaths[0], name: path.basename(res.filePaths[0]), bytes: Array.from(buf) };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

ipcMain.handle('upgrade:hash', (_event, bytes, algorithm) => {
  try {
    const allowed = { MD5: 'md5', 'SHA-256': 'sha256', SHA256: 'sha256' };
    const name = allowed[String(algorithm || '').toUpperCase()];
    if (!name) throw new Error('unsupported hash algorithm');
    return { ok: true, value: crypto.createHash(name).update(Buffer.from(bytes)).digest('hex').toUpperCase() };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

function dateFileName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.txt`;
}

ipcMain.handle('dialog:saveLog', async (event, text) => {
  const res = await dialog.showSaveDialog(parentWindow(event), {
    title: '保存接收数据',
    defaultPath: dateFileName(),
    filters: [{ name: '文本文件', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  try {
    fs.writeFileSync(res.filePath, text, 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('dialog:openSendFile', async (event) => {
  const res = await dialog.showOpenDialog(parentWindow(event), {
    title: '选择要发送的文件',
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  try {
    const buf = fs.readFileSync(res.filePaths[0]);
    return { ok: true, path: res.filePaths[0], bytes: Array.from(buf) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('dialog:openMulti', async (event) => {
  const res = await dialog.showOpenDialog(parentWindow(event), {
    title: '导入多字符串列表',
    filters: [{ name: '多字符串配置', extensions: ['ini', 'txt'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  try {
    return { ok: true, path: res.filePaths[0], text: fs.readFileSync(res.filePaths[0], 'utf8') };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('dialog:saveMulti', async (event, text) => {
  const res = await dialog.showSaveDialog(parentWindow(event), {
    title: '导出多字符串列表',
    defaultPath: 'COM-Tool-多字符串.ini',
    filters: [{ name: '多字符串配置', extensions: ['ini'] }, { name: '文本文件', extensions: ['txt'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  try {
    fs.writeFileSync(res.filePath, text, 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('settings:load', () => readSettingsFile());
ipcMain.handle('settings:save', (_event, data) => writeSettingsFile(data));
ipcMain.on('settings:saveSync', (event, data) => {
  event.returnValue = writeSettingsFile(data);
});
