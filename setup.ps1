$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'download-runtime.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Official runtime download or checksum verification failed' }
$runtimeDir = Join-Path $env:LOCALAPPDATA 'EndstepForgeProbe'
$javaExe = Join-Path $runtimeDir 'jdk\jdk-17.0.20.1+1\bin\java.exe'
if (-not (Test-Path -LiteralPath $javaExe)) {
  Expand-Archive -LiteralPath (Join-Path $runtimeDir 'jdk.zip') -DestinationPath (Join-Path $runtimeDir 'jdk') -Force
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
