import test from 'node:test';import assert from 'node:assert/strict';import {validateCatalog} from '../../desktop/catalog.mjs';
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
