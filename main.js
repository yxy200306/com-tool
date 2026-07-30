// COM-Tool V2.0 main process: one independent serial session per window.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// V2 uses its own profile and single-instance lock, so it can coexist with V1.
app.setPath('userData', process.env.COMTOOL_USER_DATA || path.join(app.getPath('appData'), 'COM-Tool-V2'));

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

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'COM-Tool V2.0 串口调试助手',
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
    currentBaud: 9600
  };
  sessions.set(session.id, session);
  lastFocusedId = session.id;

  win.on('focus', () => { lastFocusedId = session.id; });
  win.on('closed', () => {
    sessions.delete(session.id);
    closeSessionPort(session);
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
