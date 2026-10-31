import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, access, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { HARNESS_UPSTREAM } from '../desktop/harness-version.mjs';
const pin = HARNESS_UPSTREAM.nativeAdapter;

// The official optional binary was built for macOS 15. Compile the unchanged
// official 0.1.9 native source for our macOS 14 target during the app build.
// This is a build-time adaptation, never a plugin install-time fallback.
if (process.platform !== 'darwin') process.exit(0);
if (process.arch !== 'arm64') throw new Error('Only macOS Apple Silicon is supported.');
const require = createRequire(import.meta.url);
const entry = JSON.parse(await readFile(require.resolve('node-addon-require-builtin/package.json')));
if (entry.version !== pin.version) throw new Error('Harness native adapter needs review for version ' + entry.version);
const commit = pin.commit;
const digest = pin.sha256;
const cache = path.resolve('.cache/harness-native', commit), archive = path.join(cache, 'source.tgz');
await mkdir(cache, { recursive: true });
let bytes;
try { bytes = await readFile(archive); } catch {
  const response = await fetch('https://codeload.github.com/deepseek-ai/dsh-node-addon-require-builtin/tar.gz/' + commit, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('Cannot obtain pinned Harness native source.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 8 * 1024 ** 2) throw new Error('Native source archive is too large.'); chunks.push(chunk); }
  bytes = Buffer.concat(chunks);
}
if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Harness native source hash mismatch.');
await writeFile(archive, bytes);
const source = path.join(cache, 'source'); await mkdir(source, { recursive: true });
execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', source]);
const native = path.join(source, 'packages/native');
const binding = JSON.parse(await readFile(path.join(native, 'binding.gyp'))).targets[0];
const napiSources = binding.conditions?.find(([condition]) => condition === "narb_backend=='nodeabi'")?.[2]?.sources;
if (!Array.isArray(napiSources) || napiSources.length === 0) throw new Error('Harness native adapter N-API sources were not found.');
const files = [...new Set([...binding.sources, ...napiSources])].map(file => path.join(native, file));
const include = path.resolve(path.dirname(process.execPath), '../include/node');
await access(path.join(include, 'node.h'));
const api = path.dirname(require.resolve('node-addon-api/package.json'));
const optional = path.dirname(require.resolve('node-addon-require-builtin-darwin-arm64/package.json'));
const output = path.join(optional, 'prebuilt/darwin-arm64-napi-v9.node');
const compiler = execFileSync('xcrun', ['--sdk', 'macosx', '--find', 'clang++'], { encoding: 'utf8' }).trim();
const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
execFileSync(compiler, ['-isysroot', sdk, '-bundle', '-undefined', 'dynamic_lookup', '-std=c++17', '-O2',
  '-mmacosx-version-min=' + pin.minimumOS, '-fno-exceptions', '-fvisibility=hidden',
  '-DNAPI_VERSION=' + pin.napi, '-DNARB_BACKEND=1', '-DNARB_PRODUCT=1',
  '-DNODE_ADDON_API_DISABLE_CPP_EXCEPTIONS', '-DNODE_GYP_MODULE_NAME=require_builtin',
  '-I', include, '-I', api, ...files, '-o', output], { stdio: 'inherit' });
const generated = path.resolve('resources/generated'); await mkdir(generated, { recursive: true });
await cp(path.join(source, 'LICENSE'), path.join(generated, 'Harness-native-adapter-LICENSE'));
console.log('Built official Harness native adapter ' + pin.version + ' for macOS ' + pin.minimumOS + '.');
