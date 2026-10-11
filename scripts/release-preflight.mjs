import {createPublicKey} from 'node:crypto';import {readFile} from 'node:fs/promises';
import {desktopSigningMode} from '../desktop/distribution.mjs';
const pkg=JSON.parse(await readFile('package.json'));
if(process.env.QINGZUO_LOCAL_PREVIEW==='1')throw new Error('本地预览配置不能用于发布构建。');
const version=pkg.version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
if(!version || Number(version[1])===0 && Number(version[2])<2)throw new Error('新底座构建版本必须为 0.2.0 或更高的正式版本号。');
let mode;
if(process.env.GITHUB_EVENT_NAME==='workflow_dispatch') {
  if(process.env.COMMERCE_VALIDATION_VERSION!==pkg.version)throw new Error('验收版本与底座版本不一致。');
  mode='validation';
} else if(process.env.GITHUB_EVENT_NAME==='push' && process.env.GITHUB_REF_TYPE==='tag') {
  if(process.env.GITHUB_REF_NAME!=='v'+pkg.version)throw new Error('发布标签与底座版本不一致。');
  mode='publish';
} else throw new Error('发布构建仅支持手动验收或匹配版本的标签发布。');
const signing=desktopSigningMode();
const required=['COMMERCE_PLUGIN_SIGNING_KEY','COMMERCE_PLUGIN_PUBLIC_KEY'];
if(signing==='signed')required.push(...(process.platform==='darwin'?['CSC_LINK','CSC_KEY_PASSWORD','APPLE_ID','APPLE_APP_SPECIFIC_PASSWORD','APPLE_TEAM_ID']:['CSC_LINK','CSC_KEY_PASSWORD']));
for(const name of required) if(!process.env[name]) throw new Error('正式发布缺少配置：'+name);
if(createPublicKey(process.env.COMMERCE_PLUGIN_SIGNING_KEY).asymmetricKeyType!=='ed25519')throw new Error('插件签名密钥必须为 Ed25519。');
if(createPublicKey(process.env.COMMERCE_PLUGIN_SIGNING_KEY).export({format:'pem',type:'spki'}).trim()!==process.env.COMMERCE_PLUGIN_PUBLIC_KEY.trim()) throw new Error('插件签名公私钥不匹配。');
console.log(mode==='validation'?'验收配置检查通过，仅上传验收制品，不公开发布。':'发布配置检查通过。');
console.log(signing==='signed'?'正式签名模式：证书有效性仍须由签名和系统验证确认。':'GitHub 未签名分发模式：应用内下载并安装更新，插件市场签名仍为必需。');
