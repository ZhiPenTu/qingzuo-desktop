import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { boot, createRuntimeResolution, installFailLoud, PluginPackages, readProfilePatches } from '@deepseek-ai/dsh-app-boot';

const ROOT_CONFIG = '# qingzuo kernel root — an empty entry list.\n[]\n';
const SHUTDOWN_TIMEOUT_MS = 5000;

function shutdownController(dispose, exit = code => process.exit(code), timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  let pending;
  let forced = false;
  const shutdown = code => {
    if (pending) return pending;
    const timer = setTimeout(() => { forced = true; exit(code); }, timeoutMs);
    pending = Promise.resolve().then(dispose).catch(() => {}).then(() => {
      if (!forced) { clearTimeout(timer); exit(code); }
    });
    return pending;
  };
  const interrupt = code => {
    if (pending) { forced = true; exit(code); return; }
    return shutdown(code);
  };
  return { shutdown, interrupt };
}

// Boot the commerce profile with the same public app-boot contract the upstream
// launcher uses, without depending on the full dsh CLI meta package.
export async function bootCommerceProfile({ name, home, profile, installAnchor }) {
  const rootConfig = path.join(profile.dir, 'cordis.yml');
  await writeFile(rootConfig, ROOT_CONFIG);
  const context = {
    name,
    dir: profile.dir,
    patchPath: profile.patchPath,
    installAnchor,
    startedBundles: profile.layers.map(layer => layer.packageName),
    cwd: process.cwd(),
    home,
    overlays: [],
    telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
  };
  const resolution = await createRuntimeResolution({ installAnchor, profile, home });
  let current;
  let closing;
  let settled;
  const booted = new Promise(resolve => { settled = resolve; });
  // Teardown waits for boot to settle so a signal that arrives mid-boot does
  // not race the loader: the partial tree handed to the prepare callback is
  // already disposable, and the root context replaces it once boot returns.
  const dispose = () => closing ??= booted.then(() => current ? current.fiber.dispose() : undefined);
  const shutdown = shutdownController(dispose);
  const onTerminate = () => void shutdown.shutdown(0);
  const onInterrupt = () => void shutdown.interrupt(130);
  process.on('SIGTERM', onTerminate);
  process.on('SIGINT', onInterrupt);
  const uninstallFailLoud = installFailLoud(name, process, async () => { await dispose().catch(() => {}); });
  try {
    const ctx = await boot(name, rootConfig, readProfilePatches(name, context, profile), async hostCtx => {
      current = hostCtx;
      hostCtx.provide('profileContext', context);
      await hostCtx.plugin(PluginPackages, { resolution });
    });
    current = ctx;
    settled();
    return { ctx, shutdown };
  } catch (error) {
    settled();
    process.off('SIGTERM', onTerminate);
    process.off('SIGINT', onInterrupt);
    uninstallFailLoud();
    await dispose().catch(() => {});
    throw error;
  }
}
