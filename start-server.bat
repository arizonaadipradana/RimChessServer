@echo off
echo Starting RimChess Multiplayer Server...
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not in PATH
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

REM Check if Redis is needed (can be installed or run via Docker)
echo Checking for Redis...
redis-cli --version >nul 2>&1
if %errorlevel% neq 0 (
    echo WARNING: Redis CLI not found. Make sure Redis is running on localhost:6379
    echo You can install Redis or run it via Docker: docker run -d -p 6379:6379 redis
    echo.
)

REM Install dependencies if node_modules doesn't exist
if not exist "node_modules" (
    echo Installing dependencies...
    npm install
    if %errorlevel% neq 0 (
        echo ERROR: Failed to install dependencies
        pause
        exit /b 1
    )
    echo.
)

REM Start the server
echo Starting server on port 3000...
echo Press Ctrl+C to stop the server
echo.
npm start

pause
