@echo off
setlocal

set "PYTHON=..\PORTABLE_win\python.exe"
set "SCRIPT=..\APP\app.py"

"%PYTHON%" "%SCRIPT%" %*

endlocal
pause