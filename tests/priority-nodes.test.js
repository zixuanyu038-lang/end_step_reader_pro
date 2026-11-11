'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const Source=require('../search-source'),Scenario=require('../scenario'),Replay=require('../replay');
const {recoverWindows}=require('../priority-replay');

test('a pass and an opponent window survive snapshots, phase aliases and repeated prompts',()=>{
  const players=[{id:'0',name:'A',hand:[],battlefield:[],life:20,librarySize:60,handSize:0},
    {id:'1',name:'B',hand:[],battlefield:[],life:20,librarySize:60,handSize:0}];
  const state={gameId:'g',status:'ACTIVE',turnNumber:'6',phase:'MAIN1',step:'MAIN1',players,stack:[],
    activePlayerId:'0',priorityPlayerId:'0',priorityPromptVersion:4,pendingAction:{type:'PRIORITY',promptVersion:4}};
  const text=[
    {format:'endstep-replay',formatVersion:1,seat:0,complete:true,players:[{seat:0,name:'A'},{seat:1,name:'B'}]},
    {k:'key',t:0,state},
    {k:'chapter',edge:'start',game:1,t:1},
    {k:'event',t:2,event:{type:'TURN_BEGAN',turnNumber:6,playerIndex:'0',playerName:'A'}},
    {k:'diff',t:3,patch:{o:{sequenceNumber:{s:50}}}},
    {k:'action',t:4,action:{type:'PASS_PRIORITY',promptVersion:4}},
    {k:'diff',t:5,patch:{o:{priorityPlayerId:{s:'1'},priorityPromptVersion:{s:5},pendingAction:{s:null}}}},
    {k:'diff',t:6,patch:{o:{sequenceNumber:{s:51}}}},
    {k:'diff',t:7,patch:{o:{phase:{s:'COMBAT'},step:{s:'COMBAT_BEGIN'},priorityPlayerId:{s:'0'},
      priorityPromptVersion:{s:6},pendingAction:{s:{type:'PRIORITY',promptVersion:6}}}}},
    {k:'action',t:8,action:{type:'PASS_PRIORITY',promptVersion:6}}
  ].map(x=>JSON.stringify(x)).join('\n');
  const nodes=Source.priorityCandidates(text);
  assert.deepEqual(nodes.map(n=>[n.sourceLine,n.kind,n.phase,n.priorityPlayerId]),
    [[6,'pass','MAIN1','0'],[7,'priority','MAIN1','1'],[10,'pass','BEGIN_COMBAT','0']]);
  const root=Scenario.sourceAt(text,7);
  assert.equal(root.baseline.priorityPlayerId,'1');
  assert.equal(root.anchor.line,8);
  assert.throws(()=>Scenario.sourceAt(text,8),/优先权/);
  assert.equal(Replay.parse(text,'priority.esreplay').turns.find(t=>t.number===6).entries.filter(e=>e.type==='PASS_PRIORITY').length,2);
});

test('a missing main phase keeps both legal decisions and compresses forced passes',()=>{
  const players=[0,1].map(id=>({id:String(id),life:20,hand:[],handSize:0,librarySize:50,battlefield:[]}));
  const state=(phase,actor)=>({status:'ACTIVE',turnNumber:6,phase,step:phase,activePlayerId:'0',
    priorityPlayerId:String(actor),players,stack:[]});
  const window=(phase,actor,hasAlternatives=false)=>({state:state(phase,actor),hasAlternatives,
    advance:{kind:'pass',key:'pass:'+actor,actorId:actor}});
  const from={baseline:state('DRAW',0)},to={baseline:state('BEGIN_COMBAT',0)};
  const windows=[window('DRAW',0),window('DRAW',1),window('MAIN1',0,true),
    window('MAIN1',1,true),window('BEGIN_COMBAT',0)];
  const phases=new Set(['6:DRAW','6:BEGIN_COMBAT']);
  const result=recoverWindows(windows,from,to,'0',phases);
  assert.deepEqual(result.recovered.map(r=>[r.kind,r.phase,r.priorityPlayerId,r.prefix?.map(a=>a.key)]),[
    ['phase','MAIN1',undefined,undefined],['recovered','MAIN1','0',['pass:0','pass:1']],
    ['recovered','MAIN1','1',['pass:0','pass:1','pass:0']]
  ]);
  assert.equal(recoverWindows(windows,from,{baseline:{...to.baseline,players:[{...players[0],life:19},players[1]]}},'0',phases),null);
});
