// Portable official runtimes only. Resumable range downloads, no global installation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.join(process.env.LOCALAPPDATA, 'EndstepForgeProbe');
const assets = [
  {name:'jdk.zip', size:190817615, api:'https://api.github.com/repos/adoptium/temurin17-binaries/releases/assets/527352161', sha256:'e53a79c3c3d86865bd7e787903884331068e71321714ffd44f145785affc7cb0', url:'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_windows_hotspot_17.0.20.1_1.zip'},
  {name:'forge-2.0.15.tar.bz2', size:297081149, api:'https://api.github.com/repos/Card-Forge/forge/releases/assets/596580864', sha256:'4468f182b60f6ca62d89697baa208981085af744f116781af751c611826db600', url:'https://github.com/Card-Forge/forge/releases/download/forge-2.0.15/forge-installer-2.0.15.tar.bz2'},
];
fs.mkdirSync(root,{recursive:true});
async function get(asset) {
  const target = path.join(root,asset.name);
  if(fs.existsSync(target)&&fs.statSync(target).size===asset.size) {
    const hash=crypto.createHash('sha256');for await(const b of fs.createReadStream(target))hash.update(b);
    if(hash.digest('hex')!==asset.sha256)throw Error('Existing archive checksum mismatch: '+asset.name);
    return console.log('Checksum verified:',asset.name);
  }
  const parts=path.join(root,asset.name+'.parts');fs.mkdirSync(parts,{recursive:true});
  const chunk=2*1024*1024;let next=0,done=0;
  const count=Math.ceil(asset.size/chunk);
  let url=asset.url;
  // Resolve a fresh official asset redirect once, rather than reconnecting to github.com for every part.
  const redirect=await fetch(asset.api,{redirect:'manual',headers:{'User-Agent':'Endstep-Forge-Probe',Accept:'application/octet-stream'},signal:AbortSignal.timeout(30000)});
  if(redirect.status===302&&redirect.headers.get('location'))url=redirect.headers.get('location');
  if(fs.existsSync(target+'.partial')){
    const fd=fs.openSync(target+'.partial','r');
    try{for(let i=0;i<Math.floor(fs.statSync(target+'.partial').size/chunk);i++){
      const part=path.join(parts,String(i));if(fs.existsSync(part))continue;
      const b=Buffer.alloc(chunk);fs.readSync(fd,b,0,chunk,i*chunk);fs.writeFileSync(part,b);
    }}finally{fs.closeSync(fd);}
  }
  await Promise.all(Array.from({length:12},async()=>{
    while(next<count){
      const index=next++,start=index*chunk,end=Math.min(asset.size,start+chunk)-1;
      const file=path.join(parts,String(index));
      if(!fs.existsSync(file)||fs.statSync(file).size!==end-start+1){
        for(let attempt=0;;attempt++){
          try{
            const r=await fetch(url,{headers:{Range:`bytes=${start}-${end}`},signal:AbortSignal.timeout(120000)});
            if(r.status!==206||r.headers.get('content-range')!==`bytes ${start}-${end}/${asset.size}`)throw Error('Unexpected range: '+r.status);
            const b=Buffer.from(await r.arrayBuffer());if(b.length!==end-start+1)throw Error('Truncated download');
            fs.writeFileSync(file,b);break;
          }catch(e){if(attempt>=4)throw e;}
        }
      }
      done++;if(done%10===0||done===count)console.log(asset.name,done+'/'+count);
    }
  }));
  const handle=fs.openSync(target+'.assembled','w');const hash=crypto.createHash('sha256');
  try{for(let i=0;i<count;i++){const b=fs.readFileSync(path.join(parts,String(i)));hash.update(b);fs.writeSync(handle,b);}}finally{fs.closeSync(handle);}
  const digest=hash.digest('hex');if(asset.sha256&&digest!==asset.sha256)throw Error('Checksum mismatch: '+asset.name);
  fs.renameSync(target+'.assembled',target);console.log(JSON.stringify({name:asset.name,bytes:asset.size,sha256:digest}));
}
Promise.allSettled(assets.map(get)).then(results=>{for(const r of results)if(r.status==='rejected'){console.error(r.reason);process.exitCode=1;}});
