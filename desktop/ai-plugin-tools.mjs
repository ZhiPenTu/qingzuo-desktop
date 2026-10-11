import { randomUUID } from 'node:crypto';
import { validateToolArgs } from '../packages/plugin-sdk/tool-schema-core.mjs';

export const HOST_CHAT_PREFIX = '@qingzuo:';
export function isHostChat(owner) { return typeof owner === 'string' && /^@qingzuo:[a-f0-9-]{36}$/.test(owner); }
const empty = { type: 'object', properties: {}, additionalProperties: false };
const batchId = { type: 'string', maxLength: 36 };
const batchSchema = { type: 'object', properties: { id: batchId }, required: ['id'], additionalProperties: false };
const imageTools = [
  { name: 'list_batches', title: '查询图片批次', parameters: empty },
  { name: 'get_batch', title: '查看批次方案与进度', parameters: batchSchema },
  { name: 'prepare_plan', title: '修改逐图提示词（不生成图片）', parameters: { type: 'object', properties: { id: batchId, revision: { type: 'integer', minimum: 1 }, prompts: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 32000 } } }, required: ['id', 'revision', 'prompts'], additionalProperties: false } },
  { name: 'start_batch', title: '执行图片批次（可能产生费用）', parameters: { type: 'object', properties: { id: batchId, revision: { type: 'integer', minimum: 1 } }, required: ['id', 'revision'], additionalProperties: false } },
  { name: 'cancel_batch', title: '停止图片批次', parameters: batchSchema },
];

export function pluginToolCatalog(plugins) {
  return plugins.filter(plugin => plugin.enabled && !plugin.missing?.length).map(plugin => ({
    id: plugin.id, title: plugin.title, description: plugin.description,
    tools: [
      { name: 'open', title: '打开插件', parameters: empty },
      ...(plugin.settings ? [{ name: 'settings', title: '打开插件设置', parameters: empty }] : []),
      ...(plugin.id === 'official.ai-image' && plugin.permissions?.ai?.includes('image-edit') ? imageTools : []),
      ...(plugin.assistant?.tools || []).map(({ name, title, description, parameters }) => ({ name, title, description, parameters })),
    ],
  }));
}
export class PluginApprovals {
  constructor({ plugins, execute, changed, describe = async () => null }) { Object.assign(this, { plugins, execute, changed, describe }); this.pending = new Map(); this.active = new Map(); this.epochs = new Map(); }
  list(owner) { return [...this.pending.values()].filter(entry => entry.record.owner === owner).map(entry => structuredClone(entry.record)); }
  async request(owner, { pluginId, tool, args = {} }) {
    if (!isHostChat(owner)) throw new Error('插件编排会话未授权。');
    const epoch = this.epochs.get(owner) || 0;
    const plugin = (await this.plugins()).find(value => value.id === pluginId);
    const capability = pluginToolCatalog(plugin ? [plugin] : [])[0]?.tools.find(value => value.name === tool);
    if (!capability) throw new Error('插件已停用或未声明此助手工具。');
    validateToolArgs(capability.parameters, args);
    if (JSON.stringify(args).length > 1000000 || this.pending.size >= 32) throw new Error('插件调用过大或等待确认过多。');
    const frozen = structuredClone(args);
    const detail = await this.describe(plugin, tool, frozen);
    if ((this.epochs.get(owner) || 0) !== epoch) throw new Error('对话已停止。');
    const record = { id: randomUUID(), owner, pluginId, pluginTitle: plugin.title, version: plugin.version, tool, title: capability.title, args: frozen, detail, state: 'pending', created: Date.now() };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.reject(record.id, '确认超时，未执行插件。'), 10 * 60 * 1000); timer.unref?.();
      this.pending.set(record.id, { record, capability: JSON.stringify(capability), resolve, reject, timer }); this.changed(owner);
    });
  }
  reject(id, message) { const entry = this.pending.get(id); if (!entry) return; clearTimeout(entry.timer); this.pending.delete(id); entry.reject(new Error(message)); this.changed(entry.record.owner); }
  respond(owner, id, approve) {
    const entry = this.pending.get(id);
    if (!entry || entry.record.owner !== owner || typeof approve !== 'boolean') throw new Error('确认请求已失效或未授权。');
    if (!approve) { this.reject(id, '用户拒绝调用插件，未执行。'); return; }
    clearTimeout(entry.timer); this.pending.delete(id); this.changed(owner);
    const controller = new AbortController(); this.active.set(id, { owner, pluginId: entry.record.pluginId, controller });
    void (async () => {
      const current = (await this.plugins()).find(plugin => plugin.id === entry.record.pluginId);
      const capability = pluginToolCatalog(current ? [current] : [])[0]?.tools.find(tool => tool.name === entry.record.tool);
      if (!capability || current.version !== entry.record.version || JSON.stringify(capability) !== entry.capability) throw new Error('插件版本或能力已改变，请重新确认。');
      controller.signal.throwIfAborted();
      return this.execute(current, entry.record.tool, structuredClone(entry.record.args), owner, controller.signal);
    })().then(entry.resolve, entry.reject).finally(() => this.active.delete(id));
  }
  cancelOwner(owner) { this.epochs.set(owner, (this.epochs.get(owner) || 0) + 1); for (const [id, entry] of this.pending) if (entry.record.owner === owner) this.reject(id, '对话已停止，未执行插件。'); for (const entry of this.active.values()) if (entry.owner === owner) entry.controller.abort(); }
  cancelPlugin(pluginId) { for (const [id, entry] of this.pending) if (entry.record.pluginId === pluginId) this.reject(id, '插件已停用，未执行。'); for (const entry of this.active.values()) if (entry.pluginId === pluginId) entry.controller.abort(); }
  dispose() { for (const id of this.pending.keys()) this.reject(id, '应用已关闭，未执行插件。'); for (const entry of this.active.values()) entry.controller.abort(); }
}
