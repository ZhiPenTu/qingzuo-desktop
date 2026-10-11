import { cp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { desktopSigningMode } from '../desktop/distribution.mjs';
const root = process.cwd(), generated = path.join(root, 'resources/generated');
await rm(generated, { recursive: true, force: true });
await mkdir(generated, { recursive: true });
const binary = 'commerce-sandbox' + (process.platform === 'win32' ? '.exe' : '');
await cp(path.join(root, 'native/sandbox/target/release', binary), path.join(generated, binary));
await (await import('./prepare-ai-proxy.mjs')).prepareAiProxy(generated);
await writeFile(path.join(generated, 'market.json'), JSON.stringify({
  url: process.env.COMMERCE_MARKET_URL || 'https://raw.githubusercontent.com/ZhiPenTu/qingzuo-market/main/catalog.json',
  publicKey: process.env.COMMERCE_MARKET_PUBLIC_KEY || process.env.COMMERCE_PLUGIN_PUBLIC_KEY || '',
  updatePublicKey: process.env.COMMERCE_PLUGIN_PUBLIC_KEY || '',
}));
await writeFile(path.join(generated, 'distribution.json'), JSON.stringify({ signing: desktopSigningMode(), preview: process.env.QINGZUO_LOCAL_PREVIEW === '1' }));
await cp(path.join(root, 'node_modules/@deepseek-ai/dsh/LICENSE'), path.join(generated, 'DeepSeek-Harness-LICENSE')).catch(async () => {
  const response = await fetch('https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/5badb15009ae1756c3afe0ae0cef1faafc290ccc/LICENSE');
  if (!response.ok) throw new Error('无法取得上游许可证。');
  await writeFile(path.join(generated, 'DeepSeek-Harness-LICENSE'), await response.text());
});
await import('./generate-notices.mjs');
await cp(path.join(root, 'docs/third-party-notices.md'), path.join(generated, 'THIRD_PARTY_NOTICES.md'));
console.log('纯底座资源已生成，业务插件从独立市场按需安装。');
