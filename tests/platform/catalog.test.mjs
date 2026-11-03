import test from 'node:test';import assert from 'node:assert/strict';import {validateCatalog,resolveMarketEntries,releaseFragmentUrl,expectedReleaseArtifactUrl} from '../../desktop/catalog.mjs';
const entry={id:'official.fixture',version:'0.1.0',title:'工具',description:'说明',artifacts:{'darwin-arm64':{url:'https://example.com/plugin.ecplugin',sha256:'a'.repeat(64),signature:'b'.repeat(88)}}};
const icon='data:image/png;base64,iVBORw0KGgo=';
test('catalog rejects corrupt data and duplicate/protected identities before rendering',()=>{
 assert.equal(validateCatalog({schemaVersion:1,plugins:[entry]})[0].id,entry.id);
 for(const plugins of [[entry,entry],[{...entry,id:'system.home'}],[{...entry,description:null}],[{...entry,version:'invalid'}],[{...entry,artifacts:{'darwin-arm64':{...entry.artifacts['darwin-arm64'],url:'file:///tmp/plugin'}}}]])assert.throws(()=>validateCatalog({schemaVersion:1,plugins}));
});
test('market API ranges default to 1.0 and mark future APIs incompatible', () => {
 const entries=validateCatalog({schemaVersion:1,plugins:[entry,{...entry,id:'official.future',api:'^2.0.0'}]});
 assert.equal(entries[0].compatible,true);assert.equal(entries[1].compatible,false);
 assert.throws(()=>validateCatalog({schemaVersion:1,plugins:[{...entry,api:'invalid'}]}));
});
test('market download stats are optional but must be non-negative safe integers', () => {
 assert.equal(validateCatalog({schemaVersion:1,plugins:[{...entry,stats:{downloads:31000}}]})[0].stats.downloads,31000);
 for(const stats of [{downloads:-1},{downloads:1.5},{downloads:'31K'},{downloads:Number.MAX_SAFE_INTEGER+1},[]]) assert.throws(()=>validateCatalog({schemaVersion:1,plugins:[{...entry,stats}]}));
});
test('market plugin icons must be bounded PNG data URLs', () => {
 assert.equal(validateCatalog({schemaVersion:1,plugins:[{...entry,icon}]})[0].icon,icon);
 for(const invalid of ['https://example.com/icon.png','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,AAAA','data:image/png;base64,'+'A'.repeat(49153)]) assert.throws(()=>validateCatalog({schemaVersion:1,plugins:[{...entry,icon:invalid}]}));
});
test('market entries project explicit tiers and legacy publisher fields without inferring platform', () => {
 const entries=validateCatalog({schemaVersion:1,plugins:[
  entry,
  {...entry,id:'community.fixture'},
  {...entry,id:'community.verified',official:true},
  {...entry,id:'official.legacy',official:false},
  {...entry,id:'official.explicit-tier',tier:'community',official:false},
  {...entry,id:'community.explicit-tier',tier:'official'},
  {...entry,id:'community.platform-tier',tier:'platform',official:true},
]});
 assert.deepEqual(entries.map(item=>item.tier),['official','community','official','community','community','official','platform']);
 assert.deepEqual(entries.map(item=>item.official),[true,false,true,false,false,true,true]);
 assert.throws(()=>validateCatalog({schemaVersion:1,plugins:[{...entry,official:'yes'}]}));
 for(const invalid of [
  {...entry,tier:'builtin'},
  {...entry,tier:'platform',official:false},
  {...entry,tier:'community',official:true},
 ]) assert.throws(()=>validateCatalog({schemaVersion:1,plugins:[invalid]}));
});

test('source entries resolve the latest release without changing the market catalog', async () => {
 const platform='darwin-arm64',repository='ZhiPenTu/qingzuo-plugin-fixture';
 const sourceEntry={...entry,id:'official.fixture',source:{type:'github-release',repository}};
 const version='0.2.0',url=expectedReleaseArtifactUrl(repository,sourceEntry.id,version,platform);
 const fragment={schemaVersion:1,plugins:[{id:sourceEntry.id,version,title:entry.title,description:entry.description,releaseNotes:'新版本',artifacts:{[platform]:{url,size:42,sha256:'c'.repeat(64)}}}]};
 const requested=[];
 const [resolved]=await resolveMarketEntries({schemaVersion:1,plugins:[sourceEntry]},{platform,load:async address=>{requested.push(address);return Buffer.from(JSON.stringify(fragment));}});
 assert.equal(requested[0],releaseFragmentUrl(repository,platform));
 assert.equal(resolved.version,version);assert.equal(resolved.releaseNotes,'新版本');assert.equal(resolved.verification,'github-release');assert.equal(resolved.tier,'official');assert.equal(resolved.official,true);
 assert.deepEqual(resolved.artifacts[platform],{url,size:42,sha256:'c'.repeat(64)});
});

