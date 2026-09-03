@echo off
REM AWB Workbench 启动脚本（Windows）
REM 用法：start.bat [--no-browser]
setlocal

cd /d "%~dp0"

REM 检查 Node
where node >nul 2>&1
if errorlevel 1 (
  echo [error] Node.js not found. Please install Node 22+.
  exit /b 1
)

echo [awb] Starting workbench on http://127.0.0.1:7788 ...
echo [awb] Press Ctrl+C to stop.
echo.

node awb.mjs serve %*
