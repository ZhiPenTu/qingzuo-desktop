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
    network: { request: options => invoke('network.request', options) },
    services: { call: (service, method, args) => invoke('services.call', { service, method, args }) },
    tasks: { cancel: id => invoke('tasks.cancel', { id }) },
    ai: {
      models: options => invoke('ai.models', options),
      batch: Object.fromEntries(['create', 'get', 'list', 'revise', 'start', 'cancel', 'preview'].map(method => [method, args => invoke('ai.batch.' + method, args)])),
      assistant: Object.fromEntries(['send', 'status', 'cancel'].map(method => [method, args => invoke('ai.assistant.' + method, args)])),
      onEvent: callback => bridge.onAI?.(callback) || (() => {}),
    },
    registerTool: value => invoke('contributions.tool', value),
    registerSettings: value => invoke('contributions.settings', value),
    onDispose: callback => bridge.onDispose(callback),
  });
}
