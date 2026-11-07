'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),zlib=require('node:zlib');
const R=require('../replay'),Source=require('../search-source'),{scanMatch,fixDeck,coverGlobalFacts}=require('../match-decks'),{difference,visibleState,paymentText,compileReplay}=require('../forge-replay'),{rankActions,originalSelection}=require('../tree-search');
const {prepareMatchDecks}=require('../match-decks'),{readDeckPreferences}=require('../deck-service');
test('engine projection patches preserve keyed identities through movement, removal and reordering',()=>{
 const a={players:[{id:'0',hand:[{id:1,name:'A'},{id:2,name:'B'}],battlefield:[]}],optional:true};
 const b={players:[{id:'0',hand:[{id:2,name:'B',tapped:false}],battlefield:[{id:1,name:'A'}]}]};
 assert.deepEqual(R.patch(a,difference(a,b)),b);assert.equal(a.players[0].hand.length,2);assert.equal(difference(b,b),null);assert.deepEqual(difference({field:1},{}),{o:{},d:['field']});
});
test('engine export masks hypothetical opposing hand and carries optional renderer fields',async()=>{
 const baseline={gameId:'test',turnNumber:3,status:'ACTIVE',phase:'MAIN1',step:'MAIN1',activePlayerId:'1',priorityPlayerId:'1',stack:[],pendingAction:{type:'choice'},matchScore:{winsBySeat:[0,0],gamesPlayed:0,gamesPerMatch:3},gameType:'Constructed',players:['0','1'].map(id=>({id,name:id,life:20,handSize:1,librarySize:4,poisonCounters:0,hand:[{id:Number(id)+10,name:'Lightning Bolt',types:['Instant'],oracleText:'Private'}],battlefield:[],graveyard:[],exile:[],manaPool:{}}))};
 const last=structuredClone(baseline);last.status='COMPLETE';last.winnerId='1';last.players[0].life=0;
 const source={header:{format:'endstep-replay',formatVersion:1,seat:1,players:[{seat:0,name:'0'},{seat:1,name:'1'}],games:1},rows:[{line:1,row:{k:'header'},raw:'{}'}],baseline,game:1,sha256:'fixture',anchor:{line:2,selectedLine:2,t:0}};
 const world={id:'fixed',root:{seed:1},scenario:{kind:'targeted-interaction-stress'},assumptions:[],hiddenHands:[]};
 const output=compileReplay(source,{stopReason:'game_over',state:last,trace:[{state:baseline,logs:[]},{state:last,logs:[]}]},{world});
 const raw=zlib.gunzipSync(output.bytes).toString('utf8');R.parse(raw);let final=null;for(const r of raw.trim().split('\n').slice(1).map(JSON.parse)){if(r.k==='key')final=r.state;else if(r.k==='diff')final=R.patch(final,r.patch);}
 assert.equal(output.complete,true);assert.equal(final.players[0].hand[0].name,'Hidden card');assert.equal(final.players[0].hand[0].oracleText,'');assert.equal(final.players[1].hand[0].name,'Lightning Bolt');assert.equal(final.gameType,'Constructed');assert.equal(final.pendingAction,null);assert.deepEqual(final.matchScore.winsBySeat,[0,1]);assert.equal(output.header.branchMeta.scenario.kind,'targeted-interaction-stress');
 const fragment=compileReplay(source,{stopReason:'horizon',state:baseline,trace:[{state:baseline,logs:[]}]},{world});assert.equal(fragment.complete,false);assert.equal(fragment.header.result,null);
 assert.equal(visibleState(baseline,1).players[0].hand[0].name,'Hidden card');assert.equal(baseline.players[0].hand[0].name,'Lightning Bolt');
 if(process.env.ENDSTEP_DECODER){const mod=await import(require('node:url').pathToFileURL(process.env.ENDSTEP_DECODER).href),decoded=await (mod.t||mod.n)(output.bytes.buffer.slice(output.bytes.byteOffset,output.bytes.byteOffset+output.bytes.byteLength));assert.equal(decoded.skippedRecords,0);assert.equal(decoded.droppedKeys,0);}
});
test('payment evidence retains exact colored mana and deduplicates last-known sacrificed cards',()=>{
 const text=paymentText({manaPaid:[{sourceName:'Island',color:'U'},{sourceName:'Plateau',color:'R'}],lifeCost:1,paidCards:[{kind:'Sacrificed',cards:[{id:3,name:'Flooded Strand'}]},{kind:'SacrificedLKI',cards:[{id:3,name:'Flooded Strand'}]}]});
 assert.match(text,/Island \{U\}/);assert.match(text,/Plateau \{R\}/);assert.equal(text.match(/牺牲 Flooded Strand/g).length,1);assert.match(text,/1 点生命/);
});
test('match deck scanning keeps the front face and ignores trigger ordering indices',()=>{
 const front={id:90,name:'Tamiyo, Inquisitive Student',zone:'Battlefield'};
 const back={...front,name:'Tamiyo, Seasoned Scholar',isTransformed:true,isBackFace:true,alternateFaceName:front.name};
 const state=(card,options)=>({players:[{id:'1',librarySize:59,battlefield:[card]}],pendingAction:{cardOptions:options}});
 const text=[{k:'header',seat:1},{k:'key',state:state(front,[{...front,id:0,stackKind:'TRIGGERED'}])},{k:'key',state:state(back,[{id:back.id,name:back.name,zone:back.zone}])}].map(row=>JSON.stringify(row)).join('\n');
 assert.deepEqual(scanMatch(text).global[1].cards,[{name:front.name,count:1}]);
});
test('reference deck corrections preserve size and evidence; candidate bounds retain pass and recorded play',()=>{
 const catalog=new Map(['Island','Mountain','Expedition Map'].map(name=>[name,{found:true,land:name!=='Expedition Map'}]));
 const base={main:[{name:'Island',count:58},{name:'Expedition Map',count:1},{name:'Mountain',count:1}],sideboard:[],sha256:'source',verified:true};
 const corrected=coverGlobalFacts(base,[{name:'Expedition Map',count:2}],catalog),fixed=fixDeck(corrected,[{name:'Expedition Map',count:2}],60,catalog);assert.equal(fixed.main.reduce((n,c)=>n+c.count,0),60);assert.equal(fixed.main.find(c=>c.name==='Expedition Map').count,2);assert.equal(base.main.find(c=>c.name==='Expedition Map').count,1);assert.match(fixed.adjustments[0].basis,/inferred/);
 const actions=[{key:'a',actorId:1,kind:'cast',cardId:1,cardName:'A'},{key:'b',actorId:1,kind:'cast',cardId:2,cardName:'B'},{key:'pass',actorId:1,kind:'pass'}];const ranked=rankActions(actions,{players:[]},{observedCardId:2,width:2});assert.ok(ranked.some(a=>a.kind==='pass'));assert.ok(ranked.some(a=>a.cardId===2));
 assert.equal(originalSelection({rows:[{line:5,row:{k:'action',action:{type:'PLAY_CARD',cardId:2}}}],anchor:{line:5},baseline:{stack:[]}},actions).action.cardId,2);
});
test('a hypothetical extra slot respects main and sideboard copy counts',()=>{
 const base={main:[{name:'Wasteland',count:3},{name:'Island',count:57}],sideboard:[{name:'Wasteland',count:1}],sha256:'source'};
 const catalog=new Map([['Island',{type:'Basic Land — Island',land:true}],['Wasteland',{type:'Land',land:true}]]);
 const fixed=fixDeck(base,[{name:'Island',count:2}],61,catalog);
 assert.deepEqual(fixed.main,[{name:'Wasteland',count:3},{name:'Island',count:58}]);
 assert.match(fixed.adjustments[0].basis,/hypothetical slot/);
});
test('widened references use observed extra cards and protect later-game evidence when trimming',()=>{
 const base={main:[{name:'Island',count:55},{name:'Ponder',count:4},{name:'Force of Will',count:1}],sideboard:[],sha256:'source'};
 const catalog=new Map([['Island',{type:'Basic Land — Island',land:true,found:true}],['Ponder',{found:true}],['Force of Will',{found:true}]]);
 const matchObserved=[{name:'Ponder',count:4},{name:'Force of Will',count:4}];
 const expanded=coverGlobalFacts(base,matchObserved,catalog,63);
 assert.equal(expanded.main.find(c=>c.name==='Force of Will').count,4);
 assert.equal(expanded.adjustments.length,3);
 assert.ok(expanded.adjustments.every(c=>c.removed===null&&c.added==='Force of Will'));
 const trimmed=fixDeck(expanded,[{name:'Ponder',count:1}],60,catalog,matchObserved);
 assert.equal(trimmed.main.reduce((n,c)=>n+c.count,0),60);
 assert.equal(trimmed.main.find(c=>c.name==='Ponder').count,4);
 assert.equal(trimmed.main.find(c=>c.name==='Force of Will').count,4);
});
test('match preparation uses uploaded and searched references for their respective seats',async()=>{
 const replay=[{k:'header',seat:1},{k:'key',state:{players:[{id:'0',librarySize:60},{id:'1',librarySize:59,handSize:1,hand:[{id:10,name:'Lightning Bolt',zone:'Hand'}]}]}}].map(row=>JSON.stringify(row)).join('\n');
 const deckPreferences=readDeckPreferences({0:{mode:'local'},1:{mode:'upload',text:'Main Deck\n1 Lightning Bolt\n30 Mountain\n29 Mountain\n\nSideboard\n1 Pyroblast'}});
 const resolved=[];
 const deckService={async resolve(options){resolved.push([options.playerId,options.mode]);return{main:[{name:'Island',count:60}],sideboard:[],sha256:'local',lookup:'local-catalog'};}};
 const forge={async request({names}){return{cards:names.map(name=>({name,found:true}))};}};
 const profile=await prepareMatchDecks({model:{sourceText:replay},deckPreferences,deckService,forge,ask(){assert.fail('One game needs no sideboarding.');}});
 assert.deepEqual(resolved,[['0','local']]);
 assert.deepEqual(profile.byGame[1][1].main,[{name:'Lightning Bolt',count:1},{name:'Mountain',count:59}]);
 assert.equal(profile.byGame[1][1].sourceKind,'uploaded');
 assert.deepEqual(profile.byGame[1][1].adjustments,[]);
});
test('real source preserves turn draw/cast history, known top and global recorded sideboarding',{skip:!process.env.REPLAY_SAMPLE},()=>{
 let raw=fs.readFileSync(process.env.REPLAY_SAMPLE);if(raw[0]===31)raw=zlib.gunzipSync(raw);const text=raw.toString('utf8'),a=Source.sourceAt(text,604),b=Source.sourceAt(text,659);
 assert.equal(a.historyCounters[1].numDrawnThisTurn,1);assert.deepEqual(a.knownTop['1'],[105]);assert.equal(b.historyCounters[1].numDrawnThisTurn,4);assert.deepEqual(b.historyCounters.map(p=>p.spellsCastThisTurn),[1,1]);assert.deepEqual(b.knownTop['1'],[81,115]);
 const match=scanMatch(text);assert.equal(match.recorded.get('1:1').main.reduce((n,c)=>n+c.count,0),60);assert.equal(match.recorded.get('2:1').main.reduce((n,c)=>n+c.count,0),60);assert.ok(!JSON.stringify(match.global).includes('The Monarch'));assert.equal(Source.candidates(text).find(n=>n.anchorLine===604).sourceLine,609);
});
