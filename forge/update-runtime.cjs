'use strict';

const fs=require('node:fs/promises');
const {createReadStream}=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {ForgeClient}=require('../forge-client');
const {engineTag,selectionFile,updatesDir}=require('../forge-runtime');
const {checkForgeRuntime}=require('./self-test.cjs');
const execute=promisify(execFile);

async function unpackForge(archive,directory,jar){
  await execute('tar.exe',['-xf',archive,'-C',directory,'--exclude','res/adventure','--exclude','res/music','res',jar,'LICENSE.txt'],
    {windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});
}

async function verifyForge({engine,forgeDir,sha256,runtimeDir}){
  const client=new ForgeClient({runtimeDir,dataDir:path.join(forgeDir,'.verify'),release:{engine,forgeDir,sha256}});
  try{await checkForgeRuntime(client);}
  finally{client.close();}
}

async function stageForgeRelease({archive,dataDir,runtimeDir,fetchImpl=fetch,unpack=unpackForge,verify=verifyForge}){
  const name=path.basename(archive);
  const engine=name.replace(/^forge-installer-([0-9]+\.[0-9]+\.[0-9]+)\.tar\.bz2$/,'forge-$1');
  if(!engineTag.test(engine)||name!=='forge-installer-'+engine.slice(6)+'.tar.bz2')throw Error('请选择官方正式版 forge-installer-版本.tar.bz2。');
  const url='https://api.github.com/repos/Card-Forge/forge/releases/tags/'+engine;
  let release;
  try{
    const response=await fetchImpl(url,{signal:AbortSignal.timeout(8000),redirect:'error',
      headers:{Accept:'application/vnd.github+json','User-Agent':'Endstep-Forge-Update'}});
    if(!response.ok)throw Error('GitHub HTTP '+response.status);
    release=await response.json();
  }catch(error){throw Error('无法核对 Forge 官方发布，请检查网络后重试。'+error.message);}
  const asset=release.assets?.find(item=>item.name===name);
  if(release.tag_name!==engine||release.draft!==false||release.prerelease!==false||!/^sha256:[a-f0-9]{64}$/i.test(asset?.digest)){
    throw Error('没有找到带 SHA-256 的官方正式版安装包。');
  }
  const sha256=asset.digest.slice(7).toLowerCase();
  const parent=path.resolve(updatesDir(dataDir));
  await fs.mkdir(parent,{recursive:true});
  const stage=await fs.mkdtemp(path.join(parent,engine+'-'));
  const temp=path.join(dataDir,'forge-selection-'+crypto.randomUUID()+'.tmp');
  try{
    const copy=path.join(stage,name);
    await fs.copyFile(archive,copy);
    const hash=crypto.createHash('sha256');
    for await(const chunk of createReadStream(copy))hash.update(chunk);
    if((await fs.stat(copy)).size!==asset.size||hash.digest('hex')!==sha256)throw Error('安装包与官方 SHA-256 不符。');
    const jar='forge-gui-desktop-'+engine.slice(6)+'-jar-with-dependencies.jar';
    await unpack(copy,stage,jar);
    await fs.rm(copy);
    await verify({engine,forgeDir:stage,sha256,runtimeDir});
    await fs.writeFile(temp,JSON.stringify({engine,folder:path.basename(stage),sha256}));
    await fs.rename(temp,selectionFile(dataDir));
    return engine;
  }catch(error){
    if(path.dirname(stage)===parent&&path.basename(stage).startsWith(engine+'-')){
      await fs.rm(stage,{recursive:true,force:true}).catch(()=>{});
    }
    throw error;
  }finally{await fs.rm(temp,{force:true}).catch(()=>{});}
}

async function main(){
  const [command,archive,data=path.join(__dirname,'..','.endstep-data')]=process.argv.slice(2);
  const dataDir=path.resolve(data);
  if(command==='rollback'){
    await fs.rm(selectionFile(path.resolve(archive||data)),{force:true});
    console.log('已选择随软件提供的 Forge。下次启动生效。');
    return;
  }
  if(command!=='install'||!archive)throw Error('用法：update-runtime.cjs install <官方 tar.bz2> [数据目录]，或 rollback [数据目录]。');
  console.log('正在核对官方安装包并检查 Forge 兼容性…');
  const engine=await stageForgeRelease({archive:path.resolve(archive),dataDir});
  console.log(engine+' 已通过自检。下次启动生效。');
}

if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={stageForgeRelease};
