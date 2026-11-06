const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),zlib=require('node:zlib');
const B=require('../branch'),E=require('../engine'),R=require('../replay');
// Synthetic fixture: the public test suite must not depend on a private replay.
const card=(id,name,zone,types,extra={})=>({id,name,zone,types,ownerId:'1',controllerId:'1',tapped:false,faceDown:false,isToken:false,power:0,toughness:0,damage:0,counters:{},subtypes:[],attachedCards:[],keywords:[],manaCost:'',...extra});
const state={gameId:'test-game',status:'ACTIVE',phase:'DRAW',step:'DRAW',turnNumber:'10',activePlayerId:'1',priorityPlayerId:'1',stack:[],sequenceNumber:10,matchScore:{gameNumber:1,winsBySeat:[0,0],isMatchOver:false},players:[{id:'0',name:'Opponent',life:17,handSize:0,librarySize:50,hand:[],battlefield:[],graveyard:[],exile:[],manaPool:{}},{id:'1',name:'Player',life:18,handSize:5,librarySize:45,manaPool:{},hand:[card(112,'Swords to Plowshares','Hand',['Instant'],{manaCost:'{W}'}),card(93,'Flame of Anor','Hand',['Instant'],{manaCost:'{1}{U}{R}',cmc:3}),card(115,'Swords to Plowshares','Hand',['Instant'],{manaCost:'{W}'}),card(83,'Brainstorm','Hand',['Instant'],{manaCost:'{U}',cmc:1}),card(96,'Tamiyo, Inquisitive Student','Hand',['Creature'],{manaCost:'{U}',cmc:1,power:0,toughness:3,subtypes:['Moonfolk','Wizard']})],battlefield:[card(116,'Plateau','Battlefield',['Land'],{subtypes:['Mountain','Plains']}),card(103,'Island','Battlefield',['Land'],{subtypes:['Island'],supertypes:['Basic']}),card(128,'Plains','Battlefield',['Land'],{subtypes:['Plains'],supertypes:['Basic']}),card(78,'Flooded Strand','Battlefield',['Land'])],graveyard:[],exile:[]}]};
const earlier=JSON.parse(JSON.stringify(state));earlier.pendingAction={type:'CHOOSE_TARGETS',cardOptions:[card(106,'Volcanic Island','Library',['Land'],{subtypes:['Island','Mountain']})]};
const text=[{format:'endstep-replay',formatVersion:1,recordedAt:'2026-11-06T02:48:34.801Z',seat:1,players:[{name:'Opponent',seat:0},{name:'Player',seat:1}],games:1,complete:false},{k:'key',t:0,state:earlier},{k:'chapter',t:1,game:1,edge:'start'},{k:'key',t:10,state},{k:'action',t:20,action:{type:'PLAY_CARD',cardId:83}},{k:'event',t:30,event:{type:'SPELL_CAST',message:'Opponent cast Disruptor Flute',cardName:'Disruptor Flute',playerIndex:'0'}}].map(JSON.stringify).join('\n')+'\n';
const anchor=B.decisions(text).find(d=>d.turn===10&&d.game===1&&d.action.cardId===83&&d.action.type==='PLAY_CARD');
async function plan(){return {...(await B.handoff(R.parse(text),anchor.line)).responseTemplate,title:'接口回归验证',summary:'先下Tamiyo, Inquisitive Student，不编造未知后续。',assumptions:['演示中假设对手不响应。'],steps:[{action:{type:'advance_main'},label:'主阶段',explanation:'等待主阶段。'},{action:{type:'cast',cardId:96,payment:[{landId:103,color:'U'}]},label:'Tamiyo, Inquisitive Student',explanation:'支付一蓝。'},{action:{type:'resolve_top'},label:'结算',explanation:'Tamiyo, Inquisitive Student进入战场。'}]};}
test('handoff pins the original exact source and pre-action state; no hidden cards become known',async()=>{
 const h=await B.handoff(R.parse(text),anchor.line);assert.equal(h.source.originalJsonl,text);assert.equal(h.baseline.phase,'DRAW');assert.ok(h.baseline.players[1].hand.some(c=>c.id===96));assert.equal(h.capabilities.provider,'local-supported-v1');assert.match(h.instructions,/禁止输出 patch/);
});
test('deterministic actions change the battlefield and preserve the exact original prefix, without future suffix',async()=>{
 const p=await plan(),x=await B.compile(text,p),y=await B.compile(text,p);assert.equal(x.jsonl,y.jsonl);assert.equal(x.stepCount,3);
 const s=x.frames[2].state;assert.ok(s.players[1].battlefield.some(c=>c.id===96&&c.hasSummoningSickness));assert.ok(s.players[1].battlefield.find(c=>c.id===103).tapped);assert.equal(s.players[1].hand.length,s.players[1].handSize);assert.ok(!s.players[1].hand.some(c=>c.id===96));assert.equal(s.stack.length,0);
 const source=text.trim().split('\n'),out=x.jsonl.trim().split('\n');assert.deepEqual(out.slice(1,anchor.line-1),source.slice(1,anchor.line-1));assert.ok(!x.jsonl.includes('Opponent cast Disruptor Flute'));assert.equal(x.header.complete,false);assert.equal(x.header.result,null);assert.equal(R.parse(x.jsonl).turns.at(-1).entries.some(e=>!e.quiet&&e.text.startsWith('[CODEX')),true);
});
test('mismatched source, arbitrary patches, missing payments, bad timing and double spending are rejected',async()=>{
 let p=await plan();p.source.sha256='0'.repeat(64);await assert.rejects(()=>B.compile(text,p),/不一致/);
 p=await plan();p.steps[0].patch={o:{players:{s:[]}}};await assert.rejects(()=>B.compile(text,p),/未定义/);
 p=await plan();p.steps.shift();await assert.rejects(()=>B.compile(text,p),/主阶段/);
 p=await plan();p.steps[1].action.payment=[{landId:116,color:'U'}];await assert.rejects(()=>B.compile(text,p),/不能产生/);
 p=await plan();p.steps.push({action:{type:'cast',cardId:83,payment:[{landId:103,color:'U'}]},label:'重复用地',explanation:'必须失败。'});await assert.rejects(()=>B.compile(text,p),/不能横置/);
});
test('unknown draws force a transactional stop even when assumptions exist',async()=>{
 const p=await plan();p.steps.push({action:{type:'activate_fetch',cardId:78},label:'找地',explanation:'牺牲找地。'},{action:{type:'resolve_fetch',landId:106},label:'找蓝源',explanation:'寻找双地并洗牌。'},{action:{type:'cast',cardId:83,payment:[{landId:106,color:'U'}]},label:'Brainstorm',explanation:'使用新蓝源。'},{action:{type:'resolve_top'},label:'未知抽牌',explanation:'应在结算前停止。'});
 const x=await B.compile(text,p);assert.equal(x.stepCount,6);assert.equal(x.stopped.code,'unknown_outcome');const s=x.frames.at(-1).state;assert.equal(s.stack[0].sourceCard.name,'Brainstorm');assert.equal(s.players[1].life,17);assert.ok(!s.players[1].hand.some(c=>c.id===83));assert.ok(!s.players[1].battlefield.some(c=>c.id===78));assert.ok(s.players[1].graveyard.some(c=>c.id===78));
});
test('missing assumptions halt before inventing opponent passes; invalid interface commands fail',async()=>{
 const p=await plan();p.assumptions=[];await assert.rejects(()=>B.compile(text,p),/假设/);p.assumptions=['对手不响应'];p.steps[0].action.type='make_me_win';await assert.rejects(()=>B.compile(text,p),/接口定义/);
});
test('known flute lock prevents fetch activation without mutating input',()=>{
 const b=B.baseline(text,anchor.line),s=JSON.parse(JSON.stringify(b.state));s.players[0].battlefield.push({id:900,name:'Disruptor Flute',types:['Artifact'],zone:'Battlefield',chosenMarks:[{kind:'NAME',value:'Flooded Strand'}]});const original=JSON.stringify(s);assert.throws(()=>E.apply(s,{type:'activate_fetch',cardId:78},{seat:'1',casts:{},landsPlayed:0,assumed:true,knownCards:{}}),/禁止/);assert.equal(JSON.stringify(s),original);
});
const decoder=process.env.ENDSTEP_DECODER;
test('generated gzip is accepted by the cached official Endstep decoder',{skip:!decoder},async()=>{
 const mod=await import(require('node:url').pathToFileURL(decoder).href);const result=await B.compile(text,await plan()),bytes=zlib.gzipSync(Buffer.from(result.jsonl));const decoded=await (mod.t||mod.n)(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));assert.ok(decoded.records.some(r=>r.k==='event'&&r.event.message?.startsWith('[CODEX')));assert.equal(decoded.skippedRecords,0);assert.ok(decoded.records.filter(r=>r.k==='key').at(-1).state.players[1].battlefield.some(c=>c.id===96));
});
test('cost modifiers, instant/sorcery timing, and arbitrary command fields are enforced',async()=>{
 const p=await plan();p.steps[1].action.unvalidatedState={life:999};await assert.rejects(()=>B.compile(text,p),/接口定义/);
 const base=JSON.parse(JSON.stringify(state)),ctx={seat:'1',casts:{},landsPlayed:0,assumed:true,knownCards:{}};base.phase='MAIN1';base.step='MAIN1';base.players[0].battlefield.push(card(900,'Trinisphere','Battlefield',['Artifact']));
 assert.throws(()=>E.apply(base,{type:'cast',cardId:96,payment:[{landId:103,color:'U'}]},ctx),/不足/);
 const paid=E.apply(base,{type:'cast',cardId:96,payment:[{landId:103,color:'U'},{landId:116,color:'W'},{landId:128,color:'W'}]},ctx);assert.equal(paid.state.players[1].battlefield.filter(c=>c.tapped).length,3);
});
test('real replay branch compiles at the intended Brainstorm fork',{skip:!process.env.REPLAY_SAMPLE},async()=>{
 const raw=zlib.gunzipSync(fs.readFileSync(process.env.REPLAY_SAMPLE)).toString('utf8');const a=B.decisions(raw).find(d=>d.game===1&&d.turn===10&&d.action.cardId===83);const h=await B.handoff(R.parse(raw),a.line);const p=await plan();p.source=h.responseTemplate.source;const x=await B.compile(raw,p);assert.equal(x.stepCount,3);assert.ok(x.frames[2].state.players[1].battlefield.some(c=>c.id===96));
});
