@echo off
title TabbyAnnounce
cd /d %~dp0
start "" http://localhost:3000
node index.js
pause
