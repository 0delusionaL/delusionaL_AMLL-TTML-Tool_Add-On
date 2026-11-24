@echo off
rem Removes the multiplayer add-on from the editor and leaves the editor as its developers publish it.
cd /d "%~dp0"
title TTML Tool Multiplayer - uninstall
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
node multiplayer\addon.mjs uninstall %*
pause
