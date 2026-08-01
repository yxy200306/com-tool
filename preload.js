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

contextBridge.exposeInMainWorld('networkAPI', {
  listAddresses: () => ipcRenderer.invoke('network:listAddresses'),
  open: (opts) => ipcRenderer.invoke('network:open', opts),
  close: () => ipcRenderer.invoke('network:close'),
  write: (bytes, target) => ipcRenderer.invoke('network:write', bytes, target),
  onData: (cb) => ipcRenderer.on('network:data', (_event, payload) => cb(payload)),
  onError: (cb) => ipcRenderer.on('network:error', (_event, message) => cb(message)),
  onClosed: (cb) => ipcRenderer.on('network:closed', () => cb())
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

contextBridge.exposeInMainWorld('settingsAPI', {
  load: () => ipcRenderer.invoke('settings:load'),
  save: (data) => ipcRenderer.invoke('settings:save', data),
  saveSync: (data) => ipcRenderer.sendSync('settings:saveSync', data)
});

contextBridge.exposeInMainWorld('libraryAPI', {
  info: () => ipcRenderer.invoke('library:info'),
  list: (kind) => ipcRenderer.invoke('library:list', kind),
  import: (kind) => ipcRenderer.invoke('library:import', kind),
  read: (filePath, kind) => ipcRenderer.invoke('library:read', filePath, kind),
  open: (kind) => ipcRenderer.invoke('library:open', kind),
  openFirmware: () => ipcRenderer.invoke('upgrade:openFirmware'),
  hash: (bytes, algorithm) => ipcRenderer.invoke('upgrade:hash', bytes, algorithm)
});
