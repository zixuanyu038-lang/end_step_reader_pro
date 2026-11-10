'use strict';
const assert=require('node:assert/strict'),{ForgeClient}=require('../forge-client');
async function checkForgeRuntime(client){
  const root={seed:20261106,viewerId:1,names:['Opponent','Player'],gameId:'public-mechanics-fixture',activePlayerId:1,priorityPlayerId:1,firstPriorityId:1,history:[{}, {numDrawnThisTurn:1,numDrawnThisDrawStep:1}],decks:[{main:[{name:'Mountain',count:60}]},{main:[{name:'Mountain',count:59},{name:'Lightning Bolt',count:1}]}],stateText:['turn=3','activeplayer=p1','activephase=MAIN1','p0life=3','p1life=20','p1hand=Lightning Bolt|Id:11','p1battlefield=Mountain|Id:10','p0library='+Array.from({length:60},(_,i)=>'Mountain|Id:'+(100+i)).join(';'),'p1library='+Array.from({length:58},(_,i)=>'Mountain|Id:'+(200+i)).join(';')].join('\n')+'\n'};
  const expanded=await client.request({command:'expand',root});assert.equal(expanded.state.players[1].drawnThisTurn,1);
  const bolt=expanded.actions.find(a=>a.cardName==='Lightning Bolt'&&(a.targets||[]).flat().includes('p:0'));assert.ok(bolt,'Bolt must have a real legal opponent target');
  const result=await client.request({command:'simulate',root,path:[bolt],includeTrace:true,horizonTurns:2});
  assert.equal(result.stopReason,'game_over');assert.equal(result.state.winnerId,'1');assert.equal(result.state.players[0].life,0);assert.equal(result.trace.find(f=>f.action)?.action.manaPaid[0].color,'R');
  const probe=await client.request({command:'simulate',root,path:[bolt],searchProbe:true,horizonTurns:2});
  assert.equal(probe.stopReason,result.stopReason);
  assert.deepEqual(probe.state,{status:result.state.status,turnNumber:result.state.turnNumber,winnerId:result.state.winnerId});
  assert.deepEqual(probe.evaluation,result.evaluation);
  assert.deepEqual(probe.executed,result.executed);
  assert.equal(probe.rootLibraries,undefined);
  const acerName='Acererak the Archlich';
  const triggered={...root,stateText:root.stateText.replace('p1hand=Lightning Bolt|Id:11','p0battlefield='+acerName+'|Id:9\np1hand=Swords to Plowshares|Id:11;Consign to Memory|Id:12').replace('p1battlefield=Mountain|Id:10','p1battlefield=Tundra|Id:10;Tundra|Id:13'),stack:[{
    sourceCard:{id:9,name:acerName,controllerId:'0'},sourceCardZone:'Battlefield',isAbility:true,isTrigger:true,abilityDescription:'When Acererak the Archlich enters, if you haven\'t completed Tomb of Annihilation, return it and venture into the dungeon.',targets:[]
  }]};
  const triggerRoot=await client.request({command:'expand',root:triggered});
  assert.equal(triggerRoot.state.stack[0].isTrigger,true);
  const swords=triggerRoot.actions.filter(a=>a.cardName==='Swords to Plowshares');
  assert.ok(swords.every(a=>!a.targets.flat().includes('s:9')),'Swords cannot target a stack ability');
  const exile=swords.find(a=>a.targets.flat().includes('c:9'));assert.ok(exile,'Swords can target Acererak on the battlefield');
  assert.ok(triggerRoot.actions.some(a=>a.cardName==='Consign to Memory'&&a.targets.flat().includes('s:9')),'Consign can target the restored trigger');
  const exileRun=await client.request({command:'simulate',root:triggered,path:[exile],includeTrace:true,horizonTurns:1});
  const exiled=exileRun.trace.find(f=>f.state.players[0].exile.some(c=>c.id===9));
  assert.equal(exiled?.state.stack[0]?.isTrigger,true,'Exiling Acererak leaves its enter trigger on the stack');
  const replacement={...triggered,intent:{goals:[
    {action:'avoid',cardName:'Consign to Memory',scope:'initial_exchange'},
    {action:'cast',cardName:'Swords to Plowshares',targets:[{kind:'card',name:acerName,playerId:'0'}],modes:[]}
  ]}};
  const intentRun=await client.request({command:'simulate',root:replacement,path:[],includeTrace:true,horizonTurns:1});
  assert.equal(intentRun.intentStatus.completed,1);
  assert.ok(!intentRun.trace.some(f=>f.action?.cardName==='Consign to Memory'&&f.state.stack.some(item=>item.isTrigger&&item.sourceCard.id===9)),'The replaced spell stays banned during the original exchange');
}

