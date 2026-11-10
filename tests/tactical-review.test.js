'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {checkTacticalArm}=require('../forge/tactical-review.cjs');

test('a tactical challenge checks all opponent replies and immediate legal repairs',async()=>{
  const action=(key,actorId,kind='cast')=>({key,actorId,kind,label:key});
  const start=action('start',0),pass=action('pass',0,'pass');
  const counter=action('counter',1),remove=action('remove',1),wait=action('wait',1,'pass');
  const repairs=[action('repair1',0),action('repair2',0),pass];
  const decision=(actor,actions)=>({stopReason:'decision',state:{turnNumber:8,priorityPlayerId:actor},actions});
  const called=[];
  const result=await checkTacticalArm({path:[start],scope:'opening',viewer:0,turn:'8',async request(command,path){
    const key=path.map(a=>a.key).join('/');
    called.push([command,key]);
    if(command==='expand'){
      if(key==='start')return decision(0,[pass]);
      if(key==='start/pass')return decision(1,[counter,remove,wait]);
      return decision(0,repairs);
    }
    const won=key==='start'||key.endsWith('wait')||key.endsWith('counter/repair2');
    return {stopReason:'game_over',state:{turnNumber:9,winnerId:won?'0':'1'}};
  }});
  const replies=result.forks[0].replies;
  assert.deepEqual(replies.map(r=>r.action.key),['counter','remove','wait']);
  assert.deepEqual(replies.map(r=>r.best.value),[1,-1,1]);
  assert.ok(called.some(([command,key])=>command==='simulate'&&key==='start/pass/remove/repair2'));
  assert.equal(result.worst.value,-1);
  assert.equal(result.partial,false);
});

test('a route challenge preserves our suffix when only the opponent response changes',async()=>{
  const vial={key:'vial',kind:'activate',actorId:1},remove={key:'remove',kind:'cast',actorId:1};
  const attack={key:'attack',kind:'choice',actorId:0};
  const result=await checkTacticalArm({path:[vial,attack],scope:'route',viewer:0,turn:'8',async request(command,path){
    const key=path.map(a=>a.key).join('/');
    if(command==='expand')return {stopReason:'decision',state:{turnNumber:8,priorityPlayerId:path.length?0:1},
      actions:path.length?[attack]:[vial,remove]};
    if(key==='remove/attack')throw Error('Action no longer available');
    return {stopReason:'game_over',state:{turnNumber:key==='vial/attack'?8:14,winnerId:'0'}};
  }});
  const [same,different]=result.forks[0].replies;
  assert.equal(same.best.turn,8);
  assert.deepEqual(same.routeProbe.bestPath.map(a=>a.key),['vial','attack']);
  assert.equal(different.routeProbe.interrupted,'Action no longer available');
  assert.equal(different.best.turn,14);
});
