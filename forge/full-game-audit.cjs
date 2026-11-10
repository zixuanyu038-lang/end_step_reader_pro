'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {performance}=require('node:perf_hooks');
const assert=require('node:assert/strict');
const R=require('../replay'),Source=require('../search-source'),{ForgePool}=require('../forge-client');
const {CodexClient}=require('../codex-client'),Protocol=require('../search-protocol'),Schema=require('../search-schema');
const {buildWorlds,buildHoldout,recordedChoiceSource}=require('../search-review');
const {compact,inspectSearchWorlds,originalSelection,search}=require('../tree-search');
const {compileReplay}=require('../forge-replay');

function catalogue(text,game){
  const nodes=Source.candidates(text).filter(n=>n.game===game).map(n=>({...n,kind:'play'}));
  const found=new Set(nodes.map(n=>n.anchorLine)),seat=String(JSON.parse(text.split(/\r?\n/,1)[0]).seat);
  let state=null,current=1;
  for(const [index,raw] of text.split(/\r?\n/).entries()){
    if(!index||!raw)continue;
    const row=JSON.parse(raw),line=index+1;
    if(row.k==='chapter'&&row.edge==='start')current=row.game;
    if(current>game)break;
    if(row.k==='key')state=row.state;
    if(row.k==='diff')state=R.patch(state,row.patch);
    if(current!==game||row.k!=='action'||state?.status!=='ACTIVE'||state.sideboarding||found.has(line))continue;
    if(row.action.type==='PLAY_CARD'||(row.action.type==='PASS_PRIORITY'&&String(state.priorityPlayerId)===seat)){
      const card=state.players.flatMap(p=>p.hand.concat(p.battlefield,p.graveyard,p.exile)).find(c=>String(c.id)===String(row.action.cardId));
      nodes.push({kind:row.action.type==='PASS_PRIORITY'?'pass':'play',sourceLine:line,anchorLine:line,game,
        t:row.t,turn:Number(state.turnNumber),phase:state.phase,cardId:row.action.cardId,
        cardName:row.action.type==='PASS_PRIORITY'?'让过':card?.name||'未对应事件的出牌'});
    }
  }
  return nodes.sort((a,b)=>a.sourceLine-b.sourceLine);
}
const outcome=(run,viewer)=>({stop:run.stopReason,turn:run.state.turnNumber,
  result:run.stopReason==='game_over'&&run.state.winnerId!=null?(String(run.state.winnerId)===viewer?'win':'loss'):null});
