@echo off
set "DEST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Ponte WhatsApp TL.bat"
> "%DEST%" echo @echo off
>> "%DEST%" echo start "Ponte WhatsApp TL" /min "%~dp0avvia-ponte.bat"
echo Avvio automatico attivato: il ponte partira' a ogni accensione del PC.
pause
