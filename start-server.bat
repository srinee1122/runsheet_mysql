@echo off
REM start-server.bat — sets the credentials this app needs for this session, then starts
REM it. Run this instead of typing "set ..." lines by hand every time you open a terminal.

REM ---- Firebase (sign-in) ----
REM If your servicekey.json ever moves to a different folder, update this path to match.
set GOOGLE_APPLICATION_CREDENTIALS=C:\Users\srini\Claude Apps\Runsheet-MySql\servicekey.json

REM ---- MySQL (data) ----
REM The app stores everything in MySQL now (see db.js for why SQLite was dropped). For
REM local development you need a MySQL server running on this PC — MySQL Community Server
REM or MariaDB, both free — with a database and a user created for this app. Fill in
REM whatever you chose when you set that up. On GoDaddy these five are injected
REM automatically and this file isn't used at all.
set DB_HOST=127.0.0.1
set DB_PORT=3306
set DB_NAME=runsheet
set DB_USER=runsheet
set DB_PASSWORD=pick-a-password

REM %~dp0 is this .bat file's own folder — makes sure "npm start" runs from the correct
REM project folder even if you double-click this file from somewhere else.
cd /d "%~dp0"

npm start

REM Keeps the window open after the server stops or crashes, so you can read the error.
pause
