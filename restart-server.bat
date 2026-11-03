@echo off
chcp 936 >nul
rem 重启服务（改了 server.py / config.json / version.json 之后要用）。
rem 先请服务自己重启（POST /api/restart），这条路不用找进程号；
rem 只有它不认这个接口时，才退回 netstat 找 PID 强杀的老办法。
rem 起服务和开页面仍旧只交给 start-server.bat 一处。
cd /d "%~dp0"

set "PORT=8765"

if not exist "start-server.bat" (
  echo 没找到 start-server.bat，请从项目根目录运行本脚本。
  pause
  exit /b 1
)

rem 找 Python：和 start-server.bat 同一套，重启要靠它发请求
set "PYEXE="
set "PYARGS="
if exist "%~dp0runtime\python.exe" set "PYEXE=%~dp0runtime\python.exe"
if defined PYEXE goto pyready

where py >nul 2>&1
if errorlevel 1 goto trypython
py -3 -c "import sys; assert sys.hexversion >= 0x03090000" >nul 2>&1
if errorlevel 1 goto trypython
set "PYEXE=py"
set "PYARGS=-3"
goto pyready

:trypython
where python >nul 2>&1
if errorlevel 1 goto nopython
python -c "import sys; assert sys.hexversion >= 0x03090000" >nul 2>&1
if errorlevel 1 goto nopython
set "PYEXE=python"
goto pyready

:nopython
echo 没找到可用的 Python 3.9+，也没有随包携带的 runtime\python.exe。
echo 请先按 start-server.bat 的提示装好 Python，再运行本脚本。
echo.
pause
exit /b 1

:pyready
call :probe
if errorlevel 1 goto cold

echo 正在请 %PORT% 上的服务自己重启 ...
"%PYEXE%" %PYARGS% -c "import sys,urllib.request as u; r=u.Request('http://127.0.0.1:%PORT%/api/restart', b'{}', {'X-Shlib-Write':'1'}); d=u.urlopen(r,timeout=5).read().replace(b' ',b''); sys.exit(0 if b'\x22ok\x22:true' in d else 1)" 2>nul
if errorlevel 1 goto killold

rem 旧进程写完响应 0.6 秒后才退出，新进程重新绑定还要重试几轮，先给三秒空档
ping -n 4 127.0.0.1 >nul 2>&1
set /a WAIT=0
:waitup
call :probe
if not errorlevel 1 goto started
set /a WAIT+=1
if %WAIT% geq 20 goto failed
ping -n 2 127.0.0.1 >nul 2>&1
goto waitup

:started
echo 新进程已经起来了。
call "%~dp0start-server.bat"
exit /b 0

:failed
echo 请求发出去了，但 %PORT% 端口 20 秒内没有恢复响应。
echo 多半是新进程没能起来，请看日志：data\server.log
echo.
pause
exit /b 1

:killold
rem 服务不认 /api/restart（比如是个更老的进程），退回按 PID 强杀
echo 这个服务不认自助重启，改用 netstat 找进程号强杀 ...
set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano | findstr /c:":%PORT% " | findstr /i "LISTENING"') do (
  set "FOUND=1"
  echo   停掉 PID %%p
  taskkill /F /PID %%p >nul 2>&1
)
if not defined FOUND (
  echo   netstat 没报出 %PORT% 上的进程，但端口确实有响应。
  echo   请直接在网页的设置面板里点「重启服务」。
  echo.
  pause
  exit /b 1
)

rem 等旧进程真的退掉、端口不再答话（最多 10 秒）
set /a WAIT=0
:waitdown
call :probe
if errorlevel 1 goto cold
set /a WAIT+=1
if %WAIT% geq 10 goto portbusy
ping -n 2 127.0.0.1 >nul 2>&1
goto waitdown

:portbusy
echo 端口 %PORT% 还在答话，旧服务可能没停掉。
echo 查看占用进程：netstat -ano | findstr :%PORT%
pause
exit /b 1

:cold
rem 端口空着：交给 start-server.bat 冷启动并打开页面
call "%~dp0start-server.bat"
exit /b 0

rem 探活：向本机端口要一次首页，拿到本服务的页面返回 0，其余一律 1
:probe
"%PYEXE%" %PYARGS% -c "import sys,urllib.request as u; b=u.urlopen('http://127.0.0.1:%PORT%/',timeout=2).read(); sys.exit(0 if b'\xe4\xb8\x8a\xe5\x9b\xbe\xe9\xa6\x86\xe8\x97\x8f' in b else 1)" 2>nul
exit /b %errorlevel%
