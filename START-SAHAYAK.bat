@echo off
setlocal
cd /d "%~dp0"
title Sahayak Desk - MongoDB Atlas

echo.
echo ==============================================
echo        SAHAYAK DESK - STARTING SERVER
echo ==============================================
echo.

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Check your internet connection.
    pause
    exit /b 1
  )
)

REM Avoid accidentally talking to an older Sahayak server on port 5000.
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":5000" ^| findstr "LISTENING"') do (
  if not "%%P"=="0" (
    echo Existing process on port 5000 found: %%P
    taskkill /PID %%P /F >nul 2>&1
  )
)

echo Starting Sahayak Desk on http://localhost:5000
start "Sahayak Desk" cmd /k "cd /d "%~dp0" && npm start"
timeout /t 2 /nobreak >nul
start "" "http://localhost:5000/"
endlocal
