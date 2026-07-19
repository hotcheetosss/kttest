@echo off
chcp 65001 >nul
title Тренажёр тестов — локальный сервер
echo Запускаю тренажёр на http://localhost:4173 ...
echo Чтобы остановить сервер — закройте это окно или нажмите Ctrl+C.
start "" http://localhost:4173
python -m http.server 4173 --directory "%~dp0"
pause
