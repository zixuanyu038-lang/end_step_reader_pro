'use strict';

const latestApi='https://api.github.com/repos/Card-Forge/forge/releases/latest';
const releasesPage='https://github.com/Card-Forge/forge/releases';
const versionParts=tag=>typeof tag==='string'&&/^forge-(\d+)\.(\d+)\.(\d+)$/.exec(tag)?.slice(1).map(Number);

async function checkForgeRelease(forge,{fetchImpl=fetch,timeoutMs=2500}={}){
  const controller=new AbortController();
  let timer,current;
  const deadline=new Promise((_,reject)=>{
    timer=setTimeout(()=>{
      controller.abort();
      reject(Error('Forge release check timed out'));
    },timeoutMs);
  });
  const readRelease=async()=>{
    const {engine,installed}=await forge.status();
    current=engine;
    if(!installed)return {state:'not_installed',current};
    const currentParts=versionParts(current);
    if(!currentParts)return {state:'unavailable',current};
    controller.signal.throwIfAborted();
    const response=await fetchImpl(latestApi,{signal:controller.signal,redirect:'error',
      headers:{Accept:'application/vnd.github+json','User-Agent':'Endstep-Forge-Check'}});
    if(!response.ok)throw Error('Forge release metadata is unavailable');
    const {tag_name:latest,draft,prerelease}=await response.json();
    const latestParts=versionParts(latest);
    if(!latestParts||draft!==false||prerelease!==false)return {state:'unavailable',current};
    const difference=latestParts.map((part,i)=>part-currentParts[i]).find(part=>part!==0)??0;
    return {state:difference>0?'update':'current',current,latest,url:releasesPage+'/tag/'+latest};
  };
  try{return await Promise.race([readRelease(),deadline]);}
  catch{return {state:'unavailable',current};}
  finally{clearTimeout(timer);}
}

module.exports={checkForgeRelease};
