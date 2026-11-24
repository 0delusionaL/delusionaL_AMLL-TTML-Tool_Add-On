@echo off
rem Installs the multiplayer add-on onto the Spicy Lyrics TTML Tool.
rem Without arguments it downloads the editor into the "editor" folder here.
rem Drop an existing editor folder onto this file to attach to that one instead.
cd /d "%~dp0"
title TTML Tool Multiplayer - install
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.
  start "" https://nodejs.org/
  pause
  exit /b 1
)
node multiplayer\addon.mjs install %*
pause
