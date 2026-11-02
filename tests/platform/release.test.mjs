import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {load} from 'js-yaml';
import {desktopSigningMode,packagingOptions,packagingEnvironment} from '../../desktop/distribution.mjs';
const script=path.resolve('scripts/release-preflight.mjs');
const keys=generateKeyPairSync('ed25519');
const alternate=generateKeyPairSync('ed25519');
const fixture={
 COMMERCE_DESKTOP_SIGNING:'signed',
 CSC_LINK:'fixture-certificate-reference',CSC_KEY_PASSWORD:'fixture-password',
 APPLE_ID:'fixture@example.test',APPLE_APP_SPECIFIC_PASSWORD:'fixture-password',APPLE_TEAM_ID:'fixture-team',
 COMMERCE_PLUGIN_SIGNING_KEY:keys.privateKey.export({format:'pem',type:'pkcs8'}),
 COMMERCE_PLUGIN_PUBLIC_KEY:keys.publicKey.export({format:'pem',type:'spki'}),
};
function run(cwd,overrides){
 const env=Object.fromEntries(Object.entries({...fixture,...overrides}).filter(([,value])=>value!==undefined));
 if(process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;
 return spawnSync(process.execPath,[script],{cwd,env,encoding:'utf8',timeout:10000});
}
async function directory(){const cwd=await mkdtemp(path.join(os.tmpdir(),'commerce-release-'));await writeFile(path.join(cwd,'package.json'),JSON.stringify({version:'0.2.0'}));return cwd;}
const publish={GITHUB_EVENT_NAME:'push',GITHUB_REF_TYPE:'tag',GITHUB_REF_NAME:'v0.2.0'};
const validation={GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF_TYPE:'branch',GITHUB_REF_NAME:'main',COMMERCE_VALIDATION_VERSION:'0.2.0'};

test('release preflight accepts signed validation and tag builds, and unsigned builds without certificates',async()=>{
 const cwd=await directory();
 try{
  const manual=run(cwd,validation);assert.equal(manual.status,0,manual.stderr);assert.match(manual.stdout,/仅上传验收制品，不公开发布/);
  const release=run(cwd,publish);assert.equal(release.status,0,release.stderr);assert.match(release.stdout,/发布配置检查通过/);
  const certificates={CSC_LINK:undefined,CSC_KEY_PASSWORD:undefined,APPLE_ID:undefined,APPLE_APP_SPECIFIC_PASSWORD:undefined,APPLE_TEAM_ID:undefined};
  for(const event of [validation,publish]){
   const unsigned=run(cwd,{...event,...certificates,COMMERCE_DESKTOP_SIGNING:undefined});assert.equal(unsigned.status,0,unsigned.stderr);assert.match(unsigned.stdout,/GitHub 未签名分发模式/);
   const noPluginKey=run(cwd,{...event,...certificates,COMMERCE_DESKTOP_SIGNING:'unsigned',COMMERCE_PLUGIN_SIGNING_KEY:undefined});assert.notEqual(noPluginKey.status,0);assert.match(noPluginKey.stderr,/缺少配置：COMMERCE_PLUGIN_SIGNING_KEY/);
  }
 }finally{await rm(cwd,{recursive:true,force:true});}
});

test('signing preflight refuses missing credentials, wrong keys, unversioned events and incompatible versions',async()=>{
 const cwd=await directory();
 try{
  const cases=[
   ['missing certificate',{...validation,CSC_LINK:undefined},/缺少配置：CSC_LINK/],
   ['missing plugin key',{...validation,COMMERCE_PLUGIN_SIGNING_KEY:undefined},/缺少配置：COMMERCE_PLUGIN_SIGNING_KEY/],
   ['mismatched plugin key',{...validation,COMMERCE_PLUGIN_PUBLIC_KEY:alternate.publicKey.export({format:'pem',type:'spki'})},/公私钥不匹配/],
   ['wrong tag',{...publish,GITHUB_REF_NAME:'v0.3.0'},/发布标签与底座版本不一致/],
   ['branch push',{...publish,GITHUB_REF_TYPE:'branch',GITHUB_REF_NAME:'main'},/仅支持手动验收/],
   ['manual wrong version',{...validation,COMMERCE_VALIDATION_VERSION:'0.3.0'},/验收版本与底座版本不一致/],
   ['manual missing version',{...validation,COMMERCE_VALIDATION_VERSION:undefined},/验收版本与底座版本不一致/],
   ['unknown signing mode',{...validation,COMMERCE_DESKTOP_SIGNING:'optional'},/桌面签名模式必须/],
   ['unsigned wrong plugin key',{...validation,COMMERCE_DESKTOP_SIGNING:'unsigned',COMMERCE_PLUGIN_PUBLIC_KEY:alternate.publicKey.export({format:'pem',type:'spki'})},/公私钥不匹配/],
   ['unknown event',{...validation,GITHUB_EVENT_NAME:'pull_request'},/仅支持手动验收/],
  ];
  if(process.platform==='darwin')cases.push(['missing Apple account',{...validation,APPLE_ID:undefined},/缺少配置：APPLE_ID/]);
  for(const [name,env,error] of cases){const result=run(cwd,env);assert.notEqual(result.status,0,name);assert.match(result.stderr,error,name);}
  for(const version of ['0.1.9','0.2.0-rc.1','malformed']){
   await writeFile(path.join(cwd,'package.json'),JSON.stringify({version}));const result=run(cwd,{...validation,COMMERCE_VALIDATION_VERSION:version});assert.notEqual(result.status,0,version);assert.match(result.stderr,/0.2.0 或更高的正式版本号/);
  }
 }finally{await rm(cwd,{recursive:true,force:true});}
});

test('manual build workflow defaults to unsigned, preserves plugin signing and cannot publish',async()=>{
 const workflow=load(await readFile('.github/workflows/release-commerce.yml','utf8'));
 assert.equal(workflow.on.workflow_dispatch.inputs.version.required,true);
 assert.equal(workflow.on.workflow_dispatch.inputs.signing.default,'unsigned');
 assert.equal(workflow.jobs.package.env.COMMERCE_VALIDATION_VERSION,'${{ inputs.version }}');
 assert.match(workflow.jobs.package.env.COMMERCE_DESKTOP_SIGNING,/\|\| 'unsigned'/);
 assert.equal(workflow.jobs.package.env.COMMERCE_PLUGIN_SIGNING_KEY,'${{ secrets.COMMERCE_PLUGIN_SIGNING_KEY }}');
 assert.deepEqual(workflow.permissions,{contents:'read'});
 assert.equal(workflow.jobs.publish.if,"${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') }}");
 assert.equal(workflow.jobs.publish.needs,'package');
 assert.deepEqual(workflow.jobs.publish.permissions,{contents:'write'});
 for(const name of ['release-commerce.yml','release-sdk.yml','upstream.yml','validate.yml','branch-policy.yml']){
  const spec=load(await readFile(path.join('.github/workflows',name),'utf8'));
  for(const job of Object.values(spec.jobs)){
   for(const step of job.steps){
    if(!step.uses)continue;
    assert.doesNotMatch(step.uses,/^actions\/(checkout|setup-node|upload-artifact|download-artifact)@v[1-5]$/,name);
    if(step.uses.startsWith('actions/upload-artifact@'))assert.equal(step.uses,'actions/upload-artifact@v7',name);
    if(step.uses.startsWith('actions/download-artifact@'))assert.equal(step.uses,'actions/download-artifact@v8',name);
    if(step.uses.startsWith('actions/checkout@'))assert.equal(step.uses,'actions/checkout@v7',name);
    if(step.uses.startsWith('actions/setup-node@')){
     assert.equal(step.uses,'actions/setup-node@v7',name);
     assert.equal(step.with?.['node-version'],24,name);
    }
   }
  }
 }
});

test('local Node runtimes resolve to the pinned Node 24 toolchain',async()=>{
 const packageJSON=JSON.parse(await readFile('package.json','utf8'));
 const lockfile=JSON.parse(await readFile('package-lock.json','utf8'));
 assert.equal((await readFile('.node-version','utf8')).trim(),'24');
 assert.equal(packageJSON.engines?.node,'24.x');
 assert.equal(lockfile.packages?.['']?.engines?.node,'24.x');
});

test('unsigned packaging discards ambient certificates and signed packaging restores native verification',async()=>{
 const source={CSC_LINK:'existing-certificate',CSC_KEY_PASSWORD:'password',APPLE_ID:'account',CSC_WIN_LINK:'windows-certificate',CSC_IDENTITY_AUTO_DISCOVERY:'false',COMMERCE_PLUGIN_SIGNING_KEY:'plugin-key'};
 assert.equal(desktopSigningMode({}),'unsigned');
 const unsigned=packagingEnvironment('unsigned',source);
 for(const name of ['CSC_LINK','CSC_KEY_PASSWORD','CSC_WIN_LINK','APPLE_ID'])assert.equal(unsigned[name],undefined);
 assert.equal(unsigned.COMMERCE_PLUGIN_SIGNING_KEY,'plugin-key');
 assert.equal(unsigned.CSC_IDENTITY_AUTO_DISCOVERY,'false');
 assert.equal(unsigned.CSC_FOR_PULL_REQUEST,'true');
 assert.equal(packagingEnvironment('signed',source).CSC_LINK,source.CSC_LINK);
 assert.equal(source.CSC_LINK,'existing-certificate');
 assert.ok(packagingOptions('unsigned','darwin').includes('electron-builder.yml'));
 assert.ok(packagingOptions('signed','win32').includes('electron-builder.signed.yml'));
 assert.throws(()=>packagingOptions('invalid','darwin'),/签名模式/);
 const plain=load(await readFile('electron-builder.yml','utf8')),signed=load(await readFile('electron-builder.signed.yml','utf8'));
 assert.equal(plain.mac.identity,'-');assert.equal(plain.mac.notarize,false);
 assert.deepEqual(plain.asarUnpack,['node_modules/**/*.node']);assert.deepEqual(plain.mac.asarUnpack,['node_modules/**/*']);
 assert.equal(signed.forceCodeSigning,true);assert.equal(signed.mac.notarize,true);assert.equal(signed.win.verifyUpdateCodeSignature,true);
});

test('branch model routes development through develop and keeps main as the release branch',async()=>{
 const policy=load(await readFile('.github/workflows/branch-policy.yml','utf8'));
 assert.deepEqual(policy.on.pull_request.branches,['develop','main']);
 assert.deepEqual(Object.keys(policy.jobs),['branch-policy']);
 assert.equal(policy.jobs['branch-policy'].if,"github.event_name == 'pull_request'");
 assert.deepEqual(policy.permissions,{contents:'read','pull-requests':'read'});
 const scripts=policy.jobs['branch-policy'].steps.filter((step)=>step.run).map((step)=>step.run).join('\n');
 assert.match(scripts,/main 只接受来自 develop 的合并 PR/);
 assert.match(scripts,/Conventional Commits/);
 assert.match(scripts,/版本号不一致/);
 assert.match(scripts,/不允许版本回退/);
 assert.match(scripts,/合并冲突标记/);
 const validate=load(await readFile('.github/workflows/validate.yml','utf8'));
 assert.ok(validate.on.pull_request,'桌面验收工作流必须覆盖所有 PR');
 assert.equal(validate.on.pull_request.branches,undefined,'桌面验收不得限定分支，否则 develop 的 PR 会被跳过');
 const pages=load(await readFile('.github/workflows/pages.yml','utf8'));
 assert.deepEqual(pages.on.push.branches,['main'],'官网只随主干部署');
 const guide=await readFile('docs/release-guide.md','utf8');
 assert.match(guide,/## 分支与合入流程/);
 assert.match(guide,/`develop`/);
 const agents=await readFile('AGENTS.md','utf8');
 assert.match(agents,/origin\/develop/);
 assert.match(agents,/### 分支模型/);
});