test('source failures keep the legacy snapshot but mark it unavailable', async () => {
 const platform='darwin-arm64',repository='ZhiPenTu/qingzuo-plugin-fixture';
 const sourceEntry={...entry,id:'official.fixture',source:{type:'github-release',repository}};
 const [resolved]=await resolveMarketEntries({schemaVersion:1,plugins:[sourceEntry]},{platform,load:async()=>{throw new Error('offline');}});
 assert.equal(resolved.sourceUnavailable,true);assert.equal(resolved.version,entry.version);assert.equal(resolved.tier,'official');assert.equal(resolved.official,true);
});

test('new releases do not reuse release notes from the legacy snapshot', async () => {
 const platform='darwin-arm64',repository='ZhiPenTu/qingzuo-plugin-fixture';
 const sourceEntry={...entry,id:'official.fixture',releaseNotes:'旧版本说明',source:{type:'github-release',repository}};
 const version='0.2.0',url=expectedReleaseArtifactUrl(repository,sourceEntry.id,version,platform);
 const fragment={schemaVersion:1,plugins:[{id:sourceEntry.id,version,title:entry.title,description:entry.description,api:'^1.0.0',artifacts:{[platform]:{url,size:42,sha256:'c'.repeat(64)}}}]};
 const [resolved]=await resolveMarketEntries({schemaVersion:1,plugins:[sourceEntry]},{platform,load:async()=>Buffer.from(JSON.stringify(fragment))});
 assert.equal(resolved.releaseNotes,undefined);
});
test('release fragments cannot change or inject trust identity reviewed in the catalog', async () => {
 const platform='darwin-arm64',repository='ZhiPenTu/qingzuo-plugin-fixture';
 const sourceEntry={...entry,id:'community.explicit-tier',tier:'official',official:true,source:{type:'github-release',repository}};
 const version='0.2.0',url=expectedReleaseArtifactUrl(repository,sourceEntry.id,version,platform);
 for(const injected of [
  {tier:'platform'},
  {official:false},
  {source:{type:'github-release',repository:'other/repository'}},
  {stats:{downloads:1}},
  {verification:'github-release'},
 ]) {
  const fragment={schemaVersion:1,plugins:[{id:sourceEntry.id,version,title:entry.title,description:entry.description,...injected,artifacts:{[platform]:{url,size:42,sha256:'c'.repeat(64)}}}]};
  const [resolved]=await resolveMarketEntries({schemaVersion:1,plugins:[sourceEntry]},{platform,load:async()=>Buffer.from(JSON.stringify(fragment))});
  assert.equal(resolved.sourceUnavailable,true);
  assert.equal(resolved.tier,'official');
  assert.equal(resolved.official,true);
  assert.deepEqual(resolved.source,sourceEntry.source);
 }
 for(const injected of [
  {tier:'platform'},
  {official:false},
  {source:{type:'github-release',repository:'other/repository'}},
  {stats:{downloads:1}},
  {verification:'github-release'},
 ]) {
  const fragment={schemaVersion:1,...injected,plugins:[{id:sourceEntry.id,version,title:entry.title,description:entry.description,artifacts:{[platform]:{url,size:42,sha256:'c'.repeat(64)}}}]};
  const [resolved]=await resolveMarketEntries({schemaVersion:1,plugins:[sourceEntry]},{platform,load:async()=>Buffer.from(JSON.stringify(fragment))});
  assert.equal(resolved.sourceUnavailable,true);
  assert.equal(resolved.tier,'official');
  assert.equal(resolved.official,true);
  assert.deepEqual(resolved.source,sourceEntry.source);
 }
 const artifactFragment={schemaVersion:1,plugins:[{id:sourceEntry.id,version,title:entry.title,description:entry.description,artifacts:{[platform]:{url,size:42,sha256:'c'.repeat(64),tier:'platform'}}}]};
 const [artifactResolved]=await resolveMarketEntries({schemaVersion:1,plugins:[sourceEntry]},{platform,load:async()=>Buffer.from(JSON.stringify(artifactFragment))});
 assert.equal(artifactResolved.sourceUnavailable,true);
});
test('legacy release fragments keep working while harmless manifest fields are stripped', async () => {
 const platform='darwin-arm64',repository='ZhiPenTu/qingzuo-plugin-fixture';
 const sourceEntry={...entry,id:'official.fixture',source:{type:'github-release',repository}};
 const version='0.2.0',url=expectedReleaseArtifactUrl(repository,sourceEntry.id,version,platform);
 const fragment={schemaVersion:1,plugins:[{
  id:sourceEntry.id,
  version,
  title:entry.title,
  description:entry.description,
  manifestVersion:1,
  ui:'ui/index.html',
  permissions:{network:['https://example.com']},
  backend:{type:'node',entry:'backend/index.mjs'},
  services:{provides:['fixture']},
  artifacts:{[platform]:{url,size:42,sha256:'c'.repeat(64)}},
 }]};
 const [resolved]=await resolveMarketEntries({schemaVersion:1,plugins:[sourceEntry]},{platform,load:async()=>Buffer.from(JSON.stringify(fragment))});
 assert.equal(resolved.sourceUnavailable,undefined);
 assert.equal(resolved.version,version);
 assert.equal(resolved.tier,'official');
 for(const field of ['manifestVersion','ui','permissions','backend','services']) assert.equal(field in resolved,false);
});

