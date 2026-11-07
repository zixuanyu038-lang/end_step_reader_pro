@echo off
chcp 65001 >nul
if /i "%~1"=="rollback" (
  node "%~dp0forge\update-runtime.cjs" rollback
) else if "%~1"=="" (
  echo 请把下载好的官方 forge-installer-版本.tar.bz2 拖到本文件。
  echo 回退时在终端运行 更新Forge.cmd rollback
) else (
  node "%~dp0forge\update-runtime.cjs" install "%~f1"
)
pause
