import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_AUTO_UPDATE = true;

async function atomicJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export class UpdatePreferences {
  constructor({ root } = {}) {
    this.file = root ? path.join(root, 'update-settings.json') : null;
    this.state = { autoUpdate: DEFAULT_AUTO_UPDATE };
  }

  snapshot() {
    return { ...this.state };
  }

  async initialize() {
    if (!this.file) return this.snapshot();
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (typeof saved?.autoUpdate === 'boolean') this.state.autoUpdate = saved.autoUpdate;
    } catch (error) {
      if (error?.code !== 'ENOENT') await rm(this.file, { force: true }).catch(() => {});
    }
    return this.snapshot();
  }

  async configure(options = {}) {
    if (typeof options.autoUpdate !== 'boolean') throw new Error('自动更新设置无效。');
    this.state = { autoUpdate: options.autoUpdate };
    if (this.file) {
      await atomicJson(this.file, { schemaVersion: 1, ...this.state });
    }
    return this.snapshot();
  }
}
