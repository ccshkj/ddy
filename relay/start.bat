@echo off
REM 隐私聊天小程序 · 仅内存中继一键启动（Windows）
cd /d %~dp0
if not exist node_modules (call npm install)
echo ============================================================
echo   中继已启动（仅内存、不落盘，重启即清空）
echo   本地地址: ws://你的电脑局域网IP:3000
echo   保持此窗口打开；关闭窗口即停止中继
echo ============================================================
node server.js
pause
