param([string]$Replay,[switch]$Restart)
$ErrorActionPreference='Stop'
$taskRoot=$PSScriptRoot
$taskData=Join-Path $taskRoot '.endstep-data'
New-Item -ItemType Directory -Path $taskData -Force | Out-Null
$taskUrl='http://127.0.0.1:8787'
$taskPageVerified=$false
try {
  $taskPage=Invoke-WebRequest -UseBasicParsing -Uri $taskUrl -TimeoutSec 2 -SessionVariable taskSession
  if($taskPage.Content -notlike '*id="studio-panel"*'){throw '8787 端口被其他程序占用。'}
  $taskPageVerified=$true
  if(-not $Restart){Write-Output "Endstep Studio 已启动：$taskUrl";exit 0}
  $taskCurrent=Invoke-RestMethod -Uri ($taskUrl+'/api/current') -WebSession $taskSession -TimeoutSec 5
  if(@($taskCurrent.jobs | Where-Object { $_.status -eq 'running' }).Count){throw '还有任务正在运行。请先等任务完成，或在页面中停止任务，再重启。'}
  $taskPidFile=Join-Path $taskData 'server.pid'
  if(-not (Test-Path -LiteralPath $taskPidFile)){throw '无法核对旧服务进程，请从原启动终端停止服务。'}
  $taskServerPid=[int](Get-Content -LiteralPath $taskPidFile -Raw)
  $taskProcessInfo=Get-CimInstance Win32_Process -Filter ("ProcessId="+$taskServerPid)
  $taskListeningPid=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8787 -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess)
  $taskServerFile=Join-Path $taskRoot 'studio-server.js'
  if(-not $taskProcessInfo -or $taskServerPid -notin $taskListeningPid -or $taskProcessInfo.Name -ne 'node.exe' -or $taskProcessInfo.CommandLine -notmatch [regex]::Escape($taskServerFile)){throw '旧进程与当前安装路径或端口不一致，未停止其他进程。'}
  $taskChildProcesses=@(Get-CimInstance Win32_Process -Filter ("ParentProcessId="+$taskServerPid) | Where-Object { $_.Name -in @('java.exe','codex.exe') })
  Stop-Process -Id $taskServerPid -ErrorAction Stop
  foreach($taskChildProcess in $taskChildProcesses){Stop-Process -Id $taskChildProcess.ProcessId -ErrorAction SilentlyContinue}
  Write-Output '旧服务已停止，正在加载更新。'
} catch {
  if($taskPageVerified -or $_.Exception.Message -like '*其他程序*'){throw}
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
