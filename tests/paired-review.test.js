'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {verifyPair,publicVerification}=require('../paired-review');

function fixture({refuted=false,replies=true}={}){
  const original={key:'original',label:'Original',cardId:1,cardName:'Original',kind:'cast',actorId:1};
  const alternative={...original,key:'alternative',label:'Alternative',cardId:2,cardName:'Alternative'};
  const reply={key:'reply',label:'Reply',cardId:3,cardName:'Reply',kind:'cast',actorId:0};
  const other={...reply,key:'other',label:'Other',cardName:'Other'};
  const recovery={...original,key:'recovery',label:'Recovery',cardId:4,cardName:'Recovery'};
  const initial={players:[],stack:[],turnNumber:3,phase:'MAIN1',activePlayerId:'1',priorityPlayerId:'1',status:'ACTIVE'};
  const source={header:{seat:1},baseline:initial,anchor:{line:2},rows:[{line:2,row:{k:'action',action:{type:'PLAY_CARD',cardId:1}}}]};
  const world=id=>({id,root:{stateText:id}});
  const discoveryWorld=world('discovery'),worlds=[discoveryWorld,...Array.from({length:8},(_,i)=>world(String(i)))];
  const calls=[];
  const forge={async request({command,root,path}){
    const keys=path.map(a=>a.key),alternate=keys[0]==='alternative',discovery=root.stateText==='discovery';
    calls.push([root.stateText,command,keys]);
    if(command==='expand'){
      const actions=path.length===0?[original,alternative]:path.length===1?
        replies?(discovery||Number(root.stateText)<4?[reply]:[other]):[]:[recovery];
      return {state:{...initial,priorityPlayerId:path.length===1?'0':'1'},stopReason:'decision',actions,rootLibraries:[]};
    }
    const lostToReply=keys[1]==='reply'&&!keys.includes('recovery')&&(discovery||(refuted&&root.stateText==='0'));
    const winner=alternate?!lostToReply:refuted&&root.stateText==='0'&&keys[1]==='reply';
    return {state:{...initial,status:'COMPLETE',winnerId:winner?'1':'0'},stopReason:'game_over'};
  }};
  return {args:{source,candidate:{path:[alternative]},discoveryWorld,worlds,forge},calls};
}

test('independent paired review freezes the discovery reply and finds a recovery without forcing it into holdouts',async()=>{
  const {args,calls}=fixture(),proof=await verifyPair(args);
  assert.equal(proof.attempted,8);
  assert.equal(proof.status,'supported');
  assert.equal(proof.native.better,8);
  assert.equal(proof.challenge.better,8);
  assert.deepEqual(proof.replies.map(r=>r.applications),[4,4]);
  assert.equal(proof.discovery.find(d=>d.arm==='alternative').recovery[0].outcome.value,1);
  assert.ok(calls.every(([id,,keys])=>id==='discovery'||!keys.includes('recovery')&&!keys.includes('other')));
  assert.equal(publicVerification(proof).samples,undefined);
});

test('a real counterexample or zero applied replies keeps the win as an illustration',async()=>{
  const result=await verifyPair(fixture({refuted:true}).args);
  assert.equal(result.native.better,8);
  assert.equal(result.challenge.better,7);
  assert.equal(result.challenge.worse,1);
  assert.equal(result.status,'illustration');
  const unchallenged=await verifyPair(fixture({replies:false}).args);
  assert.equal(unchallenged.native.better,8);
  assert.equal(unchallenged.status,'illustration');
});

test('parallel paired verification keeps the serial sample order and the same verdict',async()=>{
 const {args}=fixture({refuted:true}),serial=await verifyPair(args);
 const parallel={...args.forge,mapWorlds:async (worlds,visit)=>Promise.all(worlds.map(async (world,index)=>{
  await new Promise(resolve=>setTimeout(resolve,worlds.length-index));
  return visit(world,index,args.forge);
 }))};
 assert.deepEqual(await verifyPair({...args,forge:parallel}),serial);
});
