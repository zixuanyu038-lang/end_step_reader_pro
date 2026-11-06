'use strict';
const assert=require('node:assert/strict'),{ForgeClient}=require('../forge-client');
(async()=>{
 const client=new ForgeClient();
 try{
  const root={seed:20261106,viewerId:1,names:['Opponent','Player'],gameId:'public-mechanics-fixture',activePlayerId:1,priorityPlayerId:1,firstPriorityId:1,history:[{}, {numDrawnThisTurn:1,numDrawnThisDrawStep:1}],decks:[{main:[{name:'Mountain',count:60}]},{main:[{name:'Mountain',count:59},{name:'Lightning Bolt',count:1}]}],stateText:['turn=3','activeplayer=p1','activephase=MAIN1','p0life=3','p1life=20','p1hand=Lightning Bolt|Id:11','p1battlefield=Mountain|Id:10','p0library='+Array.from({length:60},(_,i)=>'Mountain|Id:'+(100+i)).join(';'),'p1library='+Array.from({length:58},(_,i)=>'Mountain|Id:'+(200+i)).join(';')].join('\n')+'\n'};
  const expanded=await client.request({command:'expand',root});assert.equal(expanded.state.players[1].drawnThisTurn,1);
  const bolt=expanded.actions.find(a=>a.cardName==='Lightning Bolt'&&(a.targets||[]).flat().includes('p:0'));assert.ok(bolt,'Bolt must have a real legal opponent target');
  const result=await client.request({command:'simulate',root,path:[bolt],includeTrace:true,horizonTurns:2});
  assert.equal(result.stopReason,'game_over');assert.equal(result.state.winnerId,'1');assert.equal(result.state.players[0].life,0);assert.equal(result.trace.find(f=>f.action)?.action.manaPaid[0].color,'R');
  console.log('Forge 2.0.15 自检通过：优先权、合法目标、红色费用、结算、终局和抓牌历史。');
 }finally{client.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
