#!/usr/bin/env bash
# 啟動本機驗證碼辨識服務（macOS / Linux）
set -e
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
if [ ! -x .venv/bin/python ]; then
  echo "[Captcha] 建立虛擬環境 .venv ..."
  "$PY" -m venv .venv
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install -r server/requirements.txt
fi

if [ ! -f server/.env ]; then
  # 第一次啟動：由 .env.example 建立 .env 並自動產生 Token
  TOKEN=$(.venv/bin/python -c "import secrets; print(secrets.token_hex(16))")
  sed "s/^CAPTCHA_TOKEN=.*/CAPTCHA_TOKEN=${TOKEN}/" server/.env.example > server/.env
  echo "[Captcha] 已建立 server/.env，Token 為：${TOKEN}"
  echo "[Captcha] 請把這組 Token 貼到油猴腳本頂部的 API_TOKEN 常數"
fi

cd server
exec ../.venv/bin/python main.py
