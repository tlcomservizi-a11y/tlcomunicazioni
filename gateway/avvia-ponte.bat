@echo off
rem Ponte WhatsApp TL - la finestra resta sempre aperta, cosi' si vedono eventuali errori
if /i not "%~1"=="run" (
  start "Ponte WhatsApp TL" cmd /k ""%~f0" run"
  exit /b
)
cd /d "%~dp0"
echo ============================================
echo   PONTE WHATSAPP TL COMUNICAZIONI - versione 6
echo ============================================
echo Cartella: %CD%
if not exist "src\server.js" (
  echo.
  echo ERRORE: stai aprendo il file da dentro lo ZIP.
  echo Tasto destro sullo ZIP ^> "Estrai tutto...", poi apri avvia-ponte.bat dalla cartella estratta.
  goto fine
)
if not exist ".env" (
  echo.
  echo ERRORE: manca il file .env nella cartella. Estrai di nuovo lo ZIP completo.
  goto fine
)
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERRORE: Node.js non e' installato, oppure serve riavviare il PC dopo l'installazione.
  echo Scaricalo da https://nodejs.org - versione LTS - poi riavvia il PC e riprova.
  goto fine
)
for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo Node.js %NODEVER%
for /f "tokens=1 delims=." %%a in ("%NODEVER:~1%") do set NODEMAJ=%%a
if %NODEMAJ% LSS 20 (
  echo.
  echo ERRORE: serve Node.js 20 o successivo. Installa la versione LTS da https://nodejs.org
  goto fine
)
if not exist "node_modules\baileys" (
  echo Prima installazione delle librerie, attendi...
  call npm ci --omit=dev
)
echo Chiudo eventuali copie vecchie del ponte...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3100 " ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>nul
echo.
echo Avvio del ponte. Pannello: http://localhost:3100
echo NON chiudere questa finestra (puoi ridurla a icona).
start "" cmd /c "timeout /t 6 /nobreak >nul & start http://localhost:3100"
:ciclo
node --env-file=.env src\server.js
echo.
echo Il ponte si e' fermato. Riavvio tra 10 secondi... (chiudi la finestra per fermarlo)
timeout /t 10 /nobreak >nul
goto ciclo
:fine
echo.
pause
