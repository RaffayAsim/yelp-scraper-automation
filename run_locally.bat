@echo off
title Yelp Scraper Automation Server
cd /d "%~dp0"
echo Starting Yelp Scraper Automation Server...
set PATH=%~dp0node-bin\node-v20.11.0-win-x64;%PATH%
node server.js
pause
