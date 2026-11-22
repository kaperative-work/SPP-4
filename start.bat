@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 18+ is required: https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules call npm install
if errorlevel 1 (
  pause
  exit /b 1
)
node server\index.js
