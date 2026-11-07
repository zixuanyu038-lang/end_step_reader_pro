'use strict';
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const R=require('./replay'),P=require('./studio-protocol'),Scenario=require('./scenario');
const {CodexClient}=require('./codex-client');
const {createModelQueue}=require('./model-queue');
const {ForgeClient}=require('./forge-client'),{DeckService,DeckLookupError,readDeckPreferences}=require('./deck-service');
const {runForgeReview,prepareOnly,shortlistOnly,publicDeckProfile}=require('./search-review'),{runForgeBranch,runBranchQuality,inspectBranchStart}=require('./search-branch'),SearchProtocol=require('./search-protocol');
const {readManualSideboard}=require('./match-decks');
const Source=require('./search-source');
const {version}=require('./package.json');
function readReviewOptions(value){
  const {aiShortlist=true,searchMode='standard'}=value??{};
  if(typeof aiShortlist!=='boolean'||!['standard','deep'].includes(searchMode))throw Error('请选择有效的整盘复盘设置。');
  return {aiShortlist,searchMode};
}
function readStressCards(value){
  if(value==null)return [];
  if(!Array.isArray(value)||value.length>150||value.some(name=>typeof name!=='string'||name.trim().length>180||/[\r\n]/.test(name)))throw Error('请逐行填写对手未知手牌中的英文牌名。');
  return value.map(name=>name.trim()).filter(Boolean);
}
function createStudio({port=8787,dataDir=path.join(__dirname,'.endstep-data'),client=null,forgeClient=null,initialReplay=null,reviewBudget={},reviewNodeLimit=8,runners={}}={}){
  const replays=new Map(),jobs=new Map(),session=crypto.randomBytes(32).toString('hex');let currentId=null;
  const runtime=path.join(dataDir,'runtime');const codex=client||new CodexClient({cwd:runtime});
  const forge=forgeClient||new ForgeClient({dataDir}),deckService=new DeckService({directory:path.join(dataDir,'decks')});
  const modelQueue=createModelQueue(2);
  const branchChecks=new WeakMap();
  const profileDir=path.join(dataDir,'deck-profiles');
  const apiError=(res,status,message)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:message}));};
  const json=(res,data)=>{res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  async function register(text,filename){
    if(Buffer.byteLength(text)>32*1024*1024)throw Error('原始记录超过 32 MB。');const id=Scenario.digest(text);if(replays.has(id)){currentId=id;return replays.get(id);}
    if(replays.size>=5)throw Error('当前会话已打开五份回放，请重启应用后继续。');
    const model=R.parse(text,filename);if(model.warnings.some(s=>s.includes('状态恢复失败')))throw Error('原局状态恢复存在错误，不能据此生成分支。');
    const replay={id,filename,model,review:null,searchEvidence:[]};
    let prepared;
    try{const cached=JSON.parse(await fs.readFile(path.join(profileDir,id+'.json'),'utf8'));if(cached.version===3&&cached.replayId===id)prepared=cached;}catch{}
    try{
      const cached=JSON.parse(await fs.readFile(path.join(dataDir,'forge-reviews',id+'.json'),'utf8'));
      if(cached.reviewVersion==='forge-search-v2-wins'&&(!prepared?.preparedAt||prepared.preparedAt<=(cached.completedAt||''))){
        replay.review=P.validateReview(cached.review,model);replay.searchEvidence=cached.evidence||[];
        if(cached.matchDecks)replay.matchDecks={...cached.matchDecks,catalog:new Map(cached.matchDecks.catalog)};
      }
    }catch{}
    if(!replay.matchDecks&&prepared)try{replay.matchDecks={...prepared.profile,catalog:new Map(prepared.profile.catalog)};}catch{}
    replays.set(id,replay);currentId=id;
    await fs.mkdir(path.join(dataDir,'replays'),{recursive:true});await fs.writeFile(path.join(dataDir,'replays',id+'.jsonl.gz'),zlib.gzipSync(Buffer.from(text)));await fs.writeFile(path.join(dataDir,'current.json'),JSON.stringify({id,filename}));return replay;
  }
  function snapshot(job){
    const unchecked=job.result?.downloadUrl&&!job.result?.quality?.keep;
    let result=unchecked?{quality:{keep:false,reason:'旧测试分支尚未经过胜局与AI二筛，已停止提供下载。'}}:job.result;
    if(job.status==='complete'&&result?.review&&result.reviewVersion!=='forge-search-v2-wins')result={...result,review:undefined,evidence:undefined};
    return{id:job.id,replayId:job.replayId,type:job.type,sourceLine:job.sourceLine,parentJobId:job.parentJobId||null,intent:job.intent||'',stressCards:job.stressCards||[],reviewOptions:job.reviewOptions,status:job.status,phase:job.phase,message:unchecked?'旧测试分支尚未经过胜局与AI二筛，已停止提供下载。':job.message,events:job.events,createdAt:job.createdAt,result:result||null,error:job.error||null,errorCode:job.errorCode||null};
  }
  async function save(job){const contents=JSON.stringify(snapshot(job),null,2);job.savePromise=(job.savePromise||Promise.resolve()).catch(()=>{}).then(async()=>{await fs.mkdir(job.dir,{recursive:true});await fs.writeFile(path.join(job.dir,'job.json'),contents);});try{await job.savePromise;}catch{}}
  function progress(job,phase,message){job.phase=phase;job.message=message;const event={at:Date.now(),phase,message};job.events.push(event);if(job.events.length>100)job.events.shift();fs.appendFile(path.join(job.dir,'progress.jsonl'),JSON.stringify(event)+'\n').catch(()=>{});save(job);}
  async function ask(job,prompt,schema,options={}){
    const phase=job.phase,message=job.message,queuedAt=Date.now();let retrying=false,searched=false;
    const log=event=>{
      if(event.event==='web_search_completed')searched=true;
      return fs.appendFile(path.join(job.dir,'model-requests.jsonl'),JSON.stringify({phase,...event})+'\n').catch(()=>{});
    };
    const result=await modelQueue(()=>{
      log({at:Date.now(),event:'queue_started',queueMs:Date.now()-queuedAt});
      return codex.generate({instructions:SearchProtocol.instructions,prompt,schema,webSearch:!!options.webSearch,signal:job.abort.signal,onDiagnostic:log,onProgress:event=>{if(['reconnecting','retrying'].includes(event.phase)){retrying=true;progress(job,phase,event.message);}else if(['resumed','thinking'].includes(event.phase)&&retrying){retrying=false;progress(job,phase,message);}}});
    },job.abort.signal);if(job.abort.signal.aborted)throw Error('任务已取消。');
    if(options.requireWebSearch&&!searched)throw new DeckLookupError('deck_lookup_failed','Codex 未执行联网搜索，无法确认是否有相近牌表。');
    return result;
  }
  async function review(job,replay){
    return (runners.review||runForgeReview)({job,replay,ask,progress,forge,deckService,cacheDir:path.join(dataDir,'forge-reviews'),budget:reviewBudget,nodeLimit:reviewNodeLimit});
  }
  async function checkBranchStart(replay,line,{findEarlier=false}={}){
    const profiles=replay.matchDecks;
    if(!profiles)return{status:'unavailable',reason:'请先准备对局或完成整盘复盘。'};
    if(!branchChecks.has(profiles))branchChecks.set(profiles,new Map());
    const cache=branchChecks.get(profiles);
    function check(candidate){
      if(cache.has(candidate))return cache.get(candidate);
      const task=(async()=>{
        let source;
        try{source=Source.sourceAt(replay.model.sourceText,candidate);}
        catch(error){return{status:'unsupported',reason:error.message};}
        const point={sourceLine:candidate,anchorLine:source.anchor.line,game:source.game,turn:source.anchor.turn,t:source.anchor.t};
        try{
          await inspectBranchStart({source,profiles,forge});
          return{status:'ready',point};
        }catch(error){
          if(error.code==='unsupported_root'||error.code==='forge_root_invalid')return{status:'unsupported',point,reason:error.message};
          return{status:'unavailable',point,reason:error.message};
        }
      })();
      cache.set(candidate,task);
      task.then(result=>{if(result.status==='unavailable')cache.delete(candidate);});
      return task;
    }
    const result=await check(line);
    if(!findEarlier||result.status!=='unsupported'||!result.point)return result;
    replay.branchCandidates??=Source.candidates(replay.model.sourceText);
    const earlier=replay.branchCandidates.filter(candidate=>candidate.game===result.point.game&&candidate.anchorLine<result.point.anchorLine).reverse();
    const reviewed=new Set(replay.searchEvidence.map(item=>item.sourceLine));
    const candidates=earlier.slice(0,5).concat(earlier.slice(5).filter(candidate=>reviewed.has(candidate.sourceLine)).slice(0,2));
    for(const candidate of candidates){
      const previous=await check(candidate.sourceLine);
      if(previous.status==='ready')return{...result,earlier:{...previous.point,cardName:candidate.cardName}};
      if(previous.status==='unavailable')break;
    }
    return result;
  }
  async function run(job,replay,focus){
    try{
      if(job.type==='review'){const outcome=await review(job,replay);job.result={...job.result,...outcome};}
      else if(job.type==='prepare')job.result=await prepareOnly({job,replay,ask,progress,forge,deckService,profileDir});
      else if(job.type==='shortlist')job.result=await shortlistOnly({job,replay,ask,progress});
      else if(job.type==='quality')job.result=await runBranchQuality({job,parent:jobs.get(job.parentJobId),replay,ask,progress,forge});
      else job.result=await (runners.branch||runForgeBranch)({job,replay,ask,progress,forge,deckService,profileDir,focus});
      if(job.result?.review)job.result.reviewVersion='forge-search-v2-wins';
      if(job.abort.signal.aborted)throw Error('任务已取消。');
      job.status='complete';
      const stageMessages={review:'整盘复盘完成，建议附有 Forge 搜索证据。',prepare:'对局已准备好。可以在中文战报里选节点，输入打法并开始搜索。',shortlist:'AI 已标出候选节点。选中一个节点后可以单独搜索。'};
      let message=stageMessages[job.type];
      if(!message){
        if(job.type==='search'&&job.result?.searchSummary)message='Forge 搜索完成，可查看搜索结果。';
        else if(job.result?.downloadUrl)message='已保留通过胜负与 AI 二筛的指导分支，可以下载回放。';
        else if(job.result?.quality?.keep===false)message='本轮未保留改进分支：'+job.result.quality.reason;
        else if(job.result?.plan?.feasible===false)message='玩法意图尚不能执行，请查看具体限制。';
        else message='已提炼玩法意图并完成 Forge 局部预演。';
      }
      progress(job,'complete',message);
    }catch(e){
      if(job.abort.signal.aborted){job.status='cancelled';progress(job,'cancelled','任务已取消。');}
      else{
        job.status='failed';job.error=e.message;
        const deckMessages={deck_not_found:'未查询到牌表。请选择其他来源或上传牌表后重试。',deck_lookup_failed:'牌表查询失败。请查看原因后重试，或换一个来源。',deck_upload_invalid:'上传牌表未通过校验。请检查牌表后重试。'};
        if(e instanceof DeckLookupError)job.errorCode=e.code;
        const stageErrors={review:'复盘未完成，已保留诊断和已完成的搜索结果。',prepare:'准备对局失败，请查看下方原因。',shortlist:'AI 初筛未完成。',search:'Forge 搜索未完成。',quality:'AI 二筛未完成，搜索结果已保留。'};
        progress(job,'failed',deckMessages[job.errorCode]||stageErrors[job.type]||'分支没有通过检查，未发布未经验证的回放。');
      }
    }finally{await save(job);}
  }
  async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>36*1024*1024)throw Error('请求体过大。');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  const staticFiles=new Set(['index.html','style.css','replay.js','engine.js','branch.js','app.js','studio.js']);
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
    try{
      const host=req.headers.host;if(!['127.0.0.1:'+server.address().port,'localhost:'+server.address().port].includes(host))return apiError(res,403,'仅允许本机访问。');
      const url=new URL(req.url,'http://'+host),parts=url.pathname.split('/').filter(Boolean);
      if(url.pathname.startsWith('/api/')){
        if(!req.headers.cookie?.split(';').some(c=>c.trim()==='endstep_session='+session))return apiError(res,401,'请从应用首页打开。');
        if(!['GET','HEAD'].includes(req.method)&&((req.headers.origin&&req.headers.origin!=='http://'+host)||req.headers['x-endstep-request']!=='1'))return apiError(res,403,'请求来源无效。');
        if(req.method==='GET'&&url.pathname==='/api/health'){try{return json(res,{...(await codex.status()),forge:await forge.status(),version,mode:'forge-search'});}catch(e){return json(res,{connected:false,loggedIn:false,error:e.message,mode:'connected'});}}
        if(req.method==='GET'&&url.pathname==='/api/current'){const r=replays.get(currentId);return json(res,r?{id:r.id,filename:r.filename,jsonl:r.model.sourceText,review:r.review,evidence:r.searchEvidence||[],deckProfiles:publicDeckProfile(r.matchDecks),jobs:[...jobs.values()].filter(j=>j.replayId===r.id).map(snapshot)}:null);}
        if(req.method==='POST'&&url.pathname==='/api/replays'){const b=await body(req);if(typeof b.jsonl!=='string'||typeof b.filename!=='string')throw Error('回放输入格式无效。');const r=await register(b.jsonl,b.filename);return json(res,{id:r.id,review:r.review,evidence:r.searchEvidence||[],deckProfiles:publicDeckProfile(r.matchDecks)});}
        if(req.method==='GET'&&parts[1]==='replays'&&parts[3]==='branch-start'&&parts.length===4){
          const replay=replays.get(parts[2]),line=Number(url.searchParams.get('line'));
          if(!replay||!Number.isSafeInteger(line)||line<1)return apiError(res,400,'请选择已导入回放中的具体操作。');
          return json(res,await checkBranchStart(replay,line,{findEarlier:true}));
        }
        if(req.method==='POST'&&url.pathname==='/api/jobs'){
          const b=await body(req),r=replays.get(b.replayId);if(!r||!['review','prepare','shortlist','plan','search','branch','quality'].includes(b.type))throw Error('请选择已导入的对局和有效任务。');
          const nodeJob=['plan','search','branch'].includes(b.type),profileJob=['review','prepare'].includes(b.type);
          let parent;
          if(b.type==='quality'){
            parent=jobs.get(b.parentJobId);
            if(!parent||parent.replayId!==r.id||parent.type!=='search'||parent.status!=='complete'||!parent.result?.searchSummary?.winningCandidates)return apiError(res,409,'请选择这份回放中已完成且有胜局候选的搜索。');
          }
          const sourceLine=parent?.sourceLine||(nodeJob?b.sourceLine:null);
          if(nodeJob&&!Number.isInteger(sourceLine))throw Error('请选择战报中的具体操作。');
          const focus=parent?.intent||String(b.focus||'').slice(0,4000),stressCards=parent?.stressCards||(nodeJob?readStressCards(b.stressCards):[]);
          if(nodeJob&&!runners.branch){
            if(!r.review&&!focus.trim())return apiError(res,409,'请先输入你想重演的打法。');
            const profiles=r.matchDecks;
            const checked=await checkBranchStart(r,sourceLine);
            if(checked.status!=='ready')return apiError(res,409,checked.reason);
            if(r.matchDecks!==profiles)return apiError(res,409,'牌表已更新，请重新选择节点并核对分支起点。');
          }
          const reviewOptions=b.type==='review'?readReviewOptions(b.reviewOptions):undefined;
          const manualSideboard=profileJob&&b.manualSideboard!=null?readManualSideboard(b.manualSideboard):undefined;
          const running=[...jobs.values()].filter(j=>j.status==='running');
          const existing=running.find(j=>j.replayId===r.id&&j.type===b.type&&j.sourceLine===sourceLine&&j.parentJobId===(parent?.id||null)&&JSON.stringify(j.reviewOptions)===JSON.stringify(reviewOptions)&&JSON.stringify(j.manualSideboard)===JSON.stringify(manualSideboard)&&(profileJob||j.intent===focus&&JSON.stringify(j.stressCards||[])===JSON.stringify(stressCards)));if(existing)return json(res,snapshot(existing));
          if(profileJob&&running.some(j=>j.replayId===r.id&&['review','prepare'].includes(j.type)))return apiError(res,409,'这个对局正在更新牌表，请稍后再试。');
          if([...jobs.values()].filter(j=>j.status==='running').length>=2)return apiError(res,429,'已有两个任务正在执行，请稍后再试。');
          if(nodeJob)Scenario.sourceAt(r.model.sourceText,sourceLine);
          const deckPreferences=profileJob?readDeckPreferences(b.deckPreferences):null;
          const id=crypto.randomUUID(),job={id,replayId:r.id,type:b.type,sourceLine,parentJobId:parent?.id||null,intent:focus,stressCards,deckPreferences,reviewOptions,manualSideboard,forceReview:b.type==='review'&&!!r.review,status:'running',phase:'queued',message:'任务已提交。',createdAt:Date.now(),events:[],dir:path.join(dataDir,'jobs',id),abort:new AbortController()};
          jobs.set(id,job);try{await fs.mkdir(job.dir,{recursive:true});}catch(error){jobs.delete(id);throw error;}
          run(job,r,job.intent);return json(res,snapshot(job));
        }
        if(parts[1]==='jobs'&&jobs.has(parts[2])){
          const job=jobs.get(parts[2]);if(req.method==='DELETE'){if(job.status==='running')job.abort.abort();return json(res,snapshot(job));}
          if(req.method==='GET'&&parts.length===3)return json(res,snapshot(job));
          if(req.method==='GET'&&parts[3]==='nodes'&&/^\d+$/.test(parts[4]||'')&&parts[5]==='replay'&&parts.length===6){
            const line=Number(parts[4]),evidence=job.result?.evidence?.find(e=>e.sourceLine===line);
            if(job.status!=='complete'||!Number.isSafeInteger(line)||!evidence?.quality?.keep||evidence.downloadUrl!==url.pathname)return apiError(res,409,'此节点没有保留的改进胜局。');
            const file=await fs.readFile(path.join(job.dir,'search','node-'+line+'.esreplay'));res.writeHead(200,{'Content-Type':'application/gzip','Content-Disposition':'attachment; filename="recommended-node-'+line+'.esreplay"'});return res.end(file);
          }
          if(req.method==='GET'&&['replay','jsonl'].includes(parts[3])){
            if(job.status!=='complete'||!job.result?.downloadUrl||!job.result?.quality?.keep)return apiError(res,409,'尚无通过胜负与AI二筛的指导回放。');
            const file=await fs.readFile(path.join(job.dir,'recommended.esreplay'));
            if(parts[3]==='replay'){res.writeHead(200,{'Content-Type':'application/gzip','Content-Disposition':'attachment; filename="recommended.esreplay"'});return res.end(file);}
            res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});return res.end(zlib.gunzipSync(file));
          }
        }
        return apiError(res,404,'接口不存在。');
      }
      const name=url.pathname==='/'?'index.html':url.pathname.slice(1);if(req.method!=='GET'||!staticFiles.has(name))return apiError(res,404,'页面不存在。');
      if(name==='index.html')res.setHeader('Set-Cookie',`endstep_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
      const data=await fs.readFile(path.join(__dirname,name));res.writeHead(200,{'Content-Type':name.endsWith('.css')?'text/css; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8'});res.end(data);
    }catch(e){if(!res.headersSent)apiError(res,400,e.message);else res.end();}
  });
  return{server,codex,forge,jobs,replays,async start(){
    await fs.mkdir(runtime,{recursive:true});
    if(initialReplay){let raw=await fs.readFile(initialReplay);if(raw[0]===31&&raw[1]===139)raw=zlib.gunzipSync(raw,{maxOutputLength:32*1024*1024});await register(raw.toString('utf8'),path.basename(initialReplay));}
    else try{const current=JSON.parse(await fs.readFile(path.join(dataDir,'current.json'),'utf8'));if(/^[a-f0-9]{64}$/.test(current.id)){const raw=zlib.gunzipSync(await fs.readFile(path.join(dataDir,'replays',current.id+'.jsonl.gz')),{maxOutputLength:32*1024*1024});await register(raw.toString('utf8'),current.filename);}}catch{}
    let directories=[];try{directories=await fs.readdir(path.join(dataDir,'jobs'));}catch{}
    for(const id of directories){if(!/^[a-f0-9-]{36}$/.test(id))continue;try{const stored=JSON.parse(await fs.readFile(path.join(dataDir,'jobs',id,'job.json'),'utf8'));if(stored.id!==id)continue;const job={...stored,dir:path.join(dataDir,'jobs',id),abort:new AbortController()};if(job.status==='running'){job.status='failed';job.phase='interrupted';job.message='后端已重新启动，上次任务已中断，可以重新提交。';job.error='任务没有继续执行，未发布未经检查的新回放。';}jobs.set(id,job);await save(job);}catch{}}
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return'http://127.0.0.1:'+server.address().port;
  },async close(){for(const job of jobs.values())job.abort.abort();codex.close();forge.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
if(require.main===module){const studio=createStudio({port:Number(process.env.PORT)||8787,initialReplay:process.argv[2]||null});studio.start().then(url=>console.log('Endstep Studio: '+url)).catch(e=>{console.error(e.message);process.exitCode=1;});for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>studio.close().finally(()=>process.exit()));}
module.exports={createStudio};
