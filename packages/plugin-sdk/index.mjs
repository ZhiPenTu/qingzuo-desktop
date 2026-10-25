export function createPluginClient(bridge = globalThis.commercePlugin) {
  if (!bridge) throw new Error('请在电商工具中心打开此插件。');
  const invoke = (method, args = {}) => bridge.invoke(method, args);
  return Object.freeze({
    invoke,
    files: { pick: options => invoke('files.pick', options), pickMany: options => invoke('files.pickMany', options), pickDirectory: () => invoke('files.pickDirectory'), read: token => invoke('files.read', { token }), create: options => invoke('files.create', options),
      url: token => invoke('files.url', { token }), release: token => invoke('files.release', { token }),
      save: (token, filename) => invoke('files.save', { token, filename }) },
    credentials: { set: (name, value) => invoke('credentials.set', { name, value }),
      status: name => invoke('credentials.status', { name }), clear: name => invoke('credentials.clear', { name }) },
    network: { request: options => invoke('network.request', options), sign: options => invoke('network.sign', options) },
    services: { call: (service, method, args) => invoke('services.call', { service, method, args }) },
    tasks: { cancel: id => invoke('tasks.cancel', { id }) },
    browser: {
      status: () => invoke('browser.status'),
      rescan: tabId => invoke('browser.rescan', tabId ? { id: tabId } : {}),
      download: options => invoke('browser.download', options),
      cancel: id => invoke('browser.cancel', { id }),
      open: url => invoke('browser.open', { url }),
      snapshot: options => invoke('browser.snapshot', options ?? {}),
      act: options => invoke('browser.act', options),
      waitFor: options => invoke('browser.waitFor', options),
      saveResource: options => invoke('browser.saveResource', options),
      onEvent: callback => bridge.onBrowser?.(callback) || (() => {}),
    },
    storage: { get: key => invoke('storage.get', { key }), set: (key, value) => invoke('storage.set', { key, value }), keys: () => invoke('storage.keys'), remove: key => invoke('storage.remove', { key }),
      saveFile: options => invoke('storage.saveFile', options), readFile: token => invoke('storage.readFile', { token }), removeFile: token => invoke('storage.removeFile', { token }) },
    ai: {
      models: options => invoke('ai.models', options),
      textModels: () => invoke('ai.textModels'),
      complete: options => invoke('ai.complete', options),
      batch: Object.fromEntries(['create', 'get', 'list', 'revise', 'start', 'cancel', 'preview'].map(method => [method, args => invoke('ai.batch.' + method, args)])),
      assistant: Object.fromEntries(['send', 'status', 'cancel'].map(method => [method, args => invoke('ai.assistant.' + method, args)])),
      onEvent: callback => bridge.onAI?.(callback) || (() => {}),
    },
    registerTool: value => invoke('contributions.tool', value),
    registerSettings: value => invoke('contributions.settings', value),
    onDispose: callback => bridge.onDispose(callback),
  });
}
