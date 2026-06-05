@echo off
chcp 65001 >nul
title 数字淘汰 · 卡通版
cd /d "%~dp0"

echo ========================================
echo    数字淘汰 . 卡通版  启动器
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [!] 没有检测到 Node.js
  echo     请先到 https://nodejs.org 下载安装 LTS 版本，
  echo     安装完成后重新双击本文件即可。
  echo.
  pause
  exit /b
)

if not exist node_modules (
  echo 第一次运行，正在安装依赖，请稍候（只需一次）...
  echo.
  call npm install
  echo.
)

echo 正在启动服务器...
echo 启动后，把窗口里显示的网址用手机浏览器打开（手机和电脑连同一个 WiFi）。
echo 想结束游戏，直接关闭这个黑色窗口即可。
echo.
node server.js

echo.
echo 服务器已停止。按任意键关闭窗口。
pause >nul
