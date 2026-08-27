@echo off
chcp 65001 >nul
title Claude Aggregator
cd /d "%~dp0"
echo Запуск агрегатора... Админка: http://127.0.0.1:8787/
echo Пульт (ссылка с токеном будет ниже в логе): http://127.0.0.1:8788/
node server.js
pause
