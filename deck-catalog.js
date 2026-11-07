'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {version}=require('./package.json');
const REPOSITORY='modometa/modometa-mtgo-data',API='https://api.github.com/repos/'+REPOSITORY;
const MATCH_REFERENCE_SIZE_TOLERANCE=3;
const digest=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const name=value=>String(value||'').trim().replace(/\s+/g,' ').replace(/’/g,"'");
function cards(rows){
  if(!Array.isArray(rows))throw Error('牌表区域缺失。');const counts=new Map();
  for(const row of rows){const card=name(row.name??row.CardName),count=row.count??row.Count;if(!card||card.length>180||!Number.isSafeInteger(count)||count<1||count>150)throw Error('牌表实体或数量无效。');counts.set(card,(counts.get(card)||0)+count);}
  return[...counts].sort(([a],[b])=>a.localeCompare(b)).map(([name,count])=>({name,count}));
}
function normalizeDeck(deck){
  const main=cards(deck.main),sideboard=cards(deck.sideboard),total=main.reduce((n,c)=>n+c.count,0),side=sideboard.reduce((n,c)=>n+c.count,0);
  if(total<60||total>150||side>15||!/^https:\/\/www\.mtgo\.com\/decklist\//.test(deck.url||'')||!/^\d{4}-\d{2}-\d{2}$/.test(deck.date||''))throw Error('不是可核对的构筑赛事牌表。');
  if(!/^[a-f0-9]{64}$/.test(deck.sourceSha256||''))throw Error('牌表缺少来源哈希。');
  const id=digest({format:deck.format,main,sideboard});return{...deck,id,main,sideboard};
}
function rankCandidates(decks,facts,{format='Legacy',initialSize=null,global=true,limit=8,asOf=null}={}){
  if(facts.length<3)return[];
  const pool=decks.filter(d=>d.format.toLowerCase()===format.toLowerCase()&&(!asOf||d.date<=asOf)).map(deck=>({deck,sizeDelta:initialSize?Math.abs(deck.main.reduce((n,c)=>n+c.count,0)-initialSize):0}))
    .filter(({sizeDelta})=>sizeDelta<=(global?MATCH_REFERENCE_SIZE_TOLERANCE:0));
  const frequency=new Map();for(const {deck} of pool)for(const c of deck.main.concat(deck.sideboard))frequency.set(c.name,(frequency.get(c.name)||0)+1);
  const weighted=facts.map(c=>({...c,name:name(c.name),weight:1+Math.log(1+pool.length/((frequency.get(name(c.name))||0)+1))}));
  const denominator=weighted.reduce((n,c)=>n+c.weight*c.count,0);
  return pool.map(({deck,sizeDelta})=>{
    const counts=new Map();for(const c of deck.main.concat(global?deck.sideboard:[]))counts.set(c.name,(counts.get(c.name)||0)+c.count);
    const missing=weighted.filter(c=>(counts.get(c.name)||0)<c.count).map(c=>({name:c.name,count:c.count-(counts.get(c.name)||0)}));
    const coverage=weighted.reduce((n,c)=>n+c.weight*Math.min(c.count,counts.get(c.name)||0),0)/denominator;
    // Unseen cards are unknown, never negative evidence against a candidate.
    return{deck,coverage,missing,score:coverage+(missing.length===0?.01:0)-.02*sizeDelta};
  }).filter(c=>c.coverage>=.7).sort((a,b)=>b.score-a.score||b.deck.date.localeCompare(a.deck.date)||a.deck.id.localeCompare(b.deck.id)).slice(0,limit);
}
class DeckCatalog{
  constructor({file,bundledFile=path.join(__dirname,'data','deck-catalog.json')}={}){this.file=file;this.bundledFile=bundledFile;}
  async load(){
    const unique=new Map();
    for(const file of [this.bundledFile,this.file].filter(Boolean))try{
      const snapshot=JSON.parse(await fs.readFile(file,'utf8'));if(snapshot.version!==1||snapshot.sha256!==digest(snapshot.decks))continue;
      for(const raw of snapshot.decks){try{const deck=normalizeDeck(raw),previous=unique.get(deck.id);if(!previous||deck.date>previous.date)unique.set(deck.id,deck);}catch{}}
    }catch{}
    return[...unique.values()];
  }
  async find(facts,options){
    const decks=await this.load();
    if(options?.requireCatalog&&!decks.length)throw Error('本地牌表库无法读取或没有有效数据。');
    return rankCandidates(decks,facts,options);
  }
}
async function syncCatalog({output=path.join(__dirname,'.endstep-data','deck-catalog.json'),format='Legacy',maxFiles=20,months=2,now=new Date(),fetchImpl=fetch,signal,onProgress=()=>{}}={}){
  maxFiles=Math.max(1,Math.min(40,maxFiles));months=Math.max(1,Math.min(6,months));
  const json=async url=>{
    const response=await fetchImpl(url,{headers:{'User-Agent':'Endstep-Studio/'+version,'Accept':'application/vnd.github+json'},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('牌表库同步 HTTP '+response.status+(response.status===403||response.status===429?'（可能达到 GitHub 匿名请求限额，请稍后更新）':''));
    const body=await response.text();if(Buffer.byteLength(body)>8*1024*1024)throw Error('牌表库响应过大。');return JSON.parse(body);
  };
  const revision=(await json(API+'/commits/main')).sha;if(!/^[a-f0-9]{40}$/.test(revision))throw Error('牌表库版本无效。');
  const yearCache=new Map(),files=[];
  for(let offset=0;offset<months;offset++){
    const date=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-offset,1)),year=String(date.getUTCFullYear()),month=String(date.getUTCMonth()+1).padStart(2,'0');
    if(!yearCache.has(year))yearCache.set(year,await json(API+'/contents/Tournaments/MTGO/'+year+'?ref='+revision));
    const entry=yearCache.get(year).find(e=>e.name===month&&e.type==='dir');if(!entry)continue;
    const tree=await json(API+'/git/trees/'+entry.sha+'?recursive=1');if(tree.truncated)throw Error('牌表库月份目录被截断。');
    for(const f of tree.tree||[])if(f.type==='blob'&&new RegExp('^\\d{2}/'+format.toLowerCase()+'-[a-z0-9-]+\\.json$').test(f.path)&&f.size<4*1024*1024)files.push({...f,path:'Tournaments/MTGO/'+year+'/'+month+'/'+f.path});
  }
  const selected=files.sort((a,b)=>b.path.localeCompare(a.path)).slice(0,maxFiles);if(!selected.length)throw Error('当前时间范围没有该赛制牌表。');
  let next=0,completed=0;const gathered=[],errors=[];
  await Promise.all(Array.from({length:Math.min(4,selected.length)},async()=>{
    while(next<selected.length){const file=selected[next++];try{
      const blob=await json(API+'/git/blobs/'+file.sha);if(blob.encoding!=='base64'||typeof blob.content!=='string')throw Error('牌表库文件编码无效。');
      const bytes=Buffer.from(blob.content,'base64'),gitHash=crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');if(gitHash!==file.sha)throw Error('Git 文件哈希不一致。');
      const data=JSON.parse(bytes),tournament=data.Tournament||{},date=String(tournament.Date||'').slice(0,10),sourceSha256=crypto.createHash('sha256').update(bytes).digest('hex');
      for(const deck of data.Decks||[])try{
        const row=normalizeDeck({format,date,main:cards(deck.Mainboard),sideboard:cards(deck.Sideboard),url:deck.AnchorUri||tournament.Uri,event:tournament.Name||'',sourceSha256,sourceFile:'https://github.com/'+REPOSITORY+'/blob/'+revision+'/'+file.path});gathered.push(row);
      }catch{}
    }catch(e){if(signal?.aborted)throw e;errors.push({file:file.path,error:e.message});}
    onProgress('已同步 '+(++completed)+'/'+selected.length+' 份赛事文件');}
  }));
  const unique=new Map();for(const deck of gathered.sort((a,b)=>b.date.localeCompare(a.date)))if(!unique.has(deck.id))unique.set(deck.id,deck);
  const decks=[...unique.values()].sort((a,b)=>a.id.localeCompare(b.id));if(!decks.length)throw Error('未取得有效牌表：'+(errors[0]?.error||'文件缺少完整主备牌'));
  const snapshot={version:1,repository:REPOSITORY,revision,fetchedAt:new Date().toISOString(),format,sourceFiles:selected.length,errors,decks,sha256:digest(decks)};
  await fs.mkdir(path.dirname(output),{recursive:true});const temporary=output+'.tmp-'+crypto.randomUUID();await fs.writeFile(temporary,JSON.stringify(snapshot));await fs.rename(temporary,output);
  return{output,decks:decks.length,sourceFiles:selected.length,failedFiles:errors.length,revision};
}
if(require.main===module){const outputIndex=process.argv.indexOf('--output'),output=outputIndex>=0?path.resolve(process.argv[outputIndex+1]):undefined;syncCatalog({output,onProgress:message=>console.log(message)}).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});}
module.exports={DeckCatalog,rankCandidates,syncCatalog,normalizeDeck,MATCH_REFERENCE_SIZE_TOLERANCE};
