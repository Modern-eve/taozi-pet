@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 套子桌宠
call npm run dev
pause
