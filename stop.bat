@echo off
chcp 65001 >nul

echo.
echo   🛑  停止桌宠服务
echo   ──────────────────────────────────────

REM 停止占用 4100 端口的进程
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":4100 "') do (
  taskkill /PID %%a /F >nul 2>&1
)
echo   [OK] 状态服务 :4100 已停止

REM 关闭 pet.exe
taskkill /IM pet.exe /F >nul 2>&1 && echo   [OK] 桌宠已关闭 || echo   [--] 桌宠未在运行

echo.
echo   完成。再见喵～
echo.
pause
