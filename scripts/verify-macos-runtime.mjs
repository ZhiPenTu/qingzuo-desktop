import { open, readdir, lstat, mkdtemp, symlink, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

// A bundle Info.plist cannot lower a dylib's actual deployment requirement.
// Check every shipped Mach-O instead of trusting wheel tags or app metadata.
export async function verifyMacRuntime(root, maximum = '15.0') {
  let checked = 0;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'commerce-runtime-'));
  const alias = path.join(temporary, 'runtime');
  async function walk(folder) {
    for (const name of await readdir(folder)) {
      const file = path.join(folder, name), info = await lstat(file);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) { await walk(file); continue; }
      if (!info.isFile() || info.size < 4) continue;
      const handle = await open(file, 'r'), magic = Buffer.alloc(4);
      try { await handle.read(magic, 0, 4, 0); } finally { await handle.close(); }
      if (!['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf'].includes(magic.toString('hex'))) continue;
      // otool interprets parenthesized filenames as archive(member), including
      // Electron's "Helper (GPU)". A neutral alias avoids that parser ambiguity.
      await symlink(file, alias);
      let loads;
      try { loads = execFileSync('otool', ['-l', alias], { encoding: 'utf8' }); }
      finally { await rm(alias); }
      // Only deployment commands count; dylib ABI versions are unrelated.
      const deployment = [...loads.matchAll(/cmd LC_(?:BUILD_VERSION|VERSION_MIN_MACOSX)[\s\S]*?(?:minos|version) (\d+(?:\.\d+){1,2})/g)].map(value => value[1]);
      if (!deployment.length) throw new Error('Missing macOS deployment metadata: ' + file);
      const newer = version => {
        const actual = version.split('.').map(Number), allowed = maximum.split('.').map(Number);
        for (let i = 0; i < 3; i++) { const difference = (actual[i] || 0) - (allowed[i] || 0); if (difference) return difference > 0; }
        return false;
      };
      if (deployment.some(newer)) throw new Error('Requires macOS ' + deployment.join(', ') + ': ' + file);
      checked++;
    }
  }
  try { await walk(path.resolve(root)); }
  finally { await rm(temporary, { recursive: true, force: true }); }
  if (!checked) throw new Error('No Mach-O runtime found: ' + root);
  console.log('Verified ' + checked + ' Mach-O runtimes support macOS ' + maximum + '.');
}
if (process.platform === 'darwin' && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyMacRuntime(process.argv[2] || 'resources/generated');
