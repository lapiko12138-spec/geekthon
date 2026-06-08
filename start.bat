@echo off
chcp 65001 >nul
setlocal

echo.
echo   🐱  麦麦桌宠 — 启动中
echo   ──────────────────────────────────────
echo.

set "DIR=%~dp0"
set "APP=%DIR%pet.exe"
set "LOGS=%DIR%.logs"

if not exist "%LOGS%" mkdir "%LOGS%"

REM ── 检查 pet.exe ──────────────────────────────────────────────────────────────
if not exist "%APP%" (
  echo   [错误] 找不到 pet.exe，请确认它和 start.bat 在同一目录
  pause
  exit /b 1
)
echo   [OK] pet.exe 已就绪

REM ── 检查 Node.js ──────────────────────────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
  echo   [注意] 未找到 Node.js，宠物动画正常但状态不会变化
  echo          可选安装：https://nodejs.org
  goto :open_app
)
echo   [OK] Node.js 已安装

REM ── 安装依赖（首次）──────────────────────────────────────────────────────────
if not exist "%DIR%node_modules" (
  echo   [->] 首次运行，安装依赖，约 30 秒...
  cd /d "%DIR%" && npm install --silent
  echo   [OK] 依赖安装完成
)

REM ── 检查端口 4100 ─────────────────────────────────────────────────────────────
netstat -ano | findstr ":4100 " >nul 2>&1
if %errorlevel% equ 0 (
  echo   [OK] 状态服务 :4100 已在运行
  goto :open_app
)

REM ── 启动状态服务 ──────────────────────────────────────────────────────────────
set "TSX=%DIR%node_modules\.bin\tsx.cmd"
if exist "%TSX%" (
  echo   [->] 启动状态服务 :4100 ...
  start /B "" "%TSX%" "%DIR%mock\server.ts" >> "%LOGS%\mock.log" 2>&1
  timeout /t 2 /nobreak >nul
  netstat -ano | findstr ":4100 " >nul 2>&1
  if %errorlevel% equ 0 (
    echo   [OK] 状态服务 :4100 已启动
  ) else (
    echo   [注意] 状态服务未能启动，查看 .logs\mock.log
  )
)

:open_app
echo.
echo   [->] 打开桌宠...
start "" "%APP%"

echo.
echo   ──────────────────────────────────────
echo   [OK] 启动完成！小猫稍后出现在桌面
echo.
echo      · 单击小猫  →  聊天输入框
echo      · 双击小猫  →  快捷菜单
echo      · 拖动小猫  →  移动位置
echo      · 三连击    →  彩蛋 🥚
echo.
echo   关闭所有服务：运行 stop.bat
echo   ──────────────────────────────────────
echo.
pause
