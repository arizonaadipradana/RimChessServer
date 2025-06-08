@echo off
echo ================================================
echo    RimChess Server Enhanced - Starting...
echo ================================================
echo.
echo Critical Fixes Enabled:
echo [✓] Checkmate Detection & Game End
echo [✓] Timer Management & Time Forfeit  
echo [✓] Correct Resignation Logic
echo [✓] Both Players Notification System
echo.
echo Starting Node.js server...
echo.

cd /d "%~dp0"

:: Check if node is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed or not in PATH
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

:: Check if dependencies are installed
if not exist "node_modules\" (
    echo Installing dependencies...
    npm install
    echo.
)

:: Start the server
echo Server starting on port 3030...
echo Health check: http://localhost:3030/health
echo Server info: http://localhost:3030/info
echo.
echo Press Ctrl+C to stop the server
echo ================================================

node server.js

pause
