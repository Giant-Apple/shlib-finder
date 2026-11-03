@echo off
chcp 936 >nul
rem 启动「上图馆藏查询」本地服务，然后打开页面。
rem 打包版自带 runtime\python.exe，解压即用；源码目录没有 runtime 时，
rem 退回系统里的 py / python。
rem 服务默认只听本机；设置里开了「从其他设备访问」才会放行同 WiFi（页面里有二维码）。
rem 只想本机用：在命令行里跑 runtime\python.exe web\server.py --local
cd /d "%~dp0"

set "PORT=8765"
set "URL=http://127.0.0.1:%PORT%/"

if not exist "web\server.py" (
  echo 没找到 web\server.py，请从项目根目录运行本脚本。
  pause
  exit /b 1
)

rem 找 Python：优先随包 runtime，其次 py -3，最后 python；并验证 3.9+
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
echo 源码目录请安装 Python 3.9 或更高版本：
echo   https://www.python.org/downloads/
echo 安装时务必勾选 "Add python.exe to PATH"。
echo.
pause
exit /b 1

:pyready
echo 用的解释器：%PYEXE% %PYARGS%

rem 端口上已经有服务就直接用它，不再起第二个（两个进程会抢同一个端口）。
rem 这里靠真发一次请求判断，不用 netstat：netstat 有看不到本机监听的时候
rem （2026-11-03 实测），信它就会被误判成「端口空着」，于是一直等、页面也一直不开。
call :probe
if not errorlevel 1 goto already

rem --no-open：页面由脚本统一打开，免得服务自己再开一个标签页。
rem 输出转进 data\server.log：起不来时那里留得下报错，不会再只剩「窗口一闪」。
if not exist "data" mkdir "data"
echo [%date% %time:~0,8%] start-server.bat 拉起服务 >> "data\server.log"
start "上图馆藏查询服务 别关这个窗口" /min cmd /c ""%PYEXE%" %PYARGS% web\server.py --port %PORT% --no-open >> data\server.log 2>&1"

rem 等服务真的能答话再开页面，免得浏览器先报「无法访问此网站」
set /a WAIT=0
:wait
call :probe
if not errorlevel 1 goto open
set /a WAIT+=1
if %WAIT% geq 20 goto failed
ping -n 2 127.0.0.1 >nul 2>&1
goto wait

:already
echo %PORT% 端口上已经有服务在跑，直接打开页面。
goto open

:failed
echo 等了 20 秒，%PORT% 端口还是没有响应。
echo 下面直接在前台跑一次，报错会显示在这个窗口里（要用 Ctrl+C 停）：
echo.
"%PYEXE%" %PYARGS% web\server.py --port %PORT%
echo.
echo 要是它停在「上图馆藏查询已启动」不动了，说明服务其实是活的：
echo   另开一个标签页访问 %URL% 就行，关掉这个窗口即停服。
echo 要是它报了错，把上面那段原样贴出来就能定位；后台那次写在 data\server.log。
pause
exit /b 1

:open
start "" "%URL%"
echo 页面已打开：%URL%
echo 想停服务：关掉任务栏上那个「上图馆藏查询服务」的最小化窗口。
exit /b 0

rem 探活：向本机端口要一次首页，拿到本服务的页面返回 0，其余一律 1
:probe
"%PYEXE%" %PYARGS% -c "import sys,urllib.request as u; b=u.urlopen('http://127.0.0.1:%PORT%/',timeout=2).read(); sys.exit(0 if b'\xe4\xb8\x8a\xe5\x9b\xbe\xe9\xa6\x86\xe8\x97\x8f' in b else 1)" 2>nul
exit /b %errorlevel%
