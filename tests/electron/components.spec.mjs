import { test, expect, _electron } from '@playwright/test';
import { createPackage } from '@electron/asar';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('component updater sees ASAR as raw bytes rather than an Electron virtual directory', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qingzuo-asar-contract-'));
  let app;
  try {
    const source = path.join(temporary, 'source'), bundle = path.join(temporary, 'Fixture.app'), filename = path.join(bundle, 'Contents/Resources/app.asar');
    await mkdir(source); await writeFile(path.join(source, 'fixture.txt'), 'archive payload');
    await mkdir(path.dirname(filename), { recursive: true }); await createPackage(source, filename);
    const bytes = await readFile(filename), artifact = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    app = await _electron.launch({ args: [process.cwd(), '--user-data-dir=' + path.join(temporary, 'profile')] });
    await expect((await app.firstWindow()).getByText('工具服务已就绪')).toBeVisible();
    const result = await app.evaluate(async (_, value) => {
      const vm = process.getBuiltinModule('node:vm');
      const importer = url => vm.runInThisContext('import(' + JSON.stringify(url) + ')', { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
      const download = await importer(value.downloadURL), components = await importer(value.componentsURL), raw = await importer(value.rawURL);
      const matches = await download.matchesArtifact(value.filename, value.artifact);
      const files = await components.inventoryBundle(value.bundle);
      await raw.rm(value.bundle, { recursive: true, force: true });
      return { matches, archive: files.find(file => file.path === 'Contents/Resources/app.asar') };
    }, { filename, bundle, artifact, downloadURL: new URL('../../desktop/update-download.mjs', import.meta.url).href, componentsURL: new URL('../../desktop/update-components.mjs', import.meta.url).href, rawURL: new URL('../../desktop/update-fs.mjs', import.meta.url).href });
    expect(result.matches).toBe(true);
    expect(result.archive).toMatchObject({ type: 'file', ...artifact });
  } finally { await app?.close(); await rm(temporary, { recursive: true, force: true }); }
});
