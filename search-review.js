'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const Source=require('./search-source'),S=require('./studio-schema'),Schema=require('./search-schema'),Protocol=require('./search-protocol'),LegacyProtocol=require('./studio-protocol');
const {buildWorld}=require('./hidden-worlds'),{search,inspectSearchWorlds}=require('./tree-search');
const {prepareMatchDecks}=require('./match-decks');
const {routeFromTrace,compileReplay}=require('./forge-replay');
const {gameOutcomes,findTurningPoints}=require('./turning-points');
const {publicVerification}=require('./paired-review');
const {baseEngine}=require('./forge-runtime');
const REVIEW_VERSION='forge-search-v6-engine-evidence';
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const packProfile=profile=>({...profile,catalog:[...profile.catalog]});
const publicDeckProfile=profile=>profile?{byGame:profile.byGame,sideboardPlans:profile.sideboardPlans,scope:profile.scope,manualSideboard:profile.manualSideboard||[]}:null;
async function ensureMatchDecks({replay,profileDir,deckService,forge,ask,signal,onProgress,deckPreferences,manualSideboard}){
  if(deckPreferences||manualSideboard){
    const preferencesKey=digest(JSON.stringify({deckPreferences,manualSideboard:manualSideboard||[]}));
    if(replay.matchDecks?.preferencesKey===preferencesKey)return replay.matchDecks;
    const profile=await prepareMatchDecks({model:replay.model,deckService,forge,ask,signal,onProgress,deckPreferences,manualSideboard});
    return {...profile,preferencesKey};
  }
  if(replay.matchDecks)return replay.matchDecks;
  const filename=path.join(profileDir,replay.id+'.json');
  try{const cached=JSON.parse(await fs.readFile(filename,'utf8'));if(cached.version===3&&cached.replayId===replay.id){replay.matchDecks={...cached.profile,catalog:new Map(cached.profile.catalog)};return replay.matchDecks;}}catch{}
  const profile=await prepareMatchDecks({model:replay.model,deckService,forge,ask,signal,onProgress});
  await fs.mkdir(profileDir,{recursive:true});await fs.writeFile(filename,JSON.stringify({version:3,replayId:replay.id,profile:{...profile,catalog:[...profile.catalog]}},null,2));replay.matchDecks=profile;return profile;
}
async function prepareOnly({job,replay,profileDir,deckService,forge,ask,progress}){
  progress(job,'decks','正在固定双方牌表与换备方案…');
  const previous=replay.matchDecks;
  const profile=await ensureMatchDecks({replay,profileDir,deckService,forge,deckPreferences:job.deckPreferences,manualSideboard:job.manualSideboard,signal:job.abort.signal,
    ask:(prompt,schema,options)=>ask(job,prompt,schema,options),onProgress:message=>progress(job,'decks',message)});
  const deckProfiles=publicDeckProfile(profile);
  if(profile===previous)return {deckProfiles,review:replay.review,evidence:replay.searchEvidence};
  await fs.mkdir(profileDir,{recursive:true});
  const preparedAt=new Date().toISOString(),file=path.join(profileDir,replay.id+'.json'),temporary=file+'.'+job.id+'.tmp';
  try{
    await fs.writeFile(temporary,JSON.stringify({version:3,replayId:replay.id,preparedAt,profile:packProfile(profile)},null,2));
    job.abort.signal.throwIfAborted();
    await fs.rename(temporary,file);
  }finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
  replay.matchDecks=profile;
  replay.review=null;
  replay.searchEvidence=[];
  return {deckProfiles,preparedAt,review:null,evidence:[]};
}
async function shortlistOnly({job,replay,ask,progress}){
  progress(job,'screen','正在让 AI 标出值得检查的节点…');
  const all=Source.candidates(replay.model.sourceText),selection=await ask(job,Protocol.shortlistPrompt(replay.model,all,job.intent),Schema.shortlist);
  S.validate(selection,Schema.shortlist);
  const byLine=new Map(all.map(node=>[node.sourceLine,node]));
  const seen=new Set(),nodes=[];
  for(const proposed of selection.nodes){
    const candidate=byLine.get(proposed.sourceLine);
    if(!candidate||seen.has(candidate.sourceLine))continue;
    seen.add(candidate.sourceLine);
    nodes.push({sourceLine:candidate.sourceLine,game:candidate.game,turn:candidate.turn,cardName:candidate.cardName,t:candidate.t,question:proposed.question,reason:proposed.reason});
  }
  job.abort.signal.throwIfAborted();
  replay.initialSelection=selection;
  return {shortlist:{summary:selection.summary,nodes}};
}
function buildWorlds(source,prepared,count=3,stressCards=[]){
  if(stressCards.length)return [buildWorld(source,prepared.decks,prepared.catalog,seeds(source,1)[0],{stressCards})];
  const opponent=1-Number(source.header.seat),interaction=prepared.decks[opponent].main.find(c=>c.name==='Disruptor Flute')?.name||prepared.decks[opponent].main.find(c=>/Force of Will|Force of Negation|Daze|Counterspell/.test(c.name))?.name||null;
  return seeds(source,count).map((seed,i)=>buildWorld(source,prepared.decks,prepared.catalog,seed,{stressCard:i===count-1?interaction:null}));
}
async function prepareNode({source,deckService,forge,ask,signal,onProgress}){
  const decks=[];
  for(const player of source.baseline.players)decks.push(await deckService.resolve({source,playerId:player.id,ask,signal,onProgress}));
  const names=[...new Set(decks.flatMap(d=>d.main.concat(d.sideboard)).map(c=>c.name.split(' // ')[0]).concat(source.known.map(c=>source.faces[String(c.id)]||c.name.split(' // ')[0])))];
  const metadata=await forge.request({command:'catalog',names},{signal}),catalog=new Map(metadata.cards.map(c=>[c.name,c]));
  const missing=metadata.cards.filter(c=>!c.found);if(missing.length)throw Error('Forge 数据库缺少牌面：'+missing.map(c=>c.name).join('；'));
  return{decks,catalog};
}
function seeds(source,count=3){
  const prefix=source.rows.filter(x=>x.line<source.anchor.line).map(x=>x.raw).join('\n');
  const base=parseInt(digest(prefix).slice(0,8),16);return Array.from({length:count},(_,i)=>(base+Math.imul(i+1,2654435761))>>>0);
}
function buildHoldout(source,prepared,discovery,count){
  const seen=new Set(discovery.map(w=>w.root.stateText));
  const base=digest('paired-holdout-v1:'+seeds(source,1)[0]);
  const worlds=[];
  for(let i=0;i<count*2&&worlds.length<count;i++){
    const seed=parseInt(digest(base+':'+i).slice(0,8),16);
    if(discovery.some(w=>w.root.seed===seed))continue;
    const world=buildWorld(source,prepared.decks,prepared.catalog,seed);
    if(seen.has(world.root.stateText))continue;
    seen.add(world.root.stateText);
    worlds.push(world);
  }
  return worlds;
}
function recordedChoiceSource(source,choice){
  if(!choice||choice.name!=='Stock Up')return source;
  const id=String(source.header.seat),top=choice.options.map(c=>c.id);
  if((source.knownTop[id]||[]).some((card,i)=>i<top.length&&String(card)!==String(top[i])))throw Error('Stock Up 的五张牌与节点已知库顶不一致。');
  const known=new Map(source.known.map(c=>[String(c.id),c]));
  for(const c of choice.options)known.set(String(c.id),{...c,ownerId:id,controllerId:id,zone:'Library'});
  return {...source,known:[...known.values()],knownTop:{...source.knownTop,[id]:top.concat((source.knownTop[id]||[]).slice(top.length))}};
}
function compactEvidence(record){
  const r=record.result;return{sourceLine:record.node.sourceLine,game:record.source.game,question:record.node.question,engine:r.engine,algorithm:r.algorithm,simulated:r.simulated,reusedSimulations:r.reusedSimulations||0,searchElapsedMs:r.elapsedMs??null,settings:r.settings,quality:r.quality||null,winningCandidates:r.winningCandidates?.length||0,
    best:r.best,original:r.original,comparison:r.comparison,alternatives:r.alternatives,sourceUrls:[...new Set(record.worlds.flatMap(w=>w.sourceUrls))],worlds:record.worlds.map(w=>({id:w.id,seed:w.root.seed,scenario:w.scenario,hiddenHands:w.hiddenHands,assumptions:w.assumptions})),
    representativePath:r.representative.path,turningTest:r.turningTest||null,pairedVerification:publicVerification(r.pairedVerification),limitations:r.limitations,artifact:'node-'+record.node.sourceLine+'.json',downloadUrl:record.replayArtifact?.downloadUrl||null,replaySha256:record.replayArtifact?.sha256||null};
}
async function writeWinningReplays(records,job){
  for(const record of records){if(!record.result.quality?.keep)continue;
    const {source,result,worlds,node}=record,world=record.turningWorld||worlds.find(w=>w.id===result.representative.worldId);
    const replay=compileReplay(record.turningSource||source,result.representative,{title:`第 ${source.game} 局 T${source.anchor.turn} · ${result.turningTest?.key?.direction||'搜索保留路线'}`,summary:result.quality.reason,world,evidence:result,quality:result.quality,intent:world.root.intent||null});
    await fs.writeFile(path.join(job.dir,'search','node-'+node.sourceLine+'.esreplay'),replay.bytes);
    record.replayArtifact={downloadUrl:'/api/jobs/'+job.id+'/nodes/'+node.sourceLine+'/replay',sha256:replay.sha256};
  }
}
async function runForgeReview({job,replay,ask,progress,forge,deckService,cacheDir,budget={},nodeLimit=8}){
  const model=replay.model,outcomes=gameOutcomes(model),all=Source.candidates(model.sourceText),directory=path.join(job.dir,'search');await fs.mkdir(directory,{recursive:true});
  progress(job,'decks','正在读取整盘公开信息，固定双方牌表并分析换备…');
  const matchDecks=await ensureMatchDecks({replay,profileDir:path.join(path.dirname(cacheDir),'deck-profiles'),deckService,forge,deckPreferences:job.deckPreferences,manualSideboard:job.manualSideboard,signal:job.abort.signal,ask:(prompt,schema,options)=>ask(job,prompt,schema,options),onProgress:message=>progress(job,'decks',message)});
  const storedDecks=packProfile(matchDecks);
  await fs.writeFile(path.join(directory,'match-decks.json'),JSON.stringify(storedDecks,null,2));
  const {aiShortlist=true,searchMode='standard'}=job.reviewOptions||{};
  const deep=searchMode==='deep';
  if(deep){nodeLimit=all.length;budget={...budget,iterations:120,width:12,maxDepth:16};}
  else if(forge.parallelism===3)budget={iterations:48,...budget};
  let proposedNodes=[];
  if(aiShortlist||job.intent){
    progress(job,'screen','正在通读对局，筛选需要搜索的关键节点…');
    const selected=(!job.intent&&replay.initialSelection)||await ask(job,Protocol.shortlistPrompt(model,all,job.intent),Schema.shortlist);
    S.validate(selected,Schema.shortlist);
    proposedNodes=selected.nodes;
  }else progress(job,'screen','已跳过 AI 初筛，正在按局排列公开记录中的候选节点…');
  const index=new Map(all.map(n=>[n.sourceLine,n])),shortlisted=[];
  for(const proposed of proposedNodes)if(index.has(proposed.sourceLine)&&!shortlisted.some(n=>n.sourceLine===proposed.sourceLine))shortlisted.push({...index.get(proposed.sourceLine),...proposed,priority:Math.max(1,Math.min(100,proposed.priority))});
  for(const node of all)if(!shortlisted.some(n=>n.sourceLine===node.sourceLine))shortlisted.push({...node,priority:aiShortlist&&/Flame of Anor/.test(node.cardName)?70:aiShortlist&&/Brainstorm|Tamiyo|Force of/.test(node.cardName)?35:10,question:'比较 '+node.cardName+' 的时机与资源安排',alternatives:[],reason:aiShortlist?'候补研究节点':'原局操作'});
  const games=[...new Set(model.turns.map(turn=>turn.game))];
  const queue=[];
  // Establish coverage of every recorded game before filling the remaining research budget.
  for(const game of games)for(const node of shortlisted.filter(n=>n.game===game).sort((a,b)=>b.priority-a.priority).slice(0,2))queue.push(node);
  for(const node of shortlisted.slice().sort((a,b)=>b.priority-a.priority))if(!queue.some(n=>n.sourceLine===node.sourceLine))queue.push(node);
  for(const node of queue)node.outcome=outcomes[node.game]||null;
  const records=[],unsupported=[],searchFailures=[],evidence=[];
  const partial={summary:'败局找救法，胜局找会输的走法。',overallPlan:'正在对照双方打法，找出真正改变胜负的节点。',games:games.map(game=>({game,summary:'搜索进行中。',findings:[]})),hiddenHands:[],takeaways:[]};
  job.result={review:partial,reviewPending:true,reviewRevision:0,evidence,gameStages:games.map(game=>({game,message:'等待搜索'}))};
  for(const node of queue){
    if(records.length>=nodeLimit)break;if(job.abort.signal.aborted)throw Error('任务已取消。');
    progress(job,'restore',`正在校验第 ${node.game} 局 T${node.turn} · ${node.cardName} 的起点…`);
    let source,prepared,worlds,checkedWorlds;
    try{
      source=Source.sourceAt(model.sourceText,node.sourceLine);
      prepared={decks:matchDecks.byGame[source.game],catalog:matchDecks.catalog};
      worlds=buildWorlds(source,prepared,3);
      checkedWorlds=await inspectSearchWorlds({client:forge,source,worlds,signal:job.abort.signal});
    }catch(error){
      if(job.abort.signal.aborted)throw error;
      unsupported.push({sourceLine:node.sourceLine,game:node.game,cardName:node.cardName,reason:error.message});
      await fs.writeFile(path.join(directory,'unsupported.json'),JSON.stringify(unsupported,null,2));
      progress(job,'restore',`已跳过 ${unsupported.length} 个不可恢复节点，继续检查后续节点。`);
      continue;
    }
    try{
      let last=0;
      const result=await search({client:forge,source,worlds,checkedWorlds,signal:job.abort.signal,budget,onProgress:p=>{
        if(Date.now()-last>1200||p.completedIterations===p.totalIterations){last=Date.now();progress(job,'search',`第 ${node.game} 局 T${node.turn} · ${p.worlds} 个隐藏世界 · 搜索 ${p.completedIterations}/${p.totalIterations} · ${p.simulated} 次模拟${p.reusedSimulations?'（复用 '+p.reusedSimulations+' 次）':''}`);}
      }});
      const record={source,result,worlds,node,checkedWorlds,focus:job.intent||'',buildHoldout:()=>buildHoldout(source,prepared,worlds,deep?12:8)};
      if(node.choice)try{
        const choiceSource=recordedChoiceSource(source,node.choice);
        const choiceWorlds=choiceSource===source?worlds:buildWorlds(choiceSource,prepared,3);
        record.choiceSource=choiceSource;record.choiceWorlds=()=>choiceWorlds;
        record.choiceHoldout=()=>buildHoldout(choiceSource,prepared,choiceWorlds,deep?12:8);
      }catch(error){result.choiceError=error.message;}
      if(node.earlierLine&&node.choice)try{
        const timingSource=Source.sourceAt(model.sourceText,node.earlierLine),timingWorlds=buildWorlds(timingSource,prepared,3);
        record.timingSource=timingSource;record.timingWorlds=()=>timingWorlds;
        record.timingHoldout=()=>buildHoldout(timingSource,prepared,timingWorlds,deep?12:8);
      }catch(error){result.timingError=error.message;}records.push(record);evidence.push(compactEvidence(record));
      await fs.writeFile(path.join(directory,'node-'+node.sourceLine+'.json'),JSON.stringify({node,worlds,result},null,2));
      job.result.reviewRevision++;job.result.gameStages=games.map(game=>({game,message:`已搜索 ${records.filter(r=>r.source.game===game).length} 个节点`}));
      progress(job,'search',`已完成 ${records.length}/${nodeLimit} 个关键节点，继续比较其余节点…`);
    }catch(error){
      if(job.abort.signal.aborted)throw error;
      searchFailures.push({sourceLine:node.sourceLine,game:node.game,cardName:node.cardName,reason:error.message});
      await fs.writeFile(path.join(directory,'search-failures.json'),JSON.stringify(searchFailures,null,2));
      progress(job,'limited',`${node.cardName} 的可恢复节点未完成路线比较，继续搜索后续节点。`);
    }
  }
  if(!records.length&&searchFailures.length)throw Error('可恢复节点未能完成路线比较。'+searchFailures[0].reason);
  const batchSize=deep?4:Math.max(1,records.length);
  for(let offset=0;offset<records.length;offset+=batchSize){
    await findTurningPoints({records:records.slice(offset,offset+batchSize),forge,deep,signal:job.abort.signal,
      ask:(prompt,schema)=>ask(job,prompt,schema),onProgress:message=>progress(job,'quality',message)});
  }
  await writeWinningReplays(records,job);
  evidence.splice(0,evidence.length,...records.map(compactEvidence));
  for(const record of records)await fs.writeFile(path.join(directory,'node-'+record.node.sourceLine+'.json'),JSON.stringify({node:record.node,worlds:record.worlds,result:record.result},null,2));
  progress(job,'explain','AI 正在解释哪一步改变了胜负，以及下次怎么打。');
  const explainRecords=games.flatMap(game=>records.filter(r=>r.source.game===game&&(r.result.turningTest?.key||r.result.turningTest?.learning))
    .sort((a,b)=>
      (b.result.turningTest.key?.holdout.flips||0)-(a.result.turningTest.key?.holdout.flips||0)||
      (b.result.turningTest.key?.discovery.flips||0)-(a.result.turningTest.key?.discovery.flips||0)||a.source.anchor.turn-b.source.anchor.turn)
    .slice(0,3));
  const gaps=unsupported.concat(searchFailures);
  const prompt=Protocol.reviewPrompt(model,explainRecords,deep?gaps.slice(0,20):gaps);
  function emptyGame(game){
    const searched=records.filter(r=>r.source.game===game);
    return !outcomes[game]?'这局没有可确认的原始胜负。':!searched.length?'这局没有搜到可核对的起点。':
      searched.some(r=>r.result.turningTest?.comparableWorlds)?'这局试了 '+searched.length+' 个节点，没找到能改变胜负的打法。':
      '这局检查了 '+searched.length+' 个节点，未能复现可比较的原打法和终局。';
  }
  let review=explainRecords.length?await ask(job,prompt,S.review):{...partial,summary:'这轮没有找到已验证的胜负转折。',
    overallPlan:'搜索记录保留了试过的节点和结果。',games:games.map(game=>({game,summary:emptyGame(game),findings:[]})),takeaways:['本轮没有可演示的翻盘或失守路线。']};S.validate(review,S.review);
  const byLine=new Map(explainRecords.map(r=>[r.node.sourceLine,r]));
  function ground(candidate){
  for(const game of candidate.games){
    const expected=explainRecords.filter(r=>r.source.game===game.game);
    if(!expected.length){game.summary=emptyGame(game.game);game.findings=[];continue;}
    const got=game.findings.map(f=>f.sourceLine);
    if(got.length!==expected.length||expected.some(r=>!got.includes(r.node.sourceLine)))throw Error('解释必须覆盖每个已选出的胜负转折。');
    for(const finding of game.findings){
      const record=byLine.get(finding.sourceLine);
      if(!record||record.source.game!==game.game)throw Object.assign(Error('复盘引用了未经验证的节点。'),{sourceLines:[finding.sourceLine]});
      const key=record.result.turningTest.key;
      finding.confidence=key?.holdout.flips>=2&&key.holdout.reverse===0?'medium':'low';
      finding.severity=key?.direction==='胜 → 负'&&key.kind==='own'?'good':'alternative';      const battlefield=record.source.baseline.players.flatMap(player=>player.battlefield);
      finding.manaAudit.availableSources=finding.manaAudit.availableSources.filter(mana=>
        battlefield.some(card=>card.id===mana.cardId&&card.name===mana.name&&!!card.tapped===mana.tapped));
      const tested=key?routeFromTrace(record.result.representative):record.result.turningTest.learning.route;
      if(tested.length){finding.proposedLine=tested;finding.manaAudit.paymentPlan=tested.map(s=>(s.cardName||'Pass priority')+'：'+s.payment);}
    }
  }
  candidate.hiddenHands=candidate.hiddenHands.filter(hand=>byLine.has(hand.sourceLine));
  for(const hand of candidate.hiddenHands)hand.confidence='low';
  return LegacyProtocol.validateReview(candidate,model);
  }
  for(let attempt=0;attempt<3;attempt++)try{review=ground(review);break;}catch(error){
    await fs.writeFile(path.join(directory,'review-validation-'+attempt+'.json'),JSON.stringify({review,error:error.message},null,2));
    if(attempt===2)throw error;
    progress(job,'repair','正在修正复盘中的资源或引用错误，保留已完成的搜索…');
    const ids=[...new Set(error.sourceLines||[])],existing=review.games.flatMap(g=>g.findings).map(f=>f.sourceLine);
    if(ids.length&&ids.every(id=>existing.includes(id))){
      const failed=explainRecords.filter(r=>ids.includes(r.node.sourceLine));
      const patch=await ask(job,'只修正以下失败节点，其他复盘不变。replacements.originalSourceLine必须精确覆盖失败的原行号，finding给完整修正。仅使用下方Forge证据，不能新增搜索结论。\n'+JSON.stringify({error:error.message,failed:review.games.flatMap(g=>g.findings).filter(f=>ids.includes(f.sourceLine)),evidence:failed.map(Protocol.summarizeEvidence)}),S.reviewPatch);
      S.validate(patch,S.reviewPatch);
      if(patch.replacements.length!==ids.length||new Set(patch.replacements.map(p=>p.originalSourceLine)).size!==ids.length||patch.replacements.some(p=>!ids.includes(p.originalSourceLine)))throw Error('修正未精确覆盖失败节点。');
      const replacements=new Map(patch.replacements.map(p=>[p.originalSourceLine,p.finding]));for(const g of review.games)g.findings=g.findings.map(f=>replacements.get(f.sourceLine)||f);
    }else review=await ask(job,prompt+'\n上次结果未通过：'+error.message+'。修正结构与引用，不能虚构证据。',S.review);
  }
  const outcome={review,evidence,unsupported,sideboardPlans:matchDecks.sideboardPlans,deckProfiles:publicDeckProfile(matchDecks),engine:forge.engine||baseEngine,reviewVersion:REVIEW_VERSION,completedAt:new Date().toISOString()};
  job.abort.signal.throwIfAborted();
  await fs.mkdir(cacheDir,{recursive:true});
  const cacheFile=path.join(cacheDir,replay.id+'.json'),temporary=cacheFile+'.'+job.id+'.tmp';
  try{
    await fs.writeFile(temporary,JSON.stringify({...outcome,matchDecks:storedDecks},null,2));
    job.abort.signal.throwIfAborted();
    await fs.rename(temporary,cacheFile);
  }finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
  replay.review=review;replay.searchEvidence=evidence;replay.unsupportedNodes=unsupported;replay.matchDecks=matchDecks;
  job.result={...outcome,reviewPending:false,reviewRevision:job.result.reviewRevision+1,gameStages:games.map(game=>({game,message:`已完成 ${records.filter(r=>r.source.game===game).length} 个搜索节点`}))};
  return outcome;
}
module.exports={buildHoldout,recordedChoiceSource,REVIEW_VERSION,runForgeReview,prepareNode,seeds,compactEvidence,ensureMatchDecks,prepareOnly,shortlistOnly,buildWorlds,writeWinningReplays,publicDeckProfile};
