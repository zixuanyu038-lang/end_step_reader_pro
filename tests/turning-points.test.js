'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {findTurningPoints,gameOutcomes}=require('../turning-points');
const action=(key,cardName,actorId,cardId)=>({key,label:cardName,cardName,actorId,cardId,kind:'cast'});
const own=action('original','Lightning Bolt',1,1),better=action('better','Fireblast',1,2),reply=action('reply','Counterspell',0,3);
const state={turnNumber:4,phase:'MAIN1',priorityPlayerId:'1',players:[]};
function fixture(outcome,{flip=true}={}){
 const source={header:{seat:1},baseline:state,anchor:{line:2,turn:4},game:1,rows:[{line:2,row:{k:'action',action:{type:'PLAY_CARD',cardId:1}}}]};
 const worlds=['a','b'].map(id=>({id,root:{seed:id},scenario:{kind:'fixture'}}));
 const record={source,worlds,node:{sourceLine:3,outcome},checkedWorlds:worlds.map(()=>({initial:{state,actions:[own,better]}})),result:{}};
 const calls=[];
 const forge={async request({command,root,path,includeTrace}){
   calls.push({command,seed:root.seed,path:path.map(a=>a.key),includeTrace});
   if(command==='expand')return {stopReason:'decision',state:{...state,priorityPlayerId:'0'},actions:[reply]};
   const modified=path.some(a=>a.key==='better'||a.key==='reply');
   const winner=(outcome==='win')!==Boolean(modified&&flip)?'1':'0';
   return {stopReason:'game_over',state:{...state,status:'COMPLETE',winnerId:winner},executed:[...path],trace:includeTrace?['fixture']:[]};
 }};
 const ask=async(prompt)=>{
   assert.match(prompt,outcome==='win'?/胜 → 负/:/负 → 胜/);
   const id=outcome==='win'?'opponent:'+JSON.stringify(['cast','Counterspell',null,null,null,null]):'own:better';
   return {tests:[{sourceLine:3,testId:id,reason:'Check the lethal exchange'}]};
 };
 return {record,forge,ask,calls};
}
test('the loss review keeps only an actual loss-to-win change in the same world',async()=>{
 const {record,forge,ask,calls}=fixture('loss');
 await findTurningPoints({records:[record],forge,ask,onProgress:()=>{}});
 const key=record.result.turningTest.key;
 assert.equal(key.direction,'负 → 胜');
 assert.deepEqual([key.baseline.outcome,key.changed.outcome],['loss','win']);
 assert.equal(key.change,'Fireblast');
 assert.equal(key.discovery.flips,2);
 assert.ok(calls.some(c=>c.includeTrace&&c.path[0]==='better'));
});
test('the win review can keep a verified opponent counter and rejects same-result lines',async()=>{
 const a=fixture('win');
 await findTurningPoints({records:[a.record],forge:a.forge,ask:a.ask,onProgress:()=>{}});
 const key=a.record.result.turningTest.key;
 assert.equal(key.kind,'opponent');
 assert.deepEqual(key.changedPath.map(a=>a.key),['original','reply']);
 assert.deepEqual([key.baseline.outcome,key.changed.outcome],['win','loss']);
 const b=fixture('win',{flip:false});
 await findTurningPoints({records:[b.record],forge:b.forge,ask:b.ask,onProgress:()=>{}});
 assert.equal(b.record.result.turningTest.key,null);
 assert.equal(b.record.result.quality,undefined);
});
test('per-game results come from each game winner, leaving draws out',()=>{
 const turns=[0,1,null].map((playerIndex,i)=>({game:i+1,entries:[{type:'GAME_OUTCOME',raw:{playerIndex}}]}));
 assert.deepEqual(gameOutcomes({header:{seat:1,result:'win',complete:true},turns}),{1:'loss',2:'win'});
});

test('Stock Up resolution selections do not become cast targets',()=>{
 const {originalSelection}=require('../tree-search');
 const source={anchor:{line:2},baseline:{stack:[]},rows:[
  {line:2,row:{k:'action',action:{type:'PLAY_CARD',cardId:1}}},
  {line:3,row:{k:'event',event:{type:'SPELL_CAST',cardId:1}}},
  {line:4,row:{k:'action',action:{type:'CHOOSE_TARGETS',targets:[23,28]}}}
 ]};
 const stock={...own,cardName:'Stock Up',targets:[]};
 assert.equal(originalSelection(source,[stock]).action,stock);
});
