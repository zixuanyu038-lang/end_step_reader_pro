'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {createInterface}=require('node:readline');
const {baseEngine,readForgeSelection}=require('./forge-runtime');
const execute=promisify(execFile);
class ForgeClient {
  constructor({runtimeDir=process.env.ENDSTEP_FORGE_RUNTIME||path.join(process.env.LOCALAPPDATA||process.env.HOME||'.','EndstepForgeProbe'),dataDir=path.join(__dirname,'.endstep-data'),timeoutMs=180000,release=readForgeSelection(dataDir)}={}){
    this.runtimeDir=runtimeDir;this.dataDir=dataDir;this.timeoutMs=timeoutMs;this.sequence=0;this.pending=new Map();this.queue=Promise.resolve();this.closed=false;
    this.java=path.join(runtimeDir,'jdk','jdk-17.0.20.1+1','bin','java.exe');
    this.javac=path.join(runtimeDir,'jdk','jdk-17.0.20.1+1','bin','javac.exe');
    this.engine=release?.engine||baseEngine;
    this.cacheKey=release?this.engine+'-'+release.sha256:null;
    this.forgeDir=release?.forgeDir||path.join(runtimeDir,'forge');
    this.jar=path.join(this.forgeDir,'forge-gui-desktop-'+this.engine.slice(6)+'-jar-with-dependencies.jar');
    this.classes=path.join(dataDir,'forge-classes',...(this.cacheKey?[this.cacheKey]:[]));
  }
  async status(){
    const exists=async file=>{try{await fs.access(file);return true;}catch{return false;}};
    return{engine:this.engine,installed:(await exists(this.java))&&(await exists(this.jar)),connected:!!this.process&&!this.process.killed,mode:'root-path-replay',error:this.lastError||null};
  }
  async connect(){
    if(this.connection)return this.connection;
    this.connection=this.start().catch(e=>{this.connection=null;this.lastError=e.message;throw e;});return this.connection;
  }
  async start(){
    if(this.closed)throw Error('Forge 执行器已关闭。');
    const status=await this.status();if(!status.installed)throw Error('Forge 运行环境尚未准备，请先运行 Forge 安装步骤。');
    await fs.mkdir(this.classes,{recursive:true});
    const source=path.join(__dirname,'forge','EngineWorker.java');
    const digest=crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex');
    let compiled='';try{compiled=await fs.readFile(path.join(this.classes,'source.sha256'),'utf8');}catch{}
    if(compiled!==digest){
      try{await execute(this.javac,['-encoding','UTF-8','-cp',this.jar,'-d',this.classes,source],{windowsHide:true,timeout:60000,maxBuffer:2*1024*1024});}
      catch(e){throw Error('Forge 适配器编译失败：'+String(e.stderr||e.message).slice(0,4000));}
      await fs.writeFile(path.join(this.classes,'source.sha256'),digest);
    }
    const profile=path.join(this.forgeDir,'forge.profile.properties');
    try{await fs.writeFile(profile,'userDir=./probe-user\ncacheDir=./probe-cache\n',{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
    const child=spawn(this.java,['-Xmx3g','-Djava.awt.headless=true','-Dfile.encoding=UTF-8','-cp',this.classes+path.delimiter+this.jar,'EngineWorker',this.engine],{cwd:this.forgeDir,windowsHide:true,stdio:['pipe','pipe','pipe']});this.process=child;
    const logDir=path.join(this.dataDir,'forge');await fs.mkdir(logDir,{recursive:true});
    this.logFile=path.join(logDir,'worker.log');
    child.stderr.on('data',b=>fs.appendFile(this.logFile,b).catch(()=>{}));child.stdin.on('error',()=>{});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill();reject(Error('Forge 牌库初始化超时。'));},90000);
      createInterface({input:child.stdout}).on('line',line=>{
        let message;try{message=JSON.parse(line);}catch{return;}
        if(message.ready){clearTimeout(timer);this.rules=message.rules;resolve();return;}
        const p=this.pending.get(message.id);if(!p)return;this.pending.delete(message.id);clearTimeout(p.timer);
        if(message.ok)p.resolve({...message.result,engine:this.engine});
        else{
          const error=Error('Forge：'+message.error);
          if(typeof message.error==='string'&&message.error.startsWith('InvalidAction:'))error.code='forge_root_invalid';
          p.reject(error);
        }
      });
      child.once('error',e=>{clearTimeout(timer);reject(e);if(this.process===child)this.fail(e);});
      child.once('exit',()=>{clearTimeout(timer);const error=Error('Forge 工作进程已结束。');reject(error);if(this.process===child)this.fail(error);});
    });
    this.lastError=null;return this;
  }
  fail(error){this.connection=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
  async request(input,{signal}={}){
    const operation=async()=>{
      if(signal?.aborted)throw Error('任务已取消。');await this.connect();
      return new Promise((resolve,reject)=>{
        const id=++this.sequence;
        const finish=(fn,value)=>{signal?.removeEventListener('abort',abort);fn(value);};
        const abort=()=>{this.process?.kill();this.fail(Error('Forge 搜索已取消。'));};
        const timer=setTimeout(()=>{this.process?.kill();this.fail(Error('Forge 单次模拟超时，未发布结果。'));},this.timeoutMs);
        this.pending.set(id,{timer,resolve:value=>finish(resolve,value),reject:error=>finish(reject,error)});
        signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted){abort();return;}
        this.process.stdin.write(JSON.stringify({...input,id})+'\n');
      });
    };
    const task=this.queue.then(operation,operation);this.queue=task.catch(()=>{});return task;
  }
  close(){this.closed=true;this.process?.kill();this.fail(Error('Forge 执行器已关闭。'));}
}
module.exports={ForgeClient};