const simplified=a=>({...compact(a),cardName:a.cardName,cardId:a.cardId,targets:a.targets,modes:a.modeDescriptions});
const settings={horizonTurns:100,maxChoices:8000,maxSteps:12000};
function resolveOriginal(node,source,actions){
  if(node.kind==='pass')return actions.find(a=>a.kind==='pass'&&String(a.actorId)===String(source.header.seat));
  const selected=originalSelection(source,actions);
  return selected.matched?selected.action:null;
}
function scorePair(base,alt){
  return base?.result==='loss'&&alt?.result==='win'?1:base?.result==='win'&&alt?.result==='loss'?-1:0;
}
const {withPublicHand}=require('../controlled-replay');
async function main(){
  const [id,output,gameArg='1',workersArg='4',mode='nodes',lineArg]=process.argv.slice(2);
  assert.match(id||'',/^[0-9a-f]{64}$/);
  const game=Number(gameArg),workers=Number(workersArg);
  assert.ok(output&&Number.isInteger(game)&&game>=1&&Number.isInteger(workers)&&workers>=1&&workers<=8);
  const data=path.join(__dirname,'..','.endstep-data');
  const input=path.join(data,'replays',id+'.jsonl.gz');
  const text=zlib.gunzipSync(fs.readFileSync(input)).toString('utf8'),model=R.parse(text,path.basename(input));
  const {gameOutcomes}=require('../turning-points');
  if(!['exhaustive','ismcts-trial','export-verified','export-controlled','tactical-review'].includes(mode))assert.equal(gameOutcomes(model)[game],'loss');
  const raw=JSON.parse(fs.readFileSync(path.join(data,'forge-reviews',id+'.json'),'utf8'));
  const profile={decks:raw.matchDecks.byGame[game],catalog:new Map(raw.matchDecks.catalog)};
  const viewer=String(model.header.seat),nodes=catalogue(text,game),start=performance.now();
  fs.mkdirSync(output,{recursive:true});
  const pool=new ForgePool({workers,dataDir:data,...(['ismcts-trial','export-verified','export-controlled'].includes(mode)?{javaHeap:'1536m',activeProcessors:2}:
    ['exhaustive','tactical-review'].includes(mode)?{javaHeap:'2g',activeProcessors:2}:{})});
  const journal=(kind,fields={})=>{
    const entry={at:new Date().toISOString(),elapsedMs:Math.round(performance.now()-start),kind,...fields};
    fs.appendFileSync(path.join(output,'progress.jsonl'),JSON.stringify(entry)+'\n');
    console.log(JSON.stringify(entry));
  };
  const save=(name,data)=>fs.writeFileSync(path.join(output,name),JSON.stringify(data,null,2));
  if(mode==='nodes')save('catalogue.json',nodes);
  journal('started',{game,nodes:nodes.length,workers,mode});
  const reviewModel={...model,turns:model.turns.filter(t=>t.game===game)};
  const ai=new CodexClient({cwd:path.join(data,'runtime')});
  const blind=mode==='nodes'?ai.generate({instructions:Protocol.instructions,
    prompt:Protocol.shortlistPrompt(reviewModel,nodes)+'\n本次作为盲测。请独立找出会改变胜负的时机、结算选牌与同一回合的连招。点出需要验证的具体牌、费用和后续顺序。',schema:Schema.shortlist})
    .then(result=>{save('ai-blind.json',result);journal('blind-ai-finished',{lines:result.nodes.map(n=>n.sourceLine)});return result;})
    .catch(error=>{journal('blind-ai-error',{error:error.message});return null;}):Promise.resolve(null);

  async function request(worker,world,command,actions,options={}){
    return worker.request({command,root:world.root,path:actions.map(compact),...settings,searchProbe:!options.includeTrace,...options});
  }
  async function run(worker,world,actions,options){
    const full=await request(worker,world,'simulate',actions,options);
    return {full,...outcome(full,viewer)};
  }
  async function scanNode(node,index,worker){
    const started=performance.now(),timings={};
    const result={node,roots:[],tests:[],errors:[]};let source,worlds;
    try{
      source=Source.sourceAt(text,node.sourceLine);worlds=buildWorlds(source,profile,3);
      const checked=[];
      for(const world of worlds)try{
        const [{initial}]=await inspectSearchWorlds({client:worker,source,worlds:[world]});
        checked.push({world,initial});
      }catch(error){result.errors.push(error.message);}
      timings.restoreMs=Math.round(performance.now()-started);
      if(!checked.length)result.status='unsupported';
      else{
        result.status='searched';
        for(const {world,initial} of checked){
          const original=resolveOriginal(node,source,initial.actions);
          const root={worldId:world.id,seed:world.root.seed,original:original?simplified(original):null,actions:[],legalCount:initial.actions.length};
          result.roots.push(root);
          if(initial.actions.length===1&&initial.actions[0].kind==='pass'){root.forcedPass=true;continue;}
          const baseline=original?await run(worker,world,[original]).catch(e=>({error:e.message})):null;
          root.baseline=baseline&&{result:baseline.result,turn:baseline.turn,stop:baseline.stop,error:baseline.error};
          for(const action of initial.actions){
            const entry={action:simplified(action)};
            try{
              const alt=original?.key===action.key?baseline:await run(worker,world,[action]);
              Object.assign(entry,{result:alt.result,turn:alt.turn,stop:alt.stop,score:scorePair(baseline,alt)});
            }catch(error){entry.error=error.message;}
            root.actions.push(entry);
          }
        }
      }
    }catch(error){result.status='unsupported';result.errors.push(error.message);}
    result.elapsedMs=Math.round(performance.now()-started);result.timings=timings;
    save('node-'+node.sourceLine+'.json',result);
    journal('node-finished',{line:node.sourceLine,turn:node.turn,card:node.cardName,status:result.status,elapsedNodeMs:result.elapsedMs,
      legal:result.roots.reduce((n,r)=>n+r.legalCount,0),simulated:result.roots.reduce((n,r)=>n+r.actions.length,0),
      flips:result.roots.reduce((n,r)=>n+r.actions.filter(a=>a.score===1).length,0),reason:result.errors[0]});
    return result;
  }

  async function scanChoices(){
    const groups=nodes.filter(n=>n.choice);
    const jobs=[];
    for(const node of groups){
      try{
        const source=recordedChoiceSource(Source.sourceAt(text,node.sourceLine),node.choice);
        const worlds=buildWorlds(source,profile,3);
        jobs.push(...worlds.map((world,i)=>({node,source,world,i})));
      }catch(error){journal('choice-root-error',{line:node.sourceLine,reason:error.message});}
    }
    const summaries=await pool.mapWorlds(jobs,async ({node,source,world,i},index,worker)=>{
      const began=performance.now(),choice=node.choice;
      const item={line:node.sourceLine,turn:node.turn,card:node.cardName,world:i,seed:world.root.seed,options:[]};
      try{
        const [{initial}]=await inspectSearchWorlds({client:worker,source,worlds:[world]});
        const cast=resolveOriginal(node,source,initial.actions);
        if(!cast)throw Error('无法唯一定位原施法。');
        const selections=choice.name==='Stock Up'?choice.options.flatMap((a,j)=>choice.options.slice(j+1).map(b=>[a,b])):
          choice.options.map(card=>[card]);
        const evaluate=async ids=>{
          const tested=await run(worker,world,[cast],{resolutionChoice:{name:choice.name,sourceId:choice.sourceId,ids}});
          if(!tested.full.resolutionChoiceApplied)return {error:'原结算选牌未出现。'};
          return {result:tested.result,turn:tested.turn,stop:tested.stop,
            sameTurn:tested.full.executed?.filter(a=>a.turn===node.turn&&String(a.actorId)===viewer).map(a=>[a.kind,a.cardName])};
        };
        item.baseline=await evaluate(choice.picked);
        for(const selection of selections){
          const ids=selection.map(c=>c.id),names=selection.map(c=>c.name);
          const original=ids.every(id=>choice.picked.includes(id))&&ids.length===choice.picked.length;
          const candidate=original?item.baseline:await evaluate(ids).catch(e=>({error:e.message}));
          item.options.push({ids,names,original,...candidate,delta:scorePair(item.baseline,candidate)});
        }
      }catch(error){item.error=error.message;}
      item.elapsedMs=Math.round(performance.now()-began);
      save('choices-'+node.sourceLine+'-world-'+i+'.json',item);
      journal('choice-world-finished',{line:item.line,card:item.card,world:i,elapsedNodeMs:item.elapsedMs,
        options:item.options.length,flips:item.options.filter(o=>o.delta===1).length,reason:item.error});
      return item;
    });
    save('choices-summary.json',summaries);
    journal('choices-finished',{nodes:groups.length,samples:summaries.length,options:summaries.reduce((n,s)=>n+s.options.length,0)});
  }

  async function adversarial(){
    const prior=JSON.parse(fs.readFileSync(path.join(output,'summary.json'),'utf8'));
    const compressed=mode==='adversarial-choices',prefix=compressed?'compressed':'adversarial';
    const actionable=new Set(prior.nodes.filter(n=>n.simulations>0).map(n=>n.line));
    const choiceLines=new Set(nodes.filter(n=>n.choice).flatMap(n=>[n.sourceLine,n.earlierLine]));
    const aiOrder=new Map(prior.blindAiLines.map((line,i)=>[line,i]));
    const candidates=nodes.filter(n=>actionable.has(n.sourceLine)&&(!compressed||choiceLines.has(n.sourceLine))).sort((a,b)=>
      (aiOrder.get(a.sourceLine)??10000)-(aiOrder.get(b.sourceLine)??10000)||a.sourceLine-b.sourceLine);
    journal(prefix+'-started',{nodes:candidates.length,workers});
    const idle=pool.workers.slice(),pending=[];
    function dispatch(){
      while(idle.length&&pending.length){
        const worker=idle.pop(),{run,resolve,reject}=pending.shift();
        Promise.resolve().then(()=>run(worker)).then(resolve,reject).finally(()=>{
          idle.push(worker);
          dispatch();
        });
      }
    }
    function schedule(run){
      return new Promise((resolve,reject)=>{
        pending.push({run,resolve,reject});
        dispatch();
      });
    }
    const clientFor=configure=>({
      engine:pool.engine,
      request:(query,options)=>schedule(worker=>worker.request(configure(query),options)),
      async mapWorlds(worlds,visit){
        const results=await Promise.allSettled(worlds.map((world,index)=>schedule(worker=>
          visit(world,index,{request:(query,options)=>worker.request(configure(query),options)}))));
        const failure=results.find(result=>result.status==='rejected');
        if(failure)throw failure.reason;
        return results.map(result=>result.value);
      }
    });
    const inspector=clientFor(query=>query);
    const engine=clientFor(query=>({...query,enumerateChoices:true,includeExecuted:true,skipForcedPasses:compressed}));
    const results=await Promise.all(candidates.map(async node=>{
      const began=performance.now(),filename=prefix+'-'+node.sourceLine+'.json';
      const statistics=({line,card,publicHand,elapsedMs,opponentReplies,solitudeReplies,effectChoices,error})=>
        ({line,card,publicHand,elapsedMs,opponentReplies,solitudeReplies,effectChoices,error});
      if(fs.existsSync(path.join(output,filename)))try{
        const saved=JSON.parse(fs.readFileSync(path.join(output,filename),'utf8'));
        if(saved.search?.runs?.length===3){
          journal(prefix+'-resumed-node',{line:node.sourceLine,elapsedNodeMs:saved.elapsedMs});
          return statistics(saved);
        }
      }catch{}
      const result={line:node.sourceLine,card:node.cardName};
      try{
        let source=Source.sourceAt(text,node.sourceLine);
        if(node.choice?.name==='Stock Up')source=recordedChoiceSource(source,node.choice);
        const corrected=withPublicHand(source);
        source=corrected.source;result.publicHand=corrected.publicNames;
        const worlds=buildWorlds(source,profile,3);
        const checkedWorlds=await inspectSearchWorlds({client:inspector,source,worlds});
        let first=true;
        const checked=await search({client:engine,source,worlds,checkedWorlds,budget:{
          iterations:120,width:12,maxDepth:16,horizonTurns:100,maxChoices:8000,maxSteps:12000
        },onProgress:p=>{
          if(first||p.iteration===p.iterations){first=false;journal(prefix+'-progress',{line:node.sourceLine,card:node.cardName,
            world:p.world,iterations:p.completedIterations,simulations:p.simulated});}
        }});
        result.search={...checked,representative:undefined};
        const replies=checked.runs.flatMap(run=>run.simulations).filter(s=>s.path.some(a=>String(a.actorId)!==viewer&&a.kind!=='pass'));
        result.opponentReplies=replies.length;
        result.solitudeReplies=replies.filter(s=>s.path.some(a=>String(a.actorId)!==viewer&&a.label?.startsWith('Solitude'))).length;
        result.effectChoices=checked.runs.flatMap(run=>run.simulations).filter(s=>s.path.some(a=>a.kind==='choice')).length;
      }catch(error){result.error=error.message;}
      result.elapsedMs=Math.round(performance.now()-began);
      save(filename,result);
      journal(prefix+'-node-finished',{line:node.sourceLine,card:node.cardName,elapsedNodeMs:result.elapsedMs,
        publicHand:result.publicHand,opponentReplies:result.opponentReplies,solitudeReplies:result.solitudeReplies,effectChoices:result.effectChoices,error:result.error});
      return statistics(result);
    }));
    save(prefix+'-summary.json',results);
    journal(prefix+'-finished',{nodes:results.length});
  }

  async function exhaustive(){
    const {enumerateFrontier}=require('./exhaustive-frontier.cjs');
    const line=lineArg==null?null:Number(lineArg);
    const candidates=nodes.filter(node=>line==null||line===node.sourceLine);
    assert.ok(candidates.length,'No matching replay node.');
    const roots=[],unavailable=[];
    for(const node of candidates)try{
      let source=Source.sourceAt(text,node.sourceLine);
      if(node.choice?.name==='Stock Up')source=recordedChoiceSource(source,node.choice);
      const fixed=withPublicHand(source);
      source=fixed.source;
      for(const world of buildWorlds(source,profile,3))roots.push({line:node.sourceLine,world,source,publicHand:fixed.publicNames});
    }catch(error){unavailable.push({line:node.sourceLine,card:node.cardName,reason:error.message});}
    const prefix=line==null?'exhaustive':'exhaustive-'+line;
    const focusLines=[];
    if(line==null&&fs.existsSync(path.join(output,'summary.json'))){
      const prior=JSON.parse(fs.readFileSync(path.join(output,'summary.json'),'utf8'));
      const verified=fs.readdirSync(output).filter(name=>/^replay-export.*-verified\.json$/.test(name)).flatMap(name=>
        JSON.parse(fs.readFileSync(path.join(output,name),'utf8'))).map(item=>({line:item.line,
        flips:item.pairs.filter(p=>p.baseline.result==='loss'&&p.alternative.result==='win').length}))
        .filter(item=>item.flips>0).sort((a,b)=>b.flips-a.flips||a.line-b.line);
      const order=[...verified.slice(0,1).map(item=>item.line),...prior.blindAiLines,...verified.map(item=>item.line)];
      focusLines.push(...[...new Set(order)].filter(line=>roots.some(root=>root.line===line)).slice(0,Math.floor(workers/2)));
    }
    const {createInformationSetSearch}=require('./information-set-trial.cjs');
    const policyLines=focusLines.length?focusLines:[line??roots[0]?.line].filter(n=>n!=null);
    const policies=policyLines.map(nodeLine=>{
      const worlds=roots.filter(r=>r.line===nodeLine).map(r=>r.world);
      const file=path.join(output,'ismcts-live-'+nodeLine+'.json');
      const trial=path.join(output,'ismcts-trial-'+nodeLine+'.json');
      const saved=fs.existsSync(file)?file:fs.existsSync(trial)?trial:null;
      let checkpoint;
      if(saved)try{checkpoint=JSON.parse(fs.readFileSync(saved,'utf8'));}
      catch(error){journal(prefix+'-ismcts-checkpoint-error',{line:nodeLine,error:error.message});}
      const ids=new Set(worlds.map(w=>w.id));
      const compatible=checkpoint?.observations?.every(o=>o.worlds.every(id=>ids.has(id)));
      return {line:nodeLine,file,search:createInformationSetSearch({worlds,viewer,checkpoint:compatible?checkpoint:null})};
    });
    save(prefix+'-roots.json',{game,unavailable,roots:roots.map(r=>({line:r.line,world:r.world.id,publicHand:r.publicHand})),
      adapterLimits:['Sampled hidden hands and deck order','Forge pays mana and makes combat decisions',
        'Only selected resolution prompts are enumerated','Incomplete X values and some modal combinations are logged']});
    journal(prefix+'-started',{game,nodes:candidates.length,worlds:roots.length,unavailable:unavailable.length,workers,focusLines,policyLines});
    const abort=new AbortController(),stop=()=>abort.abort();
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
    let last=0,nextPolicy=0;
    async function probe(worker,world,command,actions,signal){
      const query={command,root:world.root,path:actions,searchProbe:true,enumerateChoices:true,skipForcedPasses:true,exhaustive:true};
      if(command==='simulate')query.horizonTurns=100;
      return (await pool.searchProbe(query,{signal},worker)).result;
    }
    try{
      const counts=await enumerateFrontier({
        file:path.join(output,prefix+'.sqlite'),roots,workers:pool.workers,focusLines,viewer,signal:abort.signal,
        async expand(worker,root,actions,signal){
          if(!actions.length)await inspectSearchWorlds({client:worker,source:root.source,worlds:[root.world],signal});
          return probe(worker,root.world,'expand',actions,signal);
        },
        guide:policies.length?async(worker,signal)=>{
          const policy=policies[nextPolicy++%policies.length];
          const sample=await policy.search.sample((world,command,actions)=>probe(worker,world,command,actions,signal),signal);
          const state=policy.search.snapshot();
          const temporary=policy.file+'.tmp';
          fs.writeFileSync(temporary,JSON.stringify({line:policy.line,...state,lastSample:sample},null,2));
          fs.renameSync(temporary,policy.file);
          return {line:policy.line,...sample,walk:policy.search.walk(sample.world),
            samples:state.samples,shared:state.observations.filter(o=>o.worlds.length>1).length};
        }:undefined,
        onGuide({hint,preferred,error}){
          if(error){journal(prefix+'-ismcts-error',{error});return;}
          if(hint)journal(prefix+'-ismcts-sample',{line:hint.line,world:hint.world,samples:hint.samples,shared:hint.shared,
            selected:hint.path.map(a=>a.label),rollout:{stop:hint.stop,winner:hint.winner,turn:hint.turn},
            prioritized:preferred?.id??null,prioritizedDepth:preferred?.depth});
        },
        onProgress(p){
          const now=performance.now();
          if(now-last>=5000){last=now;journal(prefix+'-progress',{line:p.line,world:p.world,depth:p.depth,processed:p.processed,counts:p.counts()});}
          if(p.status==='terminal'||p.depth===0&&p.status==='blocked')
            journal(prefix+'-'+p.status,{line:p.line,world:p.world,depth:p.depth,...p.detail,guided:p.guided,path:p.path});
        }
      });
      journal(prefix+(abort.signal.aborted?'paused':counts.blocked?'-frontier-drained-with-gaps':'-frontier-drained'),{counts,unavailable:unavailable.length});
    }finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
  }

  async function testInformationSets(){
    const {informationSetTrial}=require('./information-set-trial.cjs');
    const node=nodes.find(n=>n.sourceLine===Number(lineArg));
    assert.ok(node,'Choose a replay node for the ISMCTS pilot.');
    let source=Source.sourceAt(text,node.sourceLine);
    if(node.choice?.name==='Stock Up')source=recordedChoiceSource(source,node.choice);
    const fixed=withPublicHand(source);
    const worlds=buildWorlds(fixed.source,profile,3);
    const result=await informationSetTrial({client:pool,worlds,viewer,samples:18});
    save('ismcts-trial-'+node.sourceLine+'.json',{line:node.sourceLine,publicHand:fixed.publicNames,...result});
    journal('ismcts-trial-finished',{line:node.sourceLine,samples:result.samples,observations:result.observations.length,
      sharedObservations:result.observations.filter(o=>o.worlds.length>1).length});
  }

  async function exportVerified(){
    assert.ok(lineArg,'Pass a replay export plan.');
    const plans=JSON.parse(fs.readFileSync(lineArg,'utf8'));
    const results=[];
    for(const plan of plans){
      const node=nodes.find(n=>n.sourceLine===plan.line);
      assert.ok(node,'Replay export source is missing.');
      let source=Source.sourceAt(text,node.sourceLine);
      if(node.choice?.name==='Stock Up')source=recordedChoiceSource(source,node.choice);
      source=withPublicHand(source).source;
      const discovery=buildWorlds(source,profile,3);
      const worlds=discovery.concat(buildHoldout(source,profile,discovery,plan.holdouts||0));
      const pairs=[];
      for(const pair of plan.pairs){
        const world=worlds.find(w=>w.id===pair.world);
        assert.ok(world,'Replay export world differs from the search evidence.');
        const selected=plan.export?.world===world.id;
        const options={enumerateChoices:true,skipForcedPasses:true,exhaustive:!!plan.exhaustive};
        const baseline=await run(pool.primary,world,pair.baselinePath,options);
        const alternative=await run(pool.primary,world,pair.alternatePath,{...options,includeTrace:selected});
        const checked={world:world.id,baseline:{result:baseline.result,turn:baseline.turn,stop:baseline.stop},
          alternative:{result:alternative.result,turn:alternative.turn,stop:alternative.stop}};
        if(selected){
          const {name,description,criterion}=plan.export;
          assert.ok(path.basename(name)===name&&name.endsWith('.esreplay'),'Invalid replay export name.');
          const matches=alternative.result==='win'&&(
            criterion==='flip'&&baseline.result==='loss'||
            criterion==='faster-win'&&baseline.result==='win'&&alternative.turn<baseline.turn);
          assert.ok(matches,'The replay did not reproduce its expected improvement.');
          const result=compileReplay(source,alternative.full,{title:path.basename(name,'.esreplay'),summary:description,world});
          assert.ok(result.complete&&result.header.result==='win');
          fs.writeFileSync(path.join(output,name),result.bytes);
          checked.replay=name;
        }
        pairs.push(checked);
      }
      results.push({line:plan.line,pairs});
    }
    save(path.basename(lineArg,'.json')+'-verified.json',results);
    journal('export-verified-finished',{results});
  }

  async function tacticalReview(){
    const {checkTacticalArm}=require('./tactical-review.cjs');
    assert.ok(lineArg,'Pass a tactical review plan.');
    const plans=JSON.parse(fs.readFileSync(lineArg,'utf8')),jobs=[];
    const prefix=path.basename(lineArg,'.json');
    for(const plan of plans){
      const node=nodes.find(n=>n.sourceLine===plan.line);
      assert.ok(node&&['opening','route'].includes(plan.scope),'Invalid tactical plan.');
      let source=Source.sourceAt(text,node.sourceLine);
      if(node.choice?.name==='Stock Up')source=recordedChoiceSource(source,node.choice);
      const fixed=withPublicHand(source);
      source=fixed.source;
      const discovery=buildWorlds(source,profile,3),byWorld=new Map(plan.pairs.map(pair=>[pair.world,pair]));
      for(const world of discovery.filter(w=>byWorld.has(w.id)))
        jobs.push({plan,source,world,pair:byWorld.get(world.id),holdout:false,publicHand:fixed.publicNames});
      if(plan.scope==='opening'){
        for(const world of buildHoldout(source,profile,discovery,plan.holdouts||0))
          jobs.push({plan,source,world,pair:plan.pairs[0],holdout:true,publicHand:fixed.publicNames});
      }
    }
    journal('tactical-started',{jobs:jobs.length,workers,lines:plans.map(p=>p.line)});
    const samples=await pool.mapWorlds(jobs,async ({plan,source,world,pair,holdout,publicHand},index,worker)=>{
      const name=prefix+'-'+plan.line+'-'+world.id+'.json',file=path.join(output,name);
      if(fs.existsSync(file))return JSON.parse(fs.readFileSync(file,'utf8'));
      const calls=new Map();
      const request=(command,actions)=>{
        const key=JSON.stringify([command,actions.map(a=>a.key)]);
        if(!calls.has(key))calls.set(key,worker.request({command,root:world.root,path:actions,
          searchProbe:true,exhaustive:true,enumerateChoices:true,skipForcedPasses:true,horizonTurns:100}));
        return calls.get(key);
      };
      const settings={scope:plan.scope,viewer,turn:source.baseline.turnNumber,request};
      const choose=route=>plan.scope==='opening'?route.slice(0,1):route;
      const arms=[];
      for(const route of [pair.baselinePath,pair.alternatePath])
        arms.push(await checkTacticalArm({...settings,path:choose(route)}));
      const sample={line:plan.line,card:nodeName(plan.line),world:world.id,holdout,publicHand,scope:plan.scope,calls:calls.size,
        baseline:arms[0],alternative:arms[1]};
      save(name,sample);
      journal('tactical-sample',{line:sample.line,world:sample.world,holdout,calls:sample.calls,
        native:arms.map(a=>a.native),worst:arms.map(a=>a.worst),replies:arms.map(a=>a.forks.flatMap(f=>f.replies).length),partial:arms.map(a=>a.partial)});
      return sample;
    });
    save(prefix+'-results.json',samples);
    journal('tactical-finished',{samples:samples.length,calls:samples.reduce((n,s)=>n+s.calls,0)});
  }

  async function exportControlled(){
    const {controlledComparison}=require('../controlled-replay');
    assert.ok(lineArg,'Pass a single-decision comparison plan.');
    const plans=JSON.parse(fs.readFileSync(lineArg,'utf8'));
    const results=await pool.mapWorlds(plans,async (plan,index,worker)=>{
      const node=nodes.find(n=>n.sourceLine===plan.line);
      assert.ok(node,'Single-decision source is missing.');
      let source=Source.sourceAt(text,node.sourceLine);
      if(node.choice?.name==='Stock Up')source=recordedChoiceSource(source,node.choice);
      source=withPublicHand(source).source;
      const discovery=buildWorlds(source,profile,3);
      const world=discovery.concat(buildHoldout(source,profile,discovery,plan.holdouts||0)).find(w=>w.id===plan.world);
      assert.ok(world,'Single-decision world differs from the search evidence.');
      const result=await controlledComparison({source,world,plan,worker});
      for(const arm of result.arms)fs.writeFileSync(path.join(output,arm.file),arm.bytes);
      return {...result,arms:result.arms.map(({bytes,...arm})=>arm)};
    });
    save('controlled-results.json',results);
    journal('export-controlled-finished',{results});
  }

  const nodeName=line=>nodes.find(n=>n.sourceLine===line).cardName;

  try{
    if(mode==='exhaustive'){await exhaustive();return;}
    if(mode==='ismcts-trial'){await testInformationSets();return;}
    if(mode==='export-verified'){await exportVerified();return;}
    if(mode==='export-controlled'){await exportControlled();return;}
    if(mode==='tactical-review'){await tacticalReview();return;}
    if(['adversarial','adversarial-choices'].includes(mode)){await adversarial();return;}
    if(mode==='choices'){await scanChoices();return;}
    const results=await pool.mapWorlds(nodes,scanNode);
    const aiResult=await blind;
    const summary={game,workers,elapsedMs:Math.round(performance.now()-start),recordedNodes:nodes.length,blindAiLines:aiResult?.nodes.map(n=>n.sourceLine)||[],
      nodes:results.map(r=>({line:r.node.sourceLine,turn:r.node.turn,phase:r.node.phase,card:r.node.cardName,status:r.status,elapsedMs:r.elapsedMs,
        worlds:r.roots.length,forced:r.roots.filter(w=>w.forcedPass).length,reason:r.errors[0],
        simulations:r.roots.reduce((n,w)=>n+w.actions.length,0),flips:r.roots.flatMap(w=>w.actions.filter(a=>a.score===1).map(a=>({world:w.worldId,action:a.action,baseline:w.baseline,result:a.result})))}))};
    save('summary.json',summary);journal('finished',{nodes:results.length,elapsedMs:summary.elapsedMs});
  }finally{pool.close();ai.close();}
}
if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={catalogue,withPublicHand};
