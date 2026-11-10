'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),zlib=require('node:zlib');
const {createHash}=require('node:crypto');
const {setTimeout:sleep}=require('node:timers/promises');
const {createStudio}=require('../studio-server');
const {ForgePool}=require('../forge-client');
const {forgeCacheDir}=require('../forge-runtime');
const Replay=require('../replay');

async function main(){
  const [initialReplay,profileFile,directory,gameArg='1',expected]=process.argv.slice(2);
  assert.ok(initialReplay&&profileFile&&directory,'Pass a replay, cached deck profile, output directory and optional game number.');
  const dataDir=path.join(path.resolve(directory),'data'),game=Number(gameArg);
  const forge=new ForgePool({dataDir,workers:4,javaHeap:'2g',activeProcessors:2});
  const cached=path.join(forgeCacheDir(forge,dataDir),'forge-reviews');
  await fs.mkdir(cached,{recursive:true});
  await fs.copyFile(profileFile,path.join(cached,path.basename(profileFile)));
  const client={status:async()=>{throw Error('Codex disabled in this test');},
    generate:async()=>{throw Error('Unexpected model call');},close(){}};
  const studio=createStudio({port:0,dataDir,initialReplay,forgeClient:forge,client});
  try{
    const base=await studio.start(),home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];
    assert.match(await home.text(),/id="studio-findings"/);
    const request=async(route,options={})=>{
      const result=await fetch(base+route,{...options,headers:{cookie,'content-type':'application/json','x-endstep-request':'1'}});
      if(!result.ok)throw Error(await result.text());
      return result;
    };
    const json=async(...args)=>(await request(...args)).json();
    const health=await json('/api/health'),current=await json('/api/current');
    assert.equal(health.connected,false);
    assert.ok(health.forge.installed&&current.deckProfiles);
    assert.equal((await fetch(base+'/api/current')).status,401);
    const priorities=(await json('/api/replays/'+current.id+'/priorities')).filter(n=>n.game===game);
    assert.ok(priorities.some(n=>n.kind==='pass')&&priorities.some(n=>n.kind==='play'));
    async function run(comparisonPlan){
      const started=await json('/api/jobs',{method:'POST',
        body:JSON.stringify({type:'forge-findings',replayId:current.id,game,comparisonPlan})});
      let last='';
      for(;;){
        const job=await json('/api/jobs/'+started.id);
        if(last!==job.message){console.log(job.message);last=job.message;}
        if(job.status==='complete')return job;
        assert.equal(job.status,'running',job.error);
        await sleep(1800);
      }
    }
    const find=await run();
    assert.equal(find.result.priority.length,priorities.length);
    for(const line of (process.env.STUDIO_REQUIRED_PRIORITY_LINES||'').split(',').filter(Boolean).map(Number))
      assert.equal(find.result.priority.find(n=>n.sourceLine===line)?.status,'compared','Required priority node was not compared');
    const signature=job=>job.result.comparisons.map(c=>({line:c.line,world:c.world,prefix:c.prefix.map(a=>a.key),
      arms:c.arms.map(a=>[a.action.key,a.result,a.turn])}));
    assert.ok(find.result.comparisons.length>0,'The real fixture should produce key decisions.');
    if(expected)assert.deepEqual(signature(find),signature(JSON.parse(await fs.readFile(expected,'utf8'))));
    const plans=await json(find.result.planUrl);
    const repeat=await run(plans);
    assert.deepEqual(signature(repeat),signature(find));
    for(const comparison of repeat.result.comparisons){
      for(const arm of comparison.arms){
        const response=await request(arm.downloadUrl);
        const bytes=Buffer.from(await response.arrayBuffer());
        assert.equal(createHash('sha256').update(bytes).digest('hex'),arm.sha256);
        const replay=Replay.parse(zlib.gunzipSync(bytes).toString('utf8'),arm.file);
        assert.equal(replay.header.complete,true);
        assert.equal(replay.header.branchMeta.worldId,comparison.world);
        assert.equal(replay.header.result,arm.result);
        await fs.writeFile(path.join(directory,arm.file),bytes);
      }
    }
    await fs.writeFile(path.join(directory,'Forge-复现计划.json'),JSON.stringify(plans,null,2));
    await fs.writeFile(path.join(directory,'Forge-验收结果.json'),JSON.stringify({find,repeat},null,2));
    console.log(JSON.stringify({verified:signature(find)}));
  }finally{await studio.close();}
}

main().catch(error=>{console.error(error.stack);process.exitCode=1;});
