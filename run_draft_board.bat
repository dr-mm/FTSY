@echo off
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
title Iniciando Fantasy Draft Board...
echo ===================================================
echo 🏈 FANTASY DRAFT BOARD LAUNCHER
echo ===================================================
echo.

:: 1. Run Python script to fetch latest NFL stats
echo 📊 Atualizando estatísticas semanais da NFL...
python export_stats.py

echo.
echo ⚡ Iniciando o servidor web local
:: Start server in the background
start /b "" python -m http.server 8000 >nul 2>&1

:: 2. Wait until the server is ACTUALLY responding (instead of a blind fixed
::    wait). Checks once per second, up to ~15s, before giving up and opening
::    the browser anyway. This avoids the "this site can't be reached" page
::    you'd get if the server took longer than the old fixed 2s to start.
echo ⏳ Aguardando o servidor ficar pronto...
set /a _tries=0
:WAIT_SERVER
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://localhost:8000' -UseBasicParsing -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto SERVER_READY
set /a _tries+=1
if %_tries% GEQ 15 goto SERVER_READY
timeout /t 1 /nobreak >nul
goto WAIT_SERVER
:SERVER_READY

:: 3. Open default web browser ONLY AFTER server is confirmed ready
echo 🚀 Abrindo Draft Board no Navegador...
start "" http://localhost:8000

echo.
echo ===================================================
echo ✅ Draft Board está rodando em http://localhost:8000
echo (Deixe essa janela aberta durante o draft!)
echo ===================================================
echo.

:: Keep script alive so background server stays running
pause >nul