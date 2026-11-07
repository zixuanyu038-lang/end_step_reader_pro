param([string]$NodeExe = 'node', [string]$RuntimeDir = (Join-Path $env:LOCALAPPDATA 'EndstepForgeProbe'))
$ErrorActionPreference = 'Stop'
$env:ENDSTEP_FORGE_RUNTIME = $RuntimeDir
& $NodeExe (Join-Path $PSScriptRoot 'download-runtime.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Official runtime download or checksum verification failed' }
$javaExe = Join-Path $runtimeDir 'jdk\jdk-17.0.20.1+1\bin\java.exe'
if (-not (Test-Path -LiteralPath $javaExe)) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $jdkTarget = Join-Path $runtimeDir 'jdk'
  $jdkStage = Join-Path $runtimeDir ('jdk.stage-' + [Guid]::NewGuid().ToString('N'))
  try {
    [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $runtimeDir 'jdk.zip'), $jdkStage)
    if (Test-Path -LiteralPath $jdkTarget) { throw 'Java installation directory is incomplete. Remove or repair it before retrying.' }
    Move-Item -LiteralPath $jdkStage -Destination $jdkTarget
  } finally {
    if (Test-Path -LiteralPath $jdkStage) { Remove-Item -LiteralPath $jdkStage -Recurse -Force }
  }
}
$forgeDir = Join-Path $runtimeDir 'forge'
$stamp = Join-Path $forgeDir '.probe-extraction-complete'
if (-not (Test-Path -LiteralPath $stamp)) {
  New-Item -ItemType Directory -Path $forgeDir -Force | Out-Null
  & tar -xf (Join-Path $runtimeDir 'forge-2.0.15.tar.bz2') -C $forgeDir
  if ($LASTEXITCODE -ne 0) { throw 'Forge archive extraction failed' }
  'forge-2.0.15' | Set-Content -LiteralPath $stamp -Encoding ASCII
}
Write-Host 'Endstep Studio: portable Forge 2.0.15 runtime is ready.'
