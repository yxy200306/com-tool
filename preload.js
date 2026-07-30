const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serialAPI', {
  list: () => ipcRenderer.invoke('serial:list'),
  open: (opts) => ipcRenderer.invoke('serial:open', opts),
  close: () => ipcRenderer.invoke('serial:close'),
  setBaud: (baud) => ipcRenderer.invoke('serial:setBaud', baud),
  write: (bytes) => ipcRenderer.invoke('serial:write', bytes),
  setSignals: (sig) => ipcRenderer.invoke('serial:setSignals', sig),
  onData: (cb) => ipcRenderer.on('serial:data', (_event, bytes) => cb(bytes)),
  onError: (cb) => ipcRenderer.on('serial:error', (_event, message) => cb(message)),
  onClosed: (cb) => ipcRenderer.on('serial:closed', () => cb())
});

contextBridge.exposeInMainWorld('windowAPI', {
  create: () => ipcRenderer.invoke('window:new'),
  onSession: (cb) => ipcRenderer.on('window:session', (_event, id) => cb(id))
});

contextBridge.exposeInMainWorld('dialogAPI', {
  openProtocol: () => ipcRenderer.invoke('dialog:openProtocol'),
  readProtocol: (filePath) => ipcRenderer.invoke('protocol:read', filePath),
  saveLog: (text) => ipcRenderer.invoke('dialog:saveLog', text),
  openSendFile: () => ipcRenderer.invoke('dialog:openSendFile'),
  openMulti: () => ipcRenderer.invoke('dialog:openMulti'),
  saveMulti: (text) => ipcRenderer.invoke('dialog:saveMulti', text)
});
