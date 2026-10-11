@echo off
REM 啟動本機驗證碼辨識服務（Windows）
chcp 65001 >nul
cd /d "%~dp0"

if exist .venv\Scripts\python.exe goto :checkenv
echo [Captcha] 建立虛擬環境 .venv ...
py -3 -m venv .venv 2>nul || python -m venv .venv
if errorlevel 1 goto :novenv
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install -r server\requirements.txt
if errorlevel 1 goto :pipfail

:checkenv
if exist server\.env goto :run
REM 第一次啟動：自動建立 .env 並產生 Token
for /f %%t in ('.venv\Scripts\python -c "import secrets; print(secrets.token_hex(16))"') do set TOKEN=%%t
> server\.env echo CAPTCHA_TOKEN=%TOKEN%
>> server\.env echo PORT=9898
echo [Captcha] 已建立 server\.env，Token 為：%TOKEN%
echo [Captcha] 請把這組 Token 貼到油猴腳本頂部的 API_TOKEN 常數

:run
cd server
..\.venv\Scripts\python main.py
pause
exit /b 0

:novenv
echo [Captcha] 建立 venv 失敗，請確認已安裝 Python 3.9-3.12 並加入 PATH
pause
exit /b 1

:pipfail
echo [Captcha] 套件安裝失敗，請檢查網路或 Python 版本（建議 3.9-3.12）
rmdir /s /q .venv
pause
exit /b 1