async function checkRaptorTrigger(client){
  const root={seed:20261106,viewerId:1,names:['Opponent','Player'],gameId:'raptor-regression',
    activePlayerId:1,priorityPlayerId:1,firstPriorityId:1,history:[{},{}],
    decks:[{main:[{name:'Plains',count:60}]},{main:[{name:'Mountain',count:60}]}],
    stateText:[
      'turn=3','activeplayer=p1','activephase=MAIN1','p0life=20','p1life=20',
      'p0hand=Swords to Plowshares|Id:20','p0battlefield=Plains|Id:21',
      'p1hand=Amped Raptor|Id:11','p1battlefield=Mountain|Id:10;Mountain|Id:12',
      'p0library=Plains|Id:30;Plains|Id:31',
      'p1library=Mountain|Id:40;Hill Giant|Id:41;Mountain|Id:42;Mountain|Id:43',
    ].join('\n')+'\n'};
  const initial=await client.request({command:'expand',root});
  const cast=initial.actions.find(a=>a.cardName==='Amped Raptor'&&a.kind==='cast');
  assert.ok(cast,'Amped Raptor must be castable from hand');
  const path=[cast];
  for(let i=0;i<6;i++){
    const node=await client.request({command:'expand',root,path});
    const swords=node.actions.find(a=>a.cardName==='Swords to Plowshares'&&a.targets.flat().includes('c:11'));
    if(swords){path.push(swords);break;}
    const pass=node.actions.find(a=>a.kind==='pass');
    assert.ok(pass,'The engine must expose each priority window');
    path.push(pass);
  }
  assert.equal(path.at(-1).cardName,'Swords to Plowshares');
  const removed=await client.request({command:'simulate',root,path,includeTrace:true,horizonTurns:1});
  const resolved=removed.trace.find(f=>f.state.players[1].exile.some(c=>c.id===11)&&f.state.players[1].exile.some(c=>c.id===41));
  assert.ok(resolved,'Raptor cast from hand still exiles to a nonland if removed before its enter trigger resolves');

  const reanimate={...root,stateText:root.stateText
    .replace('p0hand=Swords to Plowshares|Id:20','p0hand=')
    .replace('p1hand=Amped Raptor|Id:11','p1hand=Unearth|Id:13\np1graveyard=Amped Raptor|Id:11')
    .replace('Mountain|Id:10;Mountain|Id:12','Swamp|Id:10;Mountain|Id:12')};
  const menu=await client.request({command:'expand',root:reanimate});
  const unearth=menu.actions.find(a=>a.cardName==='Unearth'&&a.targets.flat().includes('c:11'));
  assert.ok(unearth,'Unearth must be able to target Raptor in the graveyard');
  const returned=await client.request({command:'simulate',root:reanimate,path:[unearth],includeTrace:true,horizonTurns:1});
  assert.ok(returned.trace.some(f=>f.state.players[1].battlefield.some(c=>c.id===11)&&f.state.players[1].energyCounters===2),
    'Raptor entering without a cast still grants energy');
  assert.ok(returned.trace.every(f=>!f.state.players[1].exile.some(c=>c.id===41)),
    'Raptor entering without a cast does not exile from the library');
}

async function checkEffectChoices(client){
  const first=['Lotus Petal','Atraxa, Grand Unifier','Plains','Island','Mountain'];
  const later=['Lotus Petal',...Array(18).fill('Island')];
  const library=first.concat(later).map((name,i)=>name+'|Id:'+(20+i)).join(';');
  const root={seed:51,viewerId:1,names:['Opponent','Player'],gameId:'stock-up-choice-menu',
    activePlayerId:1,priorityPlayerId:1,firstPriorityId:1,history:[{},{}],
    stateText:['turn=8','activeplayer=p1','activephase=MAIN1','p0life=30','p1life=12',
      'p1hand=Stock Up|Id:11;Emrakul, the Aeons Torn|Id:12',
      'p1battlefield=Sneak Attack|Id:13;Island|Id:14;Island|Id:15;Island|Id:16',
      'p0library=Plains|Id:80;Plains|Id:81','p1library='+library].join('\n')+'\n'};
  const start=await client.request({command:'expand',root});
  const cast=start.actions.find(a=>a.cardName==='Stock Up');
  const path=[cast];let decision;
  for(let i=0;i<4;i++){
    decision=await client.request({command:'expand',root,path,enumerateChoices:true});
    if(decision.actions[0]?.kind==='choice')break;
    const pass=decision.actions.find(a=>a.kind==='pass');assert.ok(pass);path.push(pass);
  }
  assert.equal(decision.actions.length,10,'Stock Up must expose every legal pair');
  const pick=decision.actions.find(a=>a.label.includes('Lotus Petal')&&a.label.includes('Atraxa, Grand Unifier'));
  assert.ok(pick);
  const resumed=await client.request({command:'expand',root,path:path.concat(pick),enumerateChoices:true});
  const hand=resumed.state.players[1].hand.map(c=>c.name);
  assert.ok(hand.includes('Lotus Petal')&&hand.includes('Atraxa, Grand Unifier'),'the chosen effect branch must replay');
}

if(require.main===module){
 const client=new ForgeClient();
 checkForgeRuntime(client).then(()=>checkRaptorTrigger(client)).then(()=>checkEffectChoices(client))
  .then(()=>console.log(client.engine+' 自检通过。'))
  .catch(error=>{console.error(error.message);process.exitCode=1;})
  .finally(()=>client.close());
}
module.exports={checkForgeRuntime};
