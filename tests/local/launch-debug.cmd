@echo off
rem ===========================================================================
rem  tests/local/launch-debug.cmd —— 本地调试：带 CDP 远程调试口启动 TauriTavern
rem
rem  用途：本地开发时，用真实宿主（TauriTavern）跑插件，并把前端 DevTools 打开，
rem       便于在真实 getContext / 真实 DOM / 真实存储下排查问题。
rem
rem  用法（在仓库根执行）：
rem      tests\local\launch-debug.cmd                 rem 默认端口 9222，不注入代理
rem      tests\local\launch-debug.cmd 9222            rem 指定 CDP 端口
rem      tests\local\launch-debug.cmd 9222 http://127.0.0.1:PORT   rem 同时注入代理
rem
rem  ⚠️ 本脚本**只启动进程、只设本进程环境变量**：
rem     · 不写任何宿主配置文件（settings.json / tauritavern-settings.json 一律只读）；
rem     · 不碰插件用户数据（extension-store/**）。
rem
rem  ⚠️ 实测状态（v3.0.6 首次交付时）：
rem     · TauriTavern 为单实例：必须**完全退出**（含托盘图标）后再跑本脚本，否则新环境变量不生效；
rem     · CDP 依赖 WebView2 读取 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS。但 TauriTavern 所用
rem       wry 会自行下发 browser arguments（exe 内含 `disable-features=msWebOOUI,msPdfOOUI`），
rem       此时该环境变量**可能被忽略** —— 故本路径标为「待实测」。
rem       若 9222 没起来，请改用宿主自带 DevTools：在窗口内右键 → 检查(Inspect)，
rem       或按 F12 / Ctrl+Shift+I（exe 已验证编入 `devtools` 支持）。
rem ===========================================================================

setlocal
set "PORT=%~1"
if "%PORT%"=="" set "PORT=9222"
set "PROXY_URL=%~2"

set "APP=%LOCALAPPDATA%\TauriTavern\tauritavern.exe"

if not exist "%APP%" (
  echo [x] Not found: %APP%
  echo     If TauriTavern is installed elsewhere, install/point it first.
  pause
  exit /b 1
)

tasklist /FI "IMAGENAME eq tauritavern.exe" 2>nul | find /I "tauritavern.exe" >nul
if not errorlevel 1 (
  echo.
  echo [!] TauriTavern is already running.
  echo     It is single-instance: a new launch will NOT receive the new env.
  echo     Please exit it completely ^(tray icon included^), then run this again.
  echo.
  pause
  exit /b 1
)

set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=%PORT%"
echo [i] WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=%WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS%

if not "%PROXY_URL%"=="" (
  set "HTTPS_PROXY=%PROXY_URL%"
  set "HTTP_PROXY=%PROXY_URL%"
  set "ALL_PROXY=%PROXY_URL%"
  set "NO_PROXY=localhost,127.0.0.1,::1,0.0.0.0"
  echo [i] HTTPS_PROXY=%HTTPS_PROXY%
)

echo [i] Starting TauriTavern ...
start "" "%APP%"

echo.
echo [i] After the window is up, check the DevTools endpoint:
echo       http://127.0.0.1:%PORT%/json
echo     If it does not respond, use the built-in DevTools instead
echo     ^(right-click -^> Inspect, or F12 / Ctrl+Shift+I^).
echo.
echo [i] Host logs:  %%APPDATA%%\com.tauritavern.client\logs\tauritavern.log.*
echo [i] Plugin self-check:  npm run local
echo.
endlocal
exit /b 0
