export const FIRST_PARTY_ASSISTANT = 'official.ai-assistant';
export const FIRST_PARTY_DIAGNOSTICS = 'official.diagnostics';

const ASSISTANT_CHAT = new Set(['list', 'status', 'tools', 'create', 'send', 'cancel', 'delete']);
const ASSISTANT_SETTINGS = new Set([
  'status',
  'models',
  'testModel',
  'beginTextSetup',
  'beginImageKeySetup',
  'clearImageKey',
  'imageStatus',
  'imageModels',
]);
const DIAGNOSTICS = new Set(['status', 'recent']);

const RULES = Object.freeze({
  [FIRST_PARTY_ASSISTANT]: Object.freeze({
    'firstParty.assistant.chat': ASSISTANT_CHAT,
    'firstParty.assistant.settings': ASSISTANT_SETTINGS,
  }),
  [FIRST_PARTY_DIAGNOSTICS]: Object.freeze({
    'firstParty.diagnostics': DIAGNOSTICS,
  }),
});

export function firstPartyCapability(method) {
  if (typeof method !== 'string') return null;
  for (const namespace of ['firstParty.assistant.chat', 'firstParty.assistant.settings', 'firstParty.diagnostics']) {
    if (!method.startsWith(namespace + '.')) continue;
    return { namespace, operation: method.slice(namespace.length + 1) };
  }
  return null;
}

export function firstPartyRule(pluginId, method) {
  const capability = firstPartyCapability(method);
  if (!capability) return null;
  const namespaces = RULES[pluginId];
  if (!namespaces || !namespaces[capability.namespace]?.has(capability.operation)) return null;
  return capability;
}

export function isFirstPartyBridgePlugin(plugin) {
  return Boolean(
    plugin
    && plugin.enabled
    && !tupleHasMissingDependencies(plugin)
    && plugin.source === 'market'
    && plugin.tier === 'platform'
    && Object.hasOwn(RULES, plugin.id),
  );
}

export function assertFirstPartyAccess(plugin, method) {
  if (!plugin) throw new Error('插件不可用。');
  if (plugin.source !== 'market' || plugin.tier !== 'platform') throw new Error('第一方能力未授权。');
  if (!plugin.enabled || tupleHasMissingDependencies(plugin)) throw new Error('插件不可用。');
  const rule = firstPartyRule(plugin.id, method);
  if (!rule) throw new Error('第一方能力未授权。');
  return rule;
}

function tupleHasMissingDependencies(plugin) {
  return Array.isArray(plugin.missing) && plugin.missing.length > 0;
}

function cleanText(value, limit = 64000) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : undefined;
}

function safeToolRecord(message) {
  return {
    role: 'tool',
    ...(typeof message.id === 'string' ? { id: message.id.slice(0, 80) } : {}),
    ...(typeof message.tool === 'string' ? { tool: message.tool.slice(0, 80) } : {}),
    ...(typeof message.pluginId === 'string' ? { pluginId: message.pluginId.slice(0, 96) } : {}),
    ...(typeof message.state === 'string' ? { state: message.state.slice(0, 32) } : {}),
    ...(safeNumber(message.created) !== undefined ? { created: safeNumber(message.created) } : {}),
  };
}

export function sanitizeAssistantHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-100).flatMap(message => {
    if (!message || typeof message !== 'object') return [];
    if (message.role === 'tool') return [safeToolRecord(message)];
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    return [{ role: message.role, text: cleanText(message.text) }];
  });
}

export function sanitizeAssistantSession(session) {
  if (!session || typeof session !== 'object') return { state: 'idle', history: [] };
  const waitingForApproval = Boolean(session.waitingForApproval || (Array.isArray(session.approvals) && session.approvals.length));
  return {
    ...(typeof session.id === 'string' ? { id: session.id.slice(0, 64) } : {}),
    ...(typeof session.title === 'string' ? { title: cleanText(session.title, 160) } : {}),
    ...(typeof session.model === 'string' ? { model: cleanText(session.model, 160) } : {}),
    state: session.state === 'running' ? 'running' : 'idle',
    ...(typeof session.partial === 'string' ? { partial: cleanText(session.partial) } : {}),
    ...(typeof session.error === 'string' ? { error: cleanText(session.error, 2000) } : {}),
    ...(waitingForApproval ? { waitingForApproval: true } : {}),
    history: sanitizeAssistantHistory(session.history),
  };
}

export function sanitizeAssistantSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  if (typeof summary.id !== 'string') return null;
  return {
    id: summary.id.slice(0, 64),
    title: cleanText(summary.title || '新对话', 160),
    state: summary.state === 'running' ? 'running' : 'idle',
    updated: safeNumber(summary.updated) ?? 0,
  };
}

export function sanitizeAssistantTools(plugins) {
  if (!Array.isArray(plugins)) return [];
  return plugins.flatMap(plugin => {
    if (!plugin || typeof plugin.id !== 'string' || typeof plugin.title !== 'string' || !Array.isArray(plugin.tools)) return [];
    return [{
      id: plugin.id.slice(0, 96),
      title: cleanText(plugin.title, 80),
      description: cleanText(plugin.description, 2000),
      tools: plugin.tools.flatMap(tool => tool && typeof tool.name === 'string' && typeof tool.title === 'string'
        ? [{ name: tool.name.slice(0, 80), title: cleanText(tool.title, 80) }]
        : []),
    }];
  });
}

export function sanitizeAssistantEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'assistant-delta') {
    return {
      type: 'assistant-delta',
      ...(typeof event.chatId === 'string' ? { chatId: event.chatId.slice(0, 64) } : {}),
      text: cleanText(event.text),
      ...(typeof event.partial === 'string' ? { partial: cleanText(event.partial) } : {}),
    };
  }
  if (event.type === 'assistant') {
    return {
      type: 'assistant',
      ...(typeof event.chatId === 'string' ? { chatId: event.chatId.slice(0, 64) } : {}),
      session: sanitizeAssistantSession(event.session),
    };
  }
  return null;
}
