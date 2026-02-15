@echo off
setlocal

set "iperf3=..\IPERF\iperf3.exe"

echo Server laeuft. Beenden mit STRG+C
echo.

"%iperf3%" -s -p 5201 -i 1 --forceflush
