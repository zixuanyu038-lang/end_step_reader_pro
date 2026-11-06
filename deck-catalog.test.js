'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DeckCatalog,normalizeDeck,rankCandidates,syncCatalog}=require('../deck-catalog'),{DeckService}=require('../deck-service');
const sha=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function deck(extra={}){return normalizeDeck({format:'Legacy',date:'2026-11-01',url:'https://www.mtgo.com/decklist/legacy-test',sourceSha256:'a'.repeat(64),main:[{name:'Island',count:48},{name:'Ponder',count:4},{name:'Brainstorm',count:4},{name:'Force of Will',count:4}],sideboard:[{name:'Hydroblast',count:3}],...extra});}
async function directory(t){const base=path.resolve(os.tmpdir()),dir=await fs.mkdtemp(path.join(base,'endstep-catalog-'));t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),base);assert.ok(path.basename(dir).startsWith('endstep-catalog-'));return fs.rm(dir,{recursive:true,force:true});});return dir;}
test('partial observations do not penalize unseen cards; known sideboard cards and counts constrain matches',()=>{
 const a=deck(),b=deck({main:[{name:'Island',count:48},{name:'Ponder',count:4},{name:'Brainstorm',count:4},{name:'Daze',count:4}]});
 const facts=[{name:'Island',count:1},{name:'Ponder',count:1},{name:'Brainstorm',count:1}];
 const matched=rankCandidates([a,b],facts);assert.equal(matched.length,2);assert.equal(matched[0].coverage,1);assert.equal(matched[1].coverage,1);
 const side=rankCandidates([a],facts.concat({name:'Hydroblast',count:2}));assert.equal(side[0].coverage,1);
 assert.equal(rankCandidates([a],facts.concat({name:'Hydroblast',count:2}),{global:false}).length,0);
 assert.equal(rankCandidates([a],facts,{initialSize:80}).length,0);assert.equal(rankCandidates([a],facts,{asOf:'2026-10-01'}).length,0);
});
test('catalog validates snapshot integrity; local AI selection cannot invent a list or rewrite its cards',async t=>{
 const dir=await directory(t),file=path.join(dir,'catalog.json'),original=deck();await fs.writeFile(file,JSON.stringify({version:1,decks:[original],sha256:sha([original])}));
 const catalog=new DeckCatalog({file,bundledFile:path.join(dir,'missing.json')}),calls=[];
 const service=new DeckService({directory:path.join(dir,'cache'),catalog});
 const source={global:true,format:'Legacy',initialDeckSizes:{0:60},known:['Island','Ponder','Brainstorm'].map((name,id)=>({id,name,ownerId:'0'}))};
 const result=await service.resolve({source,playerId:'0',ask:async(prompt,schema,options)=>{calls.push({prompt,options});return{found:true,candidateId:original.id,archetype:'Blue test',basis:'Observed signatures.'};}});
 assert.equal(result.lookup,'local-catalog');assert.equal(result.verified,true);assert.deepEqual(result.main,original.main);assert.equal(calls.length,1);assert.equal(calls[0].options,undefined);assert.ok(result.sourceSha256);
 await service.resolve({source,playerId:'0',ask:()=>{throw Error('cache should not call AI');}});
 const altered={...original,date:'2026-11-02'};await fs.writeFile(file,JSON.stringify({version:1,decks:[altered],sha256:sha([original])}));assert.deepEqual(await catalog.load(),[]);
 const bad=new DeckService({directory:path.join(dir,'invalid'),catalog:{find:async()=>[{deck:original,coverage:1,missing:[]}]}});
 await assert.rejects(bad.resolve({source,playerId:'0',ask:async()=>({found:true,candidateId:'invented',archetype:'x',basis:'x'})}),/不存在/);
});
test('snapshot updater verifies upstream Git blob before publishing and preserves source provenance',async t=>{
 const dir=await directory(t),revision='b'.repeat(40),month='c'.repeat(40),entry={Tournament:{Date:'2026-11-01',Name:'Legacy League',Uri:'https://www.mtgo.com/decklist/legacy-test'},Decks:[{Mainboard:deck().main.map(c=>({CardName:c.name,Count:c.count})),Sideboard:[]}]};
 const bytes=Buffer.from(JSON.stringify(entry)),gitSha=crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
 const fake=async url=>{let body;if(url.endsWith('/commits/main'))body={sha:revision};else if(url.includes('/contents/'))body=[{name:'11',type:'dir',sha:month}];else if(url.includes('/git/trees/'))body={tree:[{path:'01/legacy-league-test.json',type:'blob',sha:gitSha,size:bytes.length}]};else body={encoding:'base64',content:bytes.toString('base64')};return new Response(JSON.stringify(body));};
 const output=path.join(dir,'snapshot.json'),result=await syncCatalog({output,months:1,now:new Date('2026-11-06T00:00:00Z'),fetchImpl:fake});assert.equal(result.decks,1);
 const loaded=await new DeckCatalog({file:output,bundledFile:path.join(dir,'none')}).load();assert.ok(loaded[0].sourceFile.includes(revision));assert.equal(loaded[0].url,entry.Tournament.Uri);
 await assert.rejects(syncCatalog({output:path.join(dir,'bad.json'),months:1,now:new Date('2026-11-06T00:00:00Z'),fetchImpl:async url=>url.includes('/git/blobs/')?new Response(JSON.stringify({encoding:'base64',content:Buffer.from('corrupt').toString('base64')})):fake(url)}),/Git 文件哈希/);
});
