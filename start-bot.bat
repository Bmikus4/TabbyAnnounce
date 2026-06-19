@echo off
title TabbyAnnounce
cd /d %~dp0
del .port 2>nul
start "" node index.js
:waitport
timeout /t 1 /nobreak >nul
if not exist .port goto waitport
set /p PORT=<.port
start "" http://localhost:%PORT%
