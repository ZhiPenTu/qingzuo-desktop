import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot';
import { bootCommerceProfile } from './kernel-boot.mjs';
export async function bootCommerceKernel({ home, installAnchor, invoke = async () => null }) {
  const dir = path.join(home, 'profiles', 'commerce-desktop'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'commerce-desktop-profile', private: true, dsh: { profile: { bundles: ['@commerce/platform-bundle'] } } }));
  await writeFile(path.join(dir, 'cordis.patch.yml'), '[]\n');
  const systems = new Map(), tools = new Map(), adapters = new Map();
  // The bridge is a trusted configuration row, not user-supplied code.
  const bridgeFile = path.join(dir, 'bridge.mjs');
  await writeFile(bridgeFile, "export function apply(ctx) { ctx.provide('commerceBridge', globalThis.__commerceBridge); }\n");
  globalThis.__commerceBridge = { invoke, registerSystem(service) { systems.set(service.id, service); return () => systems.delete(service.id); } };
  const patch = '- insert:\n    - id: commerce-bridge\n      name: ' + JSON.stringify(bridgeFile) + '\n';
  await writeFile(path.join(dir, 'cordis.patch.yml'), patch);
  const loaded = loadProfileDirectory('commerce-desktop', dir, installAnchor);
  let booted;
  try {
    booted = await bootCommerceProfile({ name: 'commerce-desktop', home, profile: loaded, installAnchor });
  } catch (error) {
    delete globalThis.__commerceBridge;
    throw error;
  }
  const ctx = booted.ctx;
  const runtime = { ctx };
  if (systems.size !== 7) {
    await runtime.ctx.fiber.dispose();
    delete globalThis.__commerceBridge;
    throw new Error('平台系统插件未能全部加载。');
  }
  async function reconcile(plugins) {
    // Descriptors only. Third-party JS never enters this process.
    for (const fiber of adapters.values()) await fiber.dispose();
    adapters.clear(); tools.clear();
    for (const plugin of plugins.filter(p => p.enabled && !p.missing?.length)) {
      const fiber = await runtime.ctx.plugin({ name: 'commerce-tool-' + plugin.id, inject: (plugin.services?.requires ?? []).map(service => 'commerce_tool:' + service), apply(child) {
        child.effect(() => {
          for (const service of plugin.services?.provides ?? []) {
            if (tools.has(service)) throw new Error('重复服务：' + service);
            const entry = { plugin: plugin.id, invoke: (method, args, caller) => systems.get('sandbox').invoke('call', { provider: plugin.id, service, method, args, caller }) };
            child.provide('commerce_tool:' + service, entry); tools.set(service,entry);
          }
          return () => { for (const service of plugin.services?.provides ?? []) tools.delete(service); };
        });
      }});
      adapters.set(plugin.id, fiber);
    }
    return [...tools.keys()];
  }
  async function call(kind, service, method, args = {}, caller) {
    if (kind === 'system') { const entry = systems.get(service); if (!entry) throw new Error('系统服务不可用。'); return entry.invoke(method, args); }
    if (kind !== 'tool') throw new Error('内核调用类型无效。');
    const entry = tools.get(service); const fiber = adapters.get(caller);
    if (!entry || !fiber) throw new Error('工具服务不可用。');
    return entry.invoke(method, args, caller);
  }
  return { ...runtime, systems, tools, reconcile, call, shutdown: booted.shutdown, dispose: async () => { await runtime.ctx.fiber.dispose(); delete globalThis.__commerceBridge; } };
}
