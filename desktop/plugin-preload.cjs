const { contextBridge, ipcRenderer } = require('electron');
const id = process.argv.find(value => value.startsWith('--commerce-plugin='))?.slice('--commerce-plugin='.length);
contextBridge.exposeInMainWorld('commercePlugin', Object.freeze({
  id, invoke: (method, args = {}) => ipcRenderer.invoke('commerce:plugin', method, args),
  onDispose: callback => { const listener = () => callback(); ipcRenderer.on('commerce:dispose', listener); return () => ipcRenderer.removeListener('commerce:dispose', listener); },
  onAI: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('commerce:ai', listener); return () => ipcRenderer.removeListener('commerce:ai', listener); },
}));
