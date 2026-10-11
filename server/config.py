"""設定：讀取 .env 與網站白名單。

新增網站時，必須同時修改三處：
  1. 本檔的 SITES（後端白名單）
  2. 油猴腳本的 @match
  3. 油猴腳本的 SITES 對照表
"""
import os
import string
from pathlib import Path

from dotenv import load_dotenv

# .env 放在 server/ 目錄下
ENV_PATH = Path(__file__).resolve().parent / ".env"
load_dotenv(ENV_PATH)

# 只允許綁定本機回環位址，絕不使用 0.0.0.0
HOST = "127.0.0.1"
PORT = int(os.getenv("PORT", "9898"))

# 「英數」的實際字元集
ALNUM = string.digits + string.ascii_letters

# 後端白名單：key 為 hostname，需與油猴腳本 SITES 的 key 一致
# charset 為該網站預設字元集（前端未帶 charset 時使用）
SITES = {
    "webapp.yuntech.edu.tw": {"charset": "0123456789"},
    "portal.company-b.com.tw": {"charset": ALNUM},
}


def get_token() -> str:
    """每次呼叫時讀取，方便測試時以環境變數覆寫。"""
    return os.getenv("CAPTCHA_TOKEN", "").strip()


def allowed_origins() -> list:
    """CORS 只允許白名單網域（https）。"""
    return [f"https://{host}" for host in SITES]
