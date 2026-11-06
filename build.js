// No dependencies; builds a single HTML file that also works from file://.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const R=require('./replay.js');
let html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
html=html.replace('<link rel="stylesheet" href="style.css">',()=>'<style>'+fs.readFileSync(path.join(__dirname,'style.css'),'utf8')+'</style>');
for(const file of ['replay.js','engine.js','branch.js','app.js','studio.js'])html=html.replace(`<script src="${file}"></script>`,()=>'<script>'+fs.readFileSync(path.join(__dirname,file),'utf8').replace(/<\/script/gi,'<\\/script')+'</script>');
fs.mkdirSync(path.join(__dirname,'dist'),{recursive:true});
fs.writeFileSync(path.join(__dirname,'dist','Endstep对局档案.html'),html);
if(process.argv[2]){
  const file=process.argv[2];let b=fs.readFileSync(file);if(b[0]===31&&b[1]===139)b=zlib.gunzipSync(b);
  const model=R.parse(b.toString('utf8'),path.basename(file));
  const json=JSON.stringify(model).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
  fs.writeFileSync(path.join(__dirname,'dist','vs-Mirenu-战报.html'),html.replace('<body>',()=>'<body>\n<script type="application/json" id="embedded-replay">'+json+'</script>'));
  fs.writeFileSync(path.join(__dirname,'dist','vs-Mirenu-战报.md'),R.markdown(model));
  fs.writeFileSync(path.join(__dirname,'dist','vs-Mirenu-原始.jsonl'),b);
  console.log(JSON.stringify({games:new Set(model.turns.map(t=>t.game)).size,turns:model.turns.length,events:model.eventCount,states:model.states.length,cards:Object.keys(model.cards).length,score:model.finalScore,warnings:model.warnings},null,2));
}
console.log('Built offline HTML in '+path.join(__dirname,'dist'));
