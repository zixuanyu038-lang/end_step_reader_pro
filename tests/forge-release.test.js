'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {checkForgeRelease}=require('../forge-release');
const {createStudio}=require('../studio-server');

const forge={
  status:async()=>({installed:true,engine:'forge-2.0.15'}),
  request:()=>assert.fail('Version checks must not run Forge'),
  close(){}
};
const codex={status:()=>assert.fail('Version checks must not connect Codex'),close(){}};
const metadata=(tag,extra={})=>({ok:true,json:async()=>({tag_name:tag,draft:false,prerelease:false,...extra})});

test('only newer official stable versions produce an update notice',async()=>{
  for(const [tag,state] of [['forge-2.0.16','update'],['forge-2.0.15','current'],['forge-2.0.9','current'],['daily-snapshots','unavailable']]){
    const result=await checkForgeRelease(forge,{fetchImpl:async()=>metadata(tag)});
    assert.equal(result.state,state);
    if(state==='update')assert.equal(result.url,'https://github.com/Card-Forge/forge/releases/tag/forge-2.0.16');
  }
  assert.equal((await checkForgeRelease(forge,{fetchImpl:async()=>metadata('forge-2.0.16',{prerelease:true})})).state,'unavailable');
  assert.equal((await checkForgeRelease({status:async()=>({installed:false})},{fetchImpl:()=>assert.fail('Missing Forge does not require a remote request')})).state,'not_installed');
});

test('network, response body, and local status stalls share a hard deadline',async()=>{
  const never=()=>new Promise(()=>{});
  for(let attempt=0;attempt<3;attempt++){
    let requestSignal;
    const results=await Promise.all([
      checkForgeRelease(forge,{timeoutMs:40,fetchImpl:async(_url,{signal})=>{requestSignal=signal;return never();}}),
      checkForgeRelease(forge,{timeoutMs:40,fetchImpl:async()=>({ok:true,json:never})}),
      checkForgeRelease({status:never},{timeoutMs:40,fetchImpl:()=>assert.fail('Local status must complete first')}),
      checkForgeRelease(forge,{fetchImpl:async()=>({ok:false,status:429})}),
      checkForgeRelease(forge,{fetchImpl:async()=>{throw Error('DNS unavailable');}})
    ]);
    assert(results.every(result=>result.state==='unavailable'));
    assert.equal(requestSignal.aborted,true);
  }
});

test('Studio remains responsive while an upstream check is pending',{timeout:8000},async t=>{
  const nativeFetch=globalThis.fetch;
  const upstream=[];
  t.mock.method(globalThis,'fetch',(url,options)=>{
    if(url==='https://api.github.com/repos/Card-Forge/forge/releases/latest'){
      return new Promise(resolve=>upstream.push(resolve));
    }
    return nativeFetch(url,options);
  });
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-release-route-'));
  const studio=createStudio({port:0,dataDir,forgeClient:forge,client:codex});
  const origin=await studio.start();
  t.after(()=>studio.close());
  for(let attempt=0;attempt<3;attempt++){
    const first=await nativeFetch(origin);
    const headers={Cookie:first.headers.get('set-cookie').split(';')[0]};
    assert.match(await first.text(),/forge-version-ui\.js/);
    assert.equal((await nativeFetch(origin+'/forge-version-ui.js')).status,200);
    assert.notEqual((await nativeFetch(origin+'/api/forge/version')).status,200);
    const pending=nativeFetch(origin+'/api/forge/version',{headers});
    for(let wait=0;!upstream.length&&wait<200;wait++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(upstream.length,1,'the version route must start an upstream request');
    const home=await nativeFetch(origin);
    assert.equal(home.status,200);
    await home.text();
    upstream.shift()(metadata('forge-2.0.16'));
    const result=await pending.then(response=>response.json());
    assert.equal(result.state,'update');
  }
});
