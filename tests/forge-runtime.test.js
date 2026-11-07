'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {ForgeClient}=require('../forge-client');
const {baseEngine,selectionFile,readForgeSelection,forgeCacheDir}=require('../forge-runtime');
const {stageForgeRelease}=require('../forge/update-runtime.cjs');

test('a verified Forge update affects new clients only and a bad update preserves the selection',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-selection-test-'));
  const existing=new ForgeClient({dataDir});
  const archive=path.join(dataDir,'forge-installer-2.0.16.tar.bz2');
  const contents=Buffer.from('synthetic archive');
  await fs.writeFile(archive,contents);
  const sha256=crypto.createHash('sha256').update(contents).digest('hex');
  const options={archive,dataDir,
    fetchImpl:async()=>({ok:true,json:async()=>({tag_name:'forge-2.0.16',draft:false,prerelease:false,
      assets:[{name:path.basename(archive),size:contents.length,digest:'sha256:'+sha256}]})}),
    unpack:async(_file,folder,jar)=>fs.writeFile(path.join(folder,jar),'synthetic jar'),
    verify:async({forgeDir})=>fs.access(path.join(forgeDir,'forge-gui-desktop-2.0.16-jar-with-dependencies.jar'))
  };
  assert.equal(await stageForgeRelease(options),'forge-2.0.16');
  assert.equal(existing.engine,baseEngine);
  const selected=new ForgeClient({dataDir});
  assert.equal(selected.engine,'forge-2.0.16');
  assert.notEqual(selected.classes,existing.classes);
  assert.notEqual(forgeCacheDir(selected,dataDir),dataDir);
  const before=readForgeSelection(dataDir);
  await assert.rejects(stageForgeRelease({...options,verify:async()=>{throw Error('incompatible');}}),/incompatible/);
  await fs.writeFile(archive,'wrong archive');
  await assert.rejects(stageForgeRelease(options),/SHA-256/);
  assert.deepEqual(readForgeSelection(dataDir),before);
  await fs.rm(selectionFile(dataDir));
  assert.equal(new ForgeClient({dataDir}).engine,baseEngine);
  assert.equal(selected.engine,'forge-2.0.16');
});
