@echo off
rem Updates the editor and this add-on, and attaches multiplayer to the new version.
cd /d "%~dp0"
title TTML Tool Multiplayer - update
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
node multiplayer\addon.mjs update %*
pause
