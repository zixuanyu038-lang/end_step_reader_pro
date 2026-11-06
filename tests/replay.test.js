const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),zlib=require('node:zlib');
const R=require('../replay');
const header={format:'endstep-replay',formatVersion:1,players:[{name:'A',seat:0},{name:'B',seat:1}],seat:1,complete:true};
const row=e=>({k:'event',t:20,event:e});
const parse=rs=>R.parse([header,...rs].map(r=>JSON.stringify(r)).join('\n'));
test('patch supports replacement, deletion, keyed arrays, insertion and reordering without mutating prior states',()=>{
 const before={x:1,players:[{id:'0',hand:[{id:1,name:'first'},{id:2,name:'second'}]},{id:'1',life:20}]};
 const after=R.patch(before,{d:['x'],o:{players:{a:[{id:'1',p:{o:{life:{s:19}}}},{id:'0',p:{o:{hand:{a:[{id:2},{v:{id:3,name:'new'}}]}}}}]}}});
 assert.equal(after.x,undefined);assert.equal(after.players[0].life,19);assert.deepEqual(after.players[1].hand.map(c=>c.id),[2,3]);
 assert.equal(before.players[1].life,20);assert.equal(before.players[0].hand[0].id,1);
 assert.throws(()=>R.patch([],{a:[{id:'missing'}]}),/不存在/);
});
test('zone movement is not assumed to be draw, destruction, or sacrifice',()=>{
 const a=R.describe({type:'CARD_ZONE_CHANGE',fromZone:'Library',toZone:'Hand',playerName:'B'});
 assert.match(a,/牌库 → 手牌/);assert.doesNotMatch(a,/抓/);
 const b=R.describe({type:'CARD_ZONE_CHANGE',fromZone:'Battlefield',toZone:'Graveyard',cardName:'X'});
 assert.doesNotMatch(b,/消灭|牺牲/);
});
test('removed from stack is not labelled countered; triggers and spell resolution remain separate',()=>{
 assert.doesNotMatch(R.describe({type:'SPELL_REMOVED_FROM_STACK',message:'X removed from stack'}),/反击/);
 assert.match(R.describe({type:'SPELL_RESOLVED',cardName:'Ugin',message:'When you cast this spell, exile one target permanent.'}),/触发异能/);
 assert.match(R.describe({type:'SPELL_RESOLVED',cardName:'Force of Will',message:'Force of Will (2) - Counter X (1).'}),/反击 X/);
});
test('personal turns count actual turn-began events, including consecutive extra turns, and reset per game',()=>{
 const m=parse([{k:'chapter',edge:'start',game:1},row({type:'TURN_BEGAN',playerIndex:'0',playerName:'A',turnNumber:1}),row({type:'TURN_BEGAN',playerIndex:'0',playerName:'A',turnNumber:2}),row({type:'TURN_BEGAN',playerIndex:'1',playerName:'B',turnNumber:3}),{k:'chapter',edge:'start',game:2},row({type:'TURN_BEGAN',playerIndex:'1',playerName:'B',turnNumber:1})]);
 assert.deepEqual(m.turns.filter(t=>t.number).map(t=>[t.game,t.personal]),[[1,1],[1,2],[1,1],[2,1]]);
});
test('unknown events preserve text; invalid files fail visibly; broken patches recover at keyframe',()=>{
 assert.equal(parse([row({type:'NEW_EVENT',message:'keep me'})]).turns[0].entries[0].text,'keep me');
 assert.throws(()=>R.parse('not json'),/JSON/);assert.throws(()=>R.parse('{}'),/不是 Endstep/);
 const m=parse([{k:'key',state:{players:[]}},{k:'diff',patch:{o:{players:{a:[{id:'missing'}]}}}},row({type:'NEW_EVENT'}),{k:'key',state:{players:[]}},row({type:'NEW_EVENT'})]);
 assert.equal(m.warnings.length,1);assert.equal(m.turns[0].entries[0].stateIndex,-1);assert.ok(m.turns[0].entries[1].stateIndex>=0);
});
const sample=process.env.REPLAY_SAMPLE;
test('real Endstep file: two games, exact event counts, no missing patch references, hidden hands stay hidden',{skip:!sample},()=>{
 const bytes=fs.readFileSync(sample);const lines=zlib.gunzipSync(bytes).toString('utf8');const m=R.parse(lines);
 assert.equal(m.eventCount,1225);assert.equal(m.actionCount,436);assert.equal(m.states.length,635);assert.deepEqual(m.finalScore,[0,2]);assert.deepEqual(m.warnings,[]);
 assert.equal(m.sourceText,lines);assert.deepEqual(R.parse(m.sourceText).finalScore,[0,2]);
 assert.equal(m.turns.filter(t=>t.number).length,33);assert.equal(m.turns.filter(t=>t.winner).length,2);
 for(const s of m.states)for(const p of s.players)for(const c of p.hand)if(c.hidden)assert.equal(c.name,'未知牌');
 // Each event only refers to a previously received state; no future cards leak into historical hands.
 for(const t of m.turns)for(const e of t.entries)if(e.stateIndex>=0)assert.ok(m.states[e.stateIndex].t<=e.t);
 const cost=m.turns.flatMap(t=>t.entries).find(e=>e.type==='CARD_ZONE_CHANGE'&&e.raw.cardName==='Ponder'&&e.raw.toZone==='Exile');assert.ok(cost&&!cost.quiet);
 const raw=m.turns.flatMap(t=>t.entries).find(e=>e.rawRecord.includes('7637030372947195000'));assert.ok(raw);
 assert.match(R.markdown(m),/全局 T22/);
});
