'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const Source=require('./search-source'),S=require('./studio-schema'),Schema=require('./search-schema'),Protocol=require('./search-protocol'),LegacyProtocol=require('./studio-protocol');
const {buildWorld}=require('./hidden-worlds'),{search}=require('./tree-search');
const {prepareMatchDecks}=require('./match-decks');
const {routeFromTrace,compileReplay}=require('./forge-replay');
const {selectWinningLines}=require('./winning-lines');
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
async function ensureMatchDecks({replay,profileDir,deckService,forge,ask,signal,onProgress}){
  if(replay.matchDecks)return replay.matchDecks;
  const filename=path.join(profileDir,replay.id+'.json');
  try{const cached=JSON.parse(await fs.readFile(filename,'utf8'));if(cached.version===3&&cached.replayId===replay.id){replay.matchDecks={...cached.profile,catalog:new Map(cached.profile.catalog)};return replay.matchDecks;}}catch{}
  const profile=await prepareMatchDecks({model:replay.model,deckService,forge,ask,signal,onProgress});
  await fs.mkdir(profileDir,{recursive:true});await fs.writeFile(filename,JSON.stringify({version:3,replayId:replay.id,profile:{...profile,catalog:[...profile.catalog]}},null,2));replay.matchDecks=profile;return profile;
}
function buildWorlds(source,prepared,count=3){
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
function compactEvidence(record){
  const r=record.result;return{sourceLine:record.node.sourceLine,game:record.source.game,question:record.node.question,engine:r.engine,algorithm:r.algorithm,simulated:r.simulated,settings:r.settings,quality:r.quality||null,winningCandidates:r.winningCandidates?.length||0,
    best:r.best,original:r.original,comparison:r.comparison,alternatives:r.alternatives,sourceUrls:[...new Set(record.worlds.flatMap(w=>w.sourceUrls))],worlds:record.worlds.map(w=>({id:w.id,seed:w.root.seed,hiddenHands:w.hiddenHands,assumptions:w.assumptions})),
    representativePath:r.representative.path,limitations:r.limitations,artifact:'node-'+record.node.sourceLine+'.json',downloadUrl:record.replayArtifact?.downloadUrl||null,replaySha256:record.replayArtifact?.sha256||null};
}
async function writeWinningReplays(records,job){
  for(const record of records){if(!record.result.quality?.keep)continue;
    const {source,result,worlds,node}=record,world=worlds.find(w=>w.id===result.representative.worldId);
    const replay=compileReplay(source,result.representative,{title:`第 ${source.game} 局 T${source.anchor.turn} · 搜索保留路线`,summary:result.quality.reason,world,evidence:result,quality:result.quality,intent:world.root.intent||null});
    await fs.writeFile(path.join(job.dir,'search','node-'+node.sourceLine+'.esreplay'),replay.bytes);
    record.replayArtifact={downloadUrl:'/api/jobs/'+job.id+'/nodes/'+node.sourceLine+'/replay',sha256:replay.sha256};
  }
}
async function runForgeReview({job,replay,ask,progress,forge,deckService,cacheDir,budget={},nodeLimit=8}){
  const model=replay.model,all=Source.candidates(model.sourceText),directory=path.join(job.dir,'search');await fs.mkdir(directory,{recursive:true});
  if(!replay.matchDecks){
    progress(job,'decks','正在读取整盘公开信息，固定双方牌表并分析换备…');
    replay.matchDecks=await ensureMatchDecks({replay,profileDir:path.join(path.dirname(cacheDir),'deck-profiles'),deckService,forge,signal:job.abort.signal,ask:(prompt,schema,options)=>ask(job,prompt,schema,options),onProgress:message=>progress(job,'decks',message)});
    await fs.writeFile(path.join(directory,'match-decks.json'),JSON.stringify({...replay.matchDecks,catalog:[...replay.matchDecks.catalog]},null,2));
  }
  progress(job,'screen','正在通读对局，筛选需要搜索的关键节点…');
  const selected=await ask(job,Protocol.shortlistPrompt(model,all),Schema.shortlist);S.validate(selected,Schema.shortlist);
  const index=new Map(all.map(n=>[n.sourceLine,n])),shortlisted=[];
  for(const proposed of selected.nodes)if(index.has(proposed.sourceLine)&&!shortlisted.some(n=>n.sourceLine===proposed.sourceLine))shortlisted.push({...index.get(proposed.sourceLine),...proposed,priority:Math.max(1,Math.min(100,proposed.priority))});
  for(const node of all)if(!shortlisted.some(n=>n.sourceLine===node.sourceLine))shortlisted.push({...node,priority:/Flame of Anor/.test(node.cardName)?70:/Brainstorm|Tamiyo|Force of/.test(node.cardName)?35:10,question:'比较 '+node.cardName+' 的时机与资源安排',alternatives:[],reason:'候补研究节点'});
  const games=[...new Set(all.map(n=>n.game))];
  const queue=[];
  // Establish coverage of every recorded game before filling the remaining research budget.
  for(const game of games)for(const node of shortlisted.filter(n=>n.game===game).sort((a,b)=>b.priority-a.priority).slice(0,2))queue.push(node);
  for(const node of shortlisted.slice().sort((a,b)=>b.priority-a.priority))if(!queue.some(n=>n.sourceLine===node.sourceLine))queue.push(node);
  const records=[],unsupported=[],evidence=[];
  const partial={summary:'已筛出研究节点，正在用 Forge 比较候选路线。',overallPlan:'完整复盘会在搜索证据解读完成后显示。',games:games.map(game=>({game,summary:'搜索进行中。',findings:[]})),hiddenHands:[],takeaways:[]};
  job.result={review:partial,reviewPending:true,reviewRevision:0,evidence,gameStages:games.map(game=>({game,message:'等待搜索'}))};
  for(const node of queue){
    if(records.length>=nodeLimit)break;if(job.abort.signal.aborted)throw Error('任务已取消。');
    progress(job,'restore',`正在准备第 ${node.game} 局 T${node.turn}：${node.cardName}…`);
    try{
      const source=Source.sourceAt(model.sourceText,node.sourceLine);
      const prepared={decks:replay.matchDecks.byGame[source.game],catalog:replay.matchDecks.catalog};
      const worlds=buildWorlds(source,prepared,3);
      let last=0;
      const result=await search({client:forge,source,worlds,signal:job.abort.signal,budget,onProgress:p=>{
        if(Date.now()-last>1200||p.iteration===p.iterations){last=Date.now();progress(job,'search',`第 ${node.game} 局 T${node.turn} · 隐藏世界 ${p.world}/${p.worlds} · 搜索 ${p.iteration}/${p.iterations} · 已模拟 ${p.simulated} 次`);}
      }});
      const record={source,result,worlds,node};records.push(record);evidence.push(compactEvidence(record));
      await fs.writeFile(path.join(directory,'node-'+node.sourceLine+'.json'),JSON.stringify({node,worlds,result},null,2));
      job.result.reviewRevision++;job.result.gameStages=games.map(game=>({game,message:`已搜索 ${records.filter(r=>r.source.game===game).length} 个节点`}));
      progress(job,'search',`已完成 ${records.length}/${nodeLimit} 个关键节点，继续比较其余节点…`);
    }catch(error){
      if(job.abort.signal.aborted)throw error;unsupported.push({sourceLine:node.sourceLine,game:node.game,cardName:node.cardName,reason:error.message});
      await fs.writeFile(path.join(directory,'unsupported.json'),JSON.stringify(unsupported,null,2));
      progress(job,'limited',`${node.cardName} 的这个节点暂未通过恢复或模拟核对，正在检查其他关键节点。`);
      if(unsupported.length>=14&&records.length>=Math.min(3,nodeLimit))break;
    }
  }
  if(!records.length)throw Error('没有节点通过真实 Forge 搜索：'+unsupported.slice(0,3).map(n=>n.reason).join('；'));
  await selectWinningLines({records,forge,signal:job.abort.signal,ask:(prompt,schema)=>ask(job,prompt,schema),onProgress:message=>progress(job,'quality',message)});
  await writeWinningReplays(records,job);
  evidence.splice(0,evidence.length,...records.map(compactEvidence));
  for(const record of records)await fs.writeFile(path.join(directory,'node-'+record.node.sourceLine+'.json'),JSON.stringify({node:record.node,worlds:record.worlds,result:record.result},null,2));
  progress(job,'explain','正在根据真实搜索轨迹整理整盘复盘、费用核对和具体建议…');
  const prompt=Protocol.reviewPrompt(model,records,unsupported);
  let review=await ask(job,prompt,S.review);S.validate(review,S.review);
  const byLine=new Map(records.map(r=>[r.node.sourceLine,r]));
  function ground(candidate){
  for(const game of candidate.games)for(const finding of game.findings){
    const record=byLine.get(finding.sourceLine);if(!record||record.source.game!==game.game)throw Object.assign(Error('复盘引用了未经搜索的节点。'),{sourceLines:[finding.sourceLine]});
    if(finding.confidence==='high')finding.confidence='medium';
    const tested=record.result.quality?.keep?routeFromTrace(record.result.representative):[];if(tested.length){finding.proposedLine=tested;finding.manaAudit.paymentPlan=tested.map(s=>(s.cardName||'Pass priority')+'：'+s.payment);}
    if(!record.result.quality?.keep&&finding.severity==='mistake'){finding.severity='alternative';finding.analysis+=' 本轮未保留经胜负及AI二筛认可的改进路线。';}
    if(finding.severity==='mistake'&&(!record.result.comparison.matched||record.result.comparison.meanDifference<45||record.result.comparison.perWorldDifferences.some(w=>w.difference<=0))){finding.severity='alternative';finding.analysis+=' 当前搜索不足以把原操作定为明确失误。';}
  }
  for(const hand of candidate.hiddenHands)hand.confidence='low';
  return LegacyProtocol.validateReview(candidate,model);
  }
  for(let attempt=0;attempt<3;attempt++)try{review=ground(review);break;}catch(error){
    await fs.writeFile(path.join(directory,'review-validation-'+attempt+'.json'),JSON.stringify({review,error:error.message},null,2));
    if(attempt===2)throw error;
    progress(job,'repair','正在修正复盘中的资源或引用错误，保留已完成的搜索…');
    const ids=[...new Set(error.sourceLines||[])],existing=review.games.flatMap(g=>g.findings).map(f=>f.sourceLine);
    if(ids.length&&ids.every(id=>existing.includes(id))){
      const failed=records.filter(r=>ids.includes(r.node.sourceLine));
      const patch=await ask(job,'只修正以下失败节点，其他复盘不变。replacements.originalSourceLine必须精确覆盖失败的原行号，finding给完整修正。仅使用下方Forge证据，不能新增搜索结论。\n'+JSON.stringify({error:error.message,failed:review.games.flatMap(g=>g.findings).filter(f=>ids.includes(f.sourceLine)),evidence:failed.map(Protocol.summarizeEvidence)}),S.reviewPatch);
      S.validate(patch,S.reviewPatch);
      if(patch.replacements.length!==ids.length||new Set(patch.replacements.map(p=>p.originalSourceLine)).size!==ids.length||patch.replacements.some(p=>!ids.includes(p.originalSourceLine)))throw Error('修正未精确覆盖失败节点。');
      const replacements=new Map(patch.replacements.map(p=>[p.originalSourceLine,p.finding]));for(const g of review.games)g.findings=g.findings.map(f=>replacements.get(f.sourceLine)||f);
    }else review=await ask(job,prompt+'\n上次结果未通过：'+error.message+'。修正结构与引用，不能虚构证据。',S.review);
  }
  const outcome={review,evidence,unsupported,sideboardPlans:replay.matchDecks.sideboardPlans,deckProfiles:{byGame:replay.matchDecks.byGame,scope:replay.matchDecks.scope},engine:'forge-2.0.15',reviewVersion:'forge-search-v2-wins',completedAt:new Date().toISOString()};
  await fs.mkdir(cacheDir,{recursive:true});await fs.writeFile(path.join(cacheDir,replay.id+'.json'),JSON.stringify(outcome,null,2));
  replay.review=review;replay.searchEvidence=evidence;replay.unsupportedNodes=unsupported;
  job.result={...outcome,reviewPending:false,reviewRevision:job.result.reviewRevision+1,gameStages:games.map(game=>({game,message:`已完成 ${records.filter(r=>r.source.game===game).length} 个搜索节点`}))};
  return outcome;
}
module.exports={runForgeReview,prepareNode,seeds,compactEvidence,ensureMatchDecks,buildWorlds,writeWinningReplays};
