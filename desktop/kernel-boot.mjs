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
  const dispose = () => {
    if (!current) return Promise.resolve();
    return closing ??= Promise.resolve().then(() => current.fiber.dispose());
  };
  installFailLoud(name, process, async () => dispose());
  const ctx = await boot(name, rootConfig, readProfilePatches(name, context, profile), async hostCtx => {
    hostCtx.provide('profileContext', context);
    await hostCtx.plugin(PluginPackages, { resolution });
  });
  current = ctx;
  const shutdown = shutdownController(dispose);
  process.on('SIGTERM', () => void shutdown.shutdown(0));
  process.on('SIGINT', () => void shutdown.interrupt(130));
  return ctx;
}
