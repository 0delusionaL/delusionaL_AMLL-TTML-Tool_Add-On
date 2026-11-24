@echo off
rem Starts the TTML Tool with multiplayer. Keep this window open while you play.
cd /d "%~dp0"
title TTML Tool Multiplayer
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.
  start "" https://nodejs.org/
  pause
  exit /b 1
)
node multiplayer\launcher.mjs %*
if errorlevel 1 pause
