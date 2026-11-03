import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';

const root = process.cwd();
const defaultConfigFile = path.join(root, 'resources/generated/market.json');

export async function prepareMarketFixture(definitions, { configFile = defaultConfigFile } = {}) {
  const previous = await readFile(configFile);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const artifacts = {};
  const plugins = definitions.map(definition => {
    const version = definition.version ?? '0.1.0';
    const api = definition.api ?? '^1.10.0';
    const tier = definition.tier ?? 'official';
    const zip = new AdmZip();
    zip.addFile('package.json', Buffer.from(JSON.stringify({
      name: definition.id,
      version,
      commerce: {
        manifestVersion: 1,
        id: definition.id,
        title: definition.title,
        description: definition.description,
        api,
        permissions: {},
        ...definition.manifest,
      },
    })));
    for (const [filename, contents] of Object.entries(definition.files ?? {})) {
      zip.addFile(filename, Buffer.from(contents));
    }
    const bytes = definition.bytes ?? zip.toBuffer();
    const url = definition.url ?? `https://market.example/${definition.id}.ecplugin`;
    artifacts[url] = bytes.toString('base64');
    return {
      id: definition.id,
      title: definition.title,
      description: definition.description,
      ...(definition.category ? { category: definition.category } : {}),
      version,
      api,
      tier,
      official: tier !== 'community',
      ...(definition.stats ? { stats: definition.stats } : {}),
      artifacts: {
        [process.platform + '-' + process.arch]: {
          url,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          signature: sign(null, bytes, privateKey).toString('base64'),
        },
      },
    };
  });
  await writeFile(configFile, JSON.stringify({
    url: 'https://market.example/catalog.json',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  }));
  return {
    catalog: { schemaVersion: 1, plugins },
    artifacts,
    async restore() {
      await writeFile(configFile, previous);
    },
  };
}

export async function installMarketFixture(application, page, fixture, ids) {
  await application.evaluate((_, value) => {
    globalThis.__marketFixtureNativeFetch ??= globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (address, options) => {
      const url = String(address);
      if (url.endsWith('/catalog.json')) return new Response(JSON.stringify(value.catalog));
      const bytes = value.artifacts[url];
      if (bytes) return new Response(Buffer.from(bytes, 'base64'));
      return globalThis.__marketFixtureNativeFetch(address, options);
    };
  }, { catalog: fixture.catalog, artifacts: fixture.artifacts });
  return page.evaluate(pluginIds => (
    Promise.all(pluginIds.map(id => window.commerceDesktop.invoke('market.install', { id })))
  ), ids);
}
