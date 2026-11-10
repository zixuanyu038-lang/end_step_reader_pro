'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{selectWinningLines,finalists}=require('../winning-lines'),{search}=require('../tree-search');
const initial={players:[],stack:[],turnNumber:3,phase:'MAIN1',activePlayerId:'1',priorityPlayerId:'1',status:'ACTIVE'};
const action=(key,cardId)=>({key,cardId,cardName:key,actorId:1,kind:'cast',label:key,targets:[],modes:[],abilityIndex:0});
const source=()=>({header:{seat:1},baseline:initial,game:1,anchor:{line:5},rows:[{line:5,row:{k:'action',action:{type:'PLAY_CARD',cardId:2}}}],knownTop:{}});
const record=()=>({source:source(),node:{sourceLine:6,question:'Test decision'},worlds:[{id:'world',root:{seed:1,intent:{goals:[]}},hiddenHands:[]}],result:{winningCandidates:[{id:'win',worldId:'world',path:[action('candidate',3)],terminal:true,winnerId:'1',turn:8,executed:[],features:[]}]}});
test('fast MCTS uses normalized terminal rewards, caches duplicate evaluations and collects unique wins',async()=>{
 const actions=[action('winning',2),action('losing',3),{kind:'pass',key:'pass:1',actorId:1,label:'Pass'}],calls=[];
 const client={async request(input){calls.push(input);if(input.command==='expand')return{state:{...initial},actions:input.path.length?[]:actions,rootLibraries:[],stopReason:'decision'};const winner=input.path[0]?.key==='winning'?'1':'0';return{state:{...initial,status:'COMPLETE',winnerId:winner},stopReason:'game_over',evaluation:{score:winner==='1'?1000000:-1000000,features:[]},executed:[],intentStatus:{completed:0,total:0,blocked:[]},trace:[]};}};
 const result=await search({client,source:source(),worlds:[{id:'world',root:{seed:1}}],budget:{iterations:20,width:3}});
 assert.equal(result.best.action.key,'winning');assert.equal(result.simulated,3);assert.equal(result.winningCandidates.length,1);assert.ok(result.runs[0].tree.children.find(c=>c.action.key==='winning').visits>result.runs[0].tree.children.find(c=>c.action.key==='losing').visits);assert.ok(calls.every(c=>c.includeTrace===false));
});
test('no winning continuation means no AI call and no retained recommendation',async()=>{
 const r=record();r.result.winningCandidates=[];await selectWinningLines({records:[r],forge:{request(){throw Error('No engine call expected');}},ask(){throw Error('No AI call expected');}});assert.equal(r.result.quality.keep,false);
});
test('all fixed roots must pass restoration before any search iteration starts',async()=>{
 const calls=[];
 const client={async request(input){
   calls.push(input);
   return {state:initial,actions:[action('test',2)],rootLibraries:[],stopReason:input.root.seed===2?'choice_budget':'decision'};
 }};
 await assert.rejects(()=>search({client,source:source(),worlds:[{id:'ok',root:{seed:1}},{id:'bad',root:{seed:2}}]}),/未恢复/);
 assert.deepEqual(calls.map(call=>[call.command,call.path,call.root.seed]),[['expand',[],1],['expand',[],2]]);
});
test('adversarial UCT explores the opponent refutation instead of assuming a cooperative win',async()=>{
 const aggressive=action('aggressive',2),safe=action('safe',3),refute={...action('refute',4),actorId:0},cooperate={...action('cooperate',5),actorId:0};
 const client={async request(input){const path=input.path,after=path.length>0;if(input.command==='expand')return{state:{...initial,priorityPlayerId:after?'0':'1'},actions:path.length>=2?[]:after?[refute,cooperate]:[aggressive,safe],rootLibraries:[],stopReason:'decision'};const winner=path[0]?.key==='aggressive'&&path[1]?.key==='refute'?'0':'1';return{state:{...initial,status:'COMPLETE',winnerId:winner},stopReason:'game_over',evaluation:{score:winner==='1'?1000000:-1000000,features:[]},executed:[],intentStatus:{completed:0,total:0,blocked:[]},trace:[]};}};
 const result=await search({client,source:source(),worlds:[{id:'world',root:{seed:1}}],budget:{iterations:80,width:3,maxDepth:3}});assert.equal(result.best.action.key,'safe');const trap=result.runs[0].tree.children.find(c=>c.action.key==='aggressive');assert.ok(trap.children.find(c=>c.action.key==='refute').visits>trap.children.find(c=>c.action.key==='cooperate').visits);
});
test('an accepted winner is replayed and compared against the selected root, not a different best action',async()=>{
 const r=record();r.result.alternatives=[{action:{key:'candidate'},mean:5,worlds:[{worldIndex:0,mean:5}]}];r.result.original={mean:2,worlds:[{worldIndex:0,mean:2}]};
 r.result.winningCandidates[0].executed=[{turn:8,cardName:'Lightning Bolt'}];
 const forge={async request(input){if(input.command==='expand')return{actions:[action('original',2)]};return{state:{...initial,turnNumber:8,status:'COMPLETE',winnerId:'1'},stopReason:'game_over',evaluation:{features:[]},intentStatus:{completed:0,total:0,blocked:[]},executed:[{cardName:'Lightning Bolt',turn:8}],trace:[]};}};
 await selectWinningLines({records:[r],forge,ask:async()=>({selections:[{sourceLine:6,candidateId:'win',keep:true,reason:'Fixture comparison',risks:[],confidence:'medium'}]})});assert.equal(r.result.quality.keep,true);assert.equal(r.result.comparison.meanDifference,3);assert.equal(r.result.representative.worldId,'world');
});
test('AI can reject winning candidates without producing a retained replay',async()=>{
 const r=record(),calls=[];
 const forge={async request(input){calls.push(input);if(input.command==='expand')return{actions:[action('original',2)]};assert.equal(input.root.intent,undefined);return{state:{...initial,status:'COMPLETE',winnerId:'1'},stopReason:'game_over',evaluation:{features:[]},executed:[]};}};
 await selectWinningLines({records:[r],forge,ask:async()=>({selections:[{sourceLine:6,candidateId:'',keep:false,reason:'No demonstrated improvement over original.',risks:[],confidence:'low'}]})});assert.equal(r.result.quality.keep,false);assert.ok(calls.every(c=>!c.includeTrace));assert.ok(r.worlds[0].root.intent);
});
test('AI cannot select an absent candidate or retain a victory that fails deterministic replay',async()=>{
 const forge={async request(input){if(input.command==='expand')return{actions:[action('original',2)]};return{state:{...initial,status:'COMPLETE',winnerId:input.includeTrace?'0':'1'},stopReason:'game_over',evaluation:{features:[]},intentStatus:{completed:0,total:0,blocked:[]},executed:[]};}};
 const answer=candidateId=>async()=>({selections:[{sourceLine:6,candidateId,keep:true,reason:'Fixture selection',risks:[],confidence:'medium'}]});
 await assert.rejects(()=>selectWinningLines({records:[record()],forge,ask:answer('invented')}),/不存在/);
 await assert.rejects(()=>selectWinningLines({records:[record()],forge,ask:answer('win')}),/未能稳定重放/);
 const r=record();r.result.winningCandidates.push({...r.result.winningCandidates[0],id:'duplicate'});assert.equal(finalists(r.result).length,1);
});

test('the Forge probe cache keys on the full hidden world and the continuation budget',async()=>{
 const {ForgePool}=require('../forge-client');
 const pool=new ForgePool({workers:2});
 try{
  let calls=0;
  const worker={async request(){return {sample:++calls};}};
  const input={command:'simulate',searchProbe:true,root:{seed:7,stateText:'p0hand=Brainstorm'},path:[{key:'pass:0'}],horizonTurns:5};
  assert.deepEqual(await pool.searchProbe(input,{},worker),{result:{sample:1},reused:false});
  assert.deepEqual(await pool.searchProbe(structuredClone(input),{},worker),{result:{sample:1},reused:true});
  assert.equal((await pool.searchProbe({...input,horizonTurns:6},{},worker)).reused,false);
  assert.equal((await pool.searchProbe({...input,root:{...input.root,stateText:'p0hand=Daze'}},{},worker)).reused,false);
  await assert.rejects(pool.searchProbe(input,{signal:AbortSignal.abort()},worker),{name:'AbortError'});
  assert.equal(calls,3);
 }finally{pool.close();}
});
