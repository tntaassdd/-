"""本機離線驗證碼辨識服務（只綁定 127.0.0.1）。

啟動：python main.py（或使用專案根目錄的 start.sh / start.bat）
"""
import logging
import secrets
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import config
from ocr_engine import InvalidImage, OcrEngine, decode_image, filter_charset

# 注意：log 只記錄網站與耗時，絕不記錄圖片或辨識結果
logging.basicConfig(level=logging.INFO, format="[Captcha] %(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("captcha")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 沒有 Token 就拒絕啟動，避免服務在無保護狀態下運行
    if not config.get_token():
        raise RuntimeError("未設定 CAPTCHA_TOKEN，請先依 .env.example 建立 server/.env")
    # ddddocr 模型只在啟動時載入一次
    app.state.engine = OcrEngine()
    log.info("ddddocr 模型已載入")
    yield


app = FastAPI(title="Offline Captcha OCR", lifespan=lifespan)

# CORS 只允許白名單網域（油猴腳本走 GM_xmlhttpRequest 不受 CORS 影響，這是額外防線）
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.allowed_origins(),
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Token"],
)


class OcrRequest(BaseModel):
    image: str
    site: str
    charset: Optional[str] = None


def verify_token(x_token: Optional[str] = Header(default=None)):
    """驗證 X-Token；使用 compare_digest 避免時序攻擊。"""
    expected = config.get_token()
    if not expected or not x_token or not secrets.compare_digest(x_token, expected):
        raise HTTPException(status_code=403, detail="Token 無效或缺少 X-Token")


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/ocr", dependencies=[Depends(verify_token)])
def ocr(req: OcrRequest, request: Request):
    site_cfg = config.SITES.get(req.site)
    if site_cfg is None:
        raise HTTPException(status_code=403, detail="site 不在白名單內")

    try:
        image_bytes = decode_image(req.image)
        started = time.perf_counter()
        raw = request.app.state.engine.classify(image_bytes)
    except InvalidImage as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # 字元集優先順序：請求指定 > 網站設定 > 預設英數
    charset = req.charset or site_cfg.get("charset")
    text = filter_charset(raw, charset)
    log.info("site=%s 耗時 %.0fms", req.site, (time.perf_counter() - started) * 1000)
    # image_bytes 僅存在於此函式的區域變數，回傳後即釋放，不落地
    return {"text": text}


if __name__ == "__main__":
    import uvicorn

    # 寫死 127.0.0.1，不讀取外部 HOST 設定
    uvicorn.run(app, host=config.HOST, port=config.PORT)
