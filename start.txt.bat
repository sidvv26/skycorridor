@echo off
setlocal

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo ============================================================
    echo  Node.js is required to run this app but wasn't found.
    echo  Download and install it from https://nodejs.org, then
    echo  double-click this file again.
    echo ============================================================
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Installing dependencies - this takes a minute the first time...
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install failed - see the error above.
        pause
        exit /b 1
    )
)

echo.
echo Starting SkyCorridor... your browser will open automatically in a few seconds.
echo Close this window to stop the app.
echo.

start "" cmd /c "timeout /t 6 >nul && start http://localhost:5173"
call npm run dev

pause
