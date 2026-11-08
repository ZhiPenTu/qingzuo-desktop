export const FIRST_PARTY_ASSISTANT = 'official.ai-assistant';
export const FIRST_PARTY_DIAGNOSTICS = 'official.diagnostics';

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
    'firstParty.assistant.settings': ASSISTANT_SETTINGS,
  }),
  [FIRST_PARTY_DIAGNOSTICS]: Object.freeze({
    'firstParty.diagnostics': DIAGNOSTICS,
  }),
});

export function firstPartyCapability(method) {
  if (typeof method !== 'string') return null;
  for (const namespace of ['firstParty.assistant.settings', 'firstParty.diagnostics']) {
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
