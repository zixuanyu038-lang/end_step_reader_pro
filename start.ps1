param([string]$Replay)
$ErrorActionPreference='Stop'
$taskRoot=$PSScriptRoot
$taskData=Join-Path $taskRoot '.endstep-data'
New-Item -ItemType Directory -Path $taskData -Force | Out-Null
$taskUrl='http://127.0.0.1:8787'
try {
  $taskPage=Invoke-WebRequest -UseBasicParsing -Uri $taskUrl -TimeoutSec 2
  if($taskPage.Content -notlike '*id="studio-panel"*'){throw '8787 端口被其他程序占用。'}
  Write-Output "Endstep Studio 已启动：$taskUrl"
  exit 0
} catch {
  if($_.Exception.Message -like '*其他程序*'){throw}
}
$taskNode=(Get-Command node -ErrorAction Stop).Source
$taskArgs=@(('"'+(Join-Path $taskRoot 'studio-server.js')+'"'))
if($Replay){$taskReplay=(Resolve-Path -LiteralPath $Replay).Path;$taskArgs+=('"'+$taskReplay+'"')}
$taskProcess=Start-Process -FilePath $taskNode -ArgumentList $taskArgs -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskData 'server.log') -RedirectStandardError (Join-Path $taskData 'server-error.log')
Set-Content -LiteralPath (Join-Path $taskData 'server.pid') -Value $taskProcess.Id
for($taskAttempt=0;$taskAttempt -lt 30;$taskAttempt++){
  try{$taskReady=Invoke-WebRequest -UseBasicParsing -Uri $taskUrl -TimeoutSec 1;if($taskReady.StatusCode -eq 200){Write-Output "Endstep Studio：$taskUrl";Write-Output '在 Codex 对话中说“把这个地址打开在右侧面板”。';exit 0}}catch{Start-Sleep -Milliseconds 300}
}
throw '启动失败，请查看 .endstep-data/server-error.log。'
