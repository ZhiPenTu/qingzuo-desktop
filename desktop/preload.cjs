const { contextBridge, ipcRenderer } = require('electron');
const normalizeError = error => new Error((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
contextBridge.exposeInMainWorld('commerceDesktop', Object.freeze({
  invoke: (method, args = {}) => ipcRenderer.invoke('commerce:platform', method, args).catch(error => { throw normalizeError(error); }),
  onChanged: callback => { const listener = () => callback(); ipcRenderer.on('commerce:changed', listener); return () => ipcRenderer.removeListener('commerce:changed', listener); },
  onAI: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('commerce:ai', listener); return () => ipcRenderer.removeListener('commerce:ai', listener); },
}));
