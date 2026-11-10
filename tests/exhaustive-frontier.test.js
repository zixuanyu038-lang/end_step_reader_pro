'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {enumerateFrontier}=require('../forge/exhaustive-frontier.cjs');
const {observationKey}=require('../forge/information-set-trial.cjs');

test('the exhaustive frontier persists every sibling and resumes beyond the old limits',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mtg-frontier-'));
  t.after(()=>fs.rmSync(dir,{recursive:true}));
  const abort=new AbortController(),seen=[];
  const options={
    file:path.join(dir,'frontier.sqlite'),
    roots:[{line:1,world:{id:'world',root:{seed:1}}}],
    workers:[1,2,3],
    async expand(worker,root,path){
      seen.push(path.map(a=>a.key).join('/'));
      if(!path.length)return {stopReason:'decision',actions:Array.from({length:13},(_,i)=>({key:String(i),kind:'choice',actorId:0}))};
      if(path.length===18)return {stopReason:'game_over',state:{winnerId:'0'}};
      return {stopReason:'decision',actions:[{key:'step',kind:'choice',actorId:path.length%2}]};
    }
  };
  const partial=await enumerateFrontier({...options,signal:abort.signal,onProgress:({processed})=>{
    if(processed===1)abort.abort();
  }});
  assert.deepEqual(partial,{expanded:1,pending:13});
  const result=await enumerateFrontier(options);
  assert.deepEqual(result,{expanded:222,terminal:13});
  assert.equal(seen.length,235);
  assert.equal(new Set(seen).size,235);
});

test('an information-set hint advances its branch without dropping the breadth queue',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mtg-guided-frontier-'));
  t.after(()=>fs.rmSync(dir,{recursive:true}));
  const first={key:'first',kind:'choice',actorId:0},second={key:'second',kind:'choice',actorId:0};
  const roots=[{line:1,world:{id:'early',root:{seed:1}}},{line:2,world:{id:'late',root:{seed:2}}}];
  const order=[],guidedTerminals=[];
  const result=await enumerateFrontier({
    file:path.join(dir,'frontier.sqlite'),roots,workers:[1],
    async guide(){
      return {line:2,world:'late',path:[second],walk:{next:()=>second,terminal:winner=>guidedTerminals.push(winner)}};
    },
    async expand(worker,root,path){
      order.push([root.line,path.at(-1)?.key]);
      return path.length?{stopReason:'game_over',state:{winnerId:'0'}}:{stopReason:'decision',actions:[first,second]};
    }
  });
  assert.deepEqual(order.slice(0,2),[[2,undefined],[2,'second']]);
  assert.deepEqual(guidedTerminals,['0']);
  assert.deepEqual(result,{expanded:2,terminal:4});
});

test('information sets use the actor’s own hand and hide the other hand and private picks',()=>{
  const state=hand=>({turnNumber:8,phase:'MAIN1',priorityPlayerId:0,players:[
    {id:0,hand:[{id:10,name:'Stock Up'}],handSize:1},
    {id:1,hand:[{id:20,name:hand}],handSize:1}
  ]});
  const a=state('Solitude'),b=state('Plains');
  assert.equal(observationKey(a,[],[{key:'hidden-a',kind:'choice',actorId:1}]),
    observationKey(b,[],[{key:'hidden-b',kind:'choice',actorId:1}]));
  a.priorityPlayerId=b.priorityPlayerId=1;
  assert.notEqual(observationKey(a,[],[]),observationKey(b,[],[]));
});

test('proof pruning covers a resolved subtree and still compares every opening action',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mtg-proven-frontier-'));
  t.after(()=>fs.rmSync(dir,{recursive:true}));
  const choices=(...keys)=>keys.map(key=>({key,kind:'choice',actorId:0}));
  const seen=[];
  const result=await enumerateFrontier({
    file:path.join(dir,'frontier.sqlite'),roots:[{line:1,world:{id:'a',root:{seed:1}}}],workers:[1],viewer:0,
    async expand(worker,root,path){
      const key=path.map(a=>a.key).join('/');
      seen.push(key);
      const state={turnNumber:8,priorityPlayerId:'0'};
      if(!key)return {stopReason:'decision',state,actions:choices('opening','other opening')};
      if(key==='opening')return {stopReason:'decision',state,actions:choices('win','spare')};
      return {stopReason:'game_over',state:{...state,winnerId:key==='opening/win'?'0':'1'}};
    }
  });
  assert.deepEqual(seen,['','opening','other opening','opening/win']);
  assert.deepEqual(result,{covered:1,expanded:2,terminal:2});
});
