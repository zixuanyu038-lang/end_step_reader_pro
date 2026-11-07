(() => {
  'use strict';
  const panel=document.getElementById('forge-version');
  if(!panel)return;
  if(location.protocol==='file:'){panel.hidden=true;return;}
  const label=document.getElementById('forge-version-label');
  const message=document.getElementById('forge-version-message');
  const button=document.getElementById('forge-version-check');
  const link=document.getElementById('forge-version-link');
  const releasesPage=link.href;
  const version=tag=>String(tag||'未知').replace(/^forge-/,'');
  let current;

  async function check(){
    button.disabled=true;
    message.textContent='正在查询 Forge 正式版…';
    link.href=releasesPage;
    try{
      const response=await fetch('/api/forge/version',{signal:AbortSignal.timeout(3500),cache:'no-store'});
      if(!response.ok)throw Error('Forge version check unavailable');
      const result=await response.json();
      current=result.current;
      if(result.state==='update'){
        label.textContent='Forge 有新版';
        message.textContent='当前 '+version(current)+'，上游正式版 '+version(result.latest)+'。请等当前任务完成后再更新软件的 Forge 运行环境。';
        link.href=result.url;
      }else if(result.state==='current'){
        label.textContent='Forge '+version(current);
        message.textContent='当前 '+version(current)+'，上游正式版 '+version(result.latest)+'。';
      }else if(result.state==='not_installed'){
        label.textContent='Forge 未安装';
        message.textContent='未检测到 Forge 运行环境，请按软件的安装说明准备。';
      }else{
        throw Error('Forge version check unavailable');
      }
    }catch{
      label.textContent=current?'Forge '+version(current):'Forge 引擎';
      message.textContent='暂时无法检查上游版本，可以继续使用本机引擎。';
    }finally{button.disabled=false;}
  }

  panel.hidden=false;
  button.addEventListener('click',check);
  void check();
})();