test('release fragments must keep the artifact inside the registered repository and version', async () => {
 const platform='darwin-arm64',repository='ZhiPenTu/qingzuo-plugin-fixture';
 const sourceEntry={...entry,id:'official.fixture',source:{type:'github-release',repository}};
 const fragment={schemaVersion:1,plugins:[{id:sourceEntry.id,version:'0.2.0',title:entry.title,description:entry.description,artifacts:{[platform]:{url:'https://github.com/other/repo/releases/download/v0.2.0/bad.ecplugin',size:42,sha256:'c'.repeat(64)}}}]};
 const [resolved]=await resolveMarketEntries({schemaVersion:1,plugins:[sourceEntry]},{platform,load:async()=>Buffer.from(JSON.stringify(fragment))});
 assert.equal(resolved.sourceUnavailable,true);
});

test('source-only catalog entries are accepted while unsafe repository paths are rejected', () => {
 const source={type:'github-release',repository:'ZhiPenTu/qingzuo-plugin-fixture'};
 assert.equal(validateCatalog({schemaVersion:1,plugins:[{id:'official.fixture',version:'0.1.0',title:'工具',description:'说明',source}]})[0].id,'official.fixture');
 for(const repository of ['owner','owner/..','owner/repo/extra']) assert.throws(()=>validateCatalog({schemaVersion:1,plugins:[{id:'official.fixture',version:'0.1.0',title:'工具',description:'说明',source:{...source,repository}}]}));
 assert.equal(validateCatalog({schemaVersion:1,plugins:[{...entry,verification:'github-release',sourceUnavailable:true}]})[0].verification,undefined);
});

test('release resolution bounds concurrent fragment loads for large catalogs', async () => {
 const platform='darwin-arm64';
 const plugins=Array.from({length:24},(_,index)=>({id:`official.fixture${index}`,version:'0.1.0',title:'工具',description:'说明',source:{type:'github-release',repository:'ZhiPenTu/qingzuo-plugin-fixture'}}));
 let inFlight=0,maxInFlight=0;
 const load=async()=>{inFlight+=1;maxInFlight=Math.max(maxInFlight,inFlight);await new Promise(resolve=>setTimeout(resolve,5));inFlight-=1;throw new Error('offline');};
 const resolved=await resolveMarketEntries({schemaVersion:1,plugins},{platform,load});
 assert.equal(resolved.length,24);
 assert.ok(resolved.every(item=>item.sourceUnavailable===true));
 assert.ok(maxInFlight<=6,`expected at most 6 concurrent loads, saw ${maxInFlight}`);
});
