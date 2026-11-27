@echo off
title Ponte WhatsApp TL
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js non installato: scaricalo da https://nodejs.org ^(versione LTS^) e riprova. & pause & exit /b 1)
if not exist node_modules (echo Prima installazione, attendi... & call npm ci --omit=dev)
echo Pannello: http://localhost:3100
start "" cmd /c "timeout /t 6 /nobreak >nul & start http://localhost:3100"
:ciclo
node --env-file=.env src\server.js
echo Il ponte si e' fermato, riavvio tra 10 secondi...
timeout /t 10 /nobreak >nul
goto ciclo
