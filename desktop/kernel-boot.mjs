import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { boot, createRuntimeResolution, PluginPackages, readProfilePatches } from '@deepseek-ai/dsh-app-boot';

const ROOT_CONFIG = '# qingzuo kernel root — an empty entry list.\n[]\n';

// Boot the commerce profile with the same public app-boot contract the upstream
// launcher uses, without depending on the full dsh CLI meta package.
export async function bootCommerceProfile({ name, home, profile, installAnchor, lifecycle }) {
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
  // The prepare callback hands over the partial tree, so a teardown requested
  // mid-boot has something to release; the root context replaces it below.
  const adopt = ctx => {
    current = ctx;
    lifecycle?.setTeardown(() => current.fiber.dispose());
  };
  const ctx = await boot(name, rootConfig, readProfilePatches(name, context, profile), async hostCtx => {
    adopt(hostCtx);
    hostCtx.provide('profileContext', context);
    await hostCtx.plugin(PluginPackages, { resolution });
  });
  adopt(ctx);
  return { ctx, dispose: () => ctx.fiber.dispose() };
}
