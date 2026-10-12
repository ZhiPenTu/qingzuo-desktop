import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function caseInsensitiveDirectory(directory) {
  if (process.platform === 'win32') return true;
  for (const name of await readdir(directory)) {
    if (!/[a-zA-Z]/.test(name)) continue;
    const variant = name.replace(/[a-zA-Z]/, letter => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
    const original = await lstat(path.join(directory, name));
    try {
      const alternate = await lstat(path.join(directory, variant));
      return original.dev === alternate.dev && original.ino === alternate.ino;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  // Empty directories cannot expose their case behavior without creating a
  // probe. Conservatively reject case-only output aliases on macOS.
  return process.platform === 'darwin';
}

// Used by every upgrade report writer before it touches protected inputs.
// realpath resolves existing file aliases and symlinked parent directories;
// missing output suffixes inherit the containing directory's case behavior.
export async function canonicalOutputPath(filename) {
  const absolute = filename instanceof URL ? fileURLToPath(filename) : path.resolve(filename);
  let cursor = absolute; const missing = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      const foldCase = missing.length && await caseInsensitiveDirectory(existing);
      const result = path.join(existing, ...missing.map(part => foldCase ? part.toLowerCase() : part));
      return process.platform === 'win32' ? result.toLowerCase() : result;
    } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(cursor) === cursor) throw error;
      missing.unshift(path.basename(cursor)); cursor = path.dirname(cursor);
    }
  }
}

export async function assertDistinctOutputPaths(filenames, message = 'Output, candidate and report must use separate files.') {
  const resolved = await Promise.all(filenames.map(canonicalOutputPath));
  if (new Set(resolved).size !== resolved.length) throw new Error(message);
  return resolved;
}