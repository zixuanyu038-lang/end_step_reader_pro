const fs=require('node:fs'),zlib=require('node:zlib'),B=require('./branch');
(async()=>{
 const [source,plan,target]=process.argv.slice(2);if(!source||!plan||!target)throw Error('用法：node branch-cli.js 原回放.esreplay branch.json 输出.esreplay');
 let raw=fs.readFileSync(source);if(raw[0]===31&&raw[1]===139)raw=zlib.gunzipSync(raw);
 const result=await B.compile(raw.toString('utf8'),fs.readFileSync(plan,'utf8'));
 const compressed=zlib.gzipSync(Buffer.from(result.jsonl,'utf8'));if(compressed.length>16*1024*1024)throw Error('输出超过 Endstep 已验证的 16 MB 压缩上限。');
 fs.writeFileSync(target,compressed);
 console.log(JSON.stringify({output:target,steps:result.stepCount,stopped:result.stopped||result.data.stop},null,2));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
