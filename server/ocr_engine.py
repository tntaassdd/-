"""ddddocr 包裝：模型只在啟動時載入一次，圖片只在記憶體中處理，不落地、不記錄。"""
import base64
import binascii
import re

from config import ALNUM

# 支援 data:image/png;base64,xxxx 前綴
_DATA_URL_RE = re.compile(r"^data:image/[a-zA-Z0-9.+-]+;base64,", re.IGNORECASE)


class InvalidImage(ValueError):
    pass


def decode_image(image_b64: str) -> bytes:
    """去掉 data URL 前綴後解碼 Base64，失敗時拋出 InvalidImage。"""
    if not image_b64:
        raise InvalidImage("image 為空")
    payload = _DATA_URL_RE.sub("", image_b64.strip(), count=1)
    # 去除換行與空白（部分瀏覽器輸出的 Base64 可能含換行）
    payload = re.sub(r"\s+", "", payload)
    try:
        data = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise InvalidImage("Base64 格式錯誤") from exc
    if not data:
        raise InvalidImage("圖片內容為空")
    return data


def filter_charset(text: str, charset: str = None) -> str:
    """只保留字元集內的字元；未指定時只保留英數。"""
    allowed = set(charset) if charset else set(ALNUM)
    return "".join(ch for ch in text if ch in allowed)


class OcrEngine:
    """ddddocr 只在建構時載入一次模型。"""

    def __init__(self):
        import ddddocr  # 延遲匯入，測試時可用 mock 取代

        # show_ad=False 關閉啟動廣告訊息（舊版不支援此參數時改用預設）
        try:
            self._ocr = ddddocr.DdddOcr(show_ad=False)
        except TypeError:
            self._ocr = ddddocr.DdddOcr()

    def classify(self, image_bytes: bytes) -> str:
        try:
            result = self._ocr.classification(image_bytes)
        except Exception as exc:  # 圖片無法解析等
            raise InvalidImage("圖片無法辨識（格式錯誤？）") from exc
        return result or ""
