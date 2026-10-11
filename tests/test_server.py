"""後端測試：以假的 ddddocr 模組取代真實模型，不需下載或載入 ONNX。

執行：在專案根目錄 `python -m pytest tests -v`
"""
import base64
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

TOKEN = "test-token-1234"
SITE_NUM = "login.school-a.edu.tw"
SITE_ALNUM = "portal.company-b.com.tw"
# 任意位元組即可，假模型不會解析
IMG_B64 = base64.b64encode(b"\x89PNG fake image bytes").decode()


class FakeDdddOcr:
    """假模型：回傳含雜訊字元的固定結果，用來驗證字元集過濾。"""

    instances = 0
    last_input = None

    def __init__(self, *args, **kwargs):
        FakeDdddOcr.instances += 1

    def classification(self, image_bytes):
        FakeDdddOcr.last_input = image_bytes
        return "a1-B2_c3!"


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setitem(sys.modules, "ddddocr", types.SimpleNamespace(DdddOcr=FakeDdddOcr))
    monkeypatch.setenv("CAPTCHA_TOKEN", TOKEN)
    FakeDdddOcr.instances = 0
    from fastapi.testclient import TestClient

    import main

    with TestClient(main.app) as c:  # with 區塊會觸發 lifespan（載入模型）
        yield c


def post_ocr(client, image=IMG_B64, site=SITE_ALNUM, token=TOKEN, **extra):
    headers = {"X-Token": token} if token is not None else {}
    return client.post("/ocr", json={"image": image, "site": site, **extra}, headers=headers)


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_model_loaded_once(client):
    post_ocr(client)
    post_ocr(client)
    assert FakeDdddOcr.instances == 1


def test_missing_token_403(client):
    assert post_ocr(client, token=None).status_code == 403


def test_wrong_token_403(client):
    assert post_ocr(client, token="wrong").status_code == 403


def test_site_not_whitelisted_403(client):
    assert post_ocr(client, site="evil.example.com").status_code == 403


def test_base64_without_prefix(client):
    r = post_ocr(client)
    assert r.status_code == 200
    assert FakeDdddOcr.last_input == b"\x89PNG fake image bytes"


def test_base64_with_data_url_prefix(client):
    r = post_ocr(client, image="data:image/png;base64," + IMG_B64)
    assert r.status_code == 200
    assert FakeDdddOcr.last_input == b"\x89PNG fake image bytes"


def test_default_charset_alnum(client):
    # 公司 B 網站設定為英數：雜訊符號被移除
    assert post_ocr(client).json() == {"text": "a1B2c3"}


def test_site_charset_digits(client):
    # 學校 A 網站設定為純數字
    assert post_ocr(client, site=SITE_NUM).json() == {"text": "123"}


def test_request_charset_overrides(client):
    assert post_ocr(client, charset="abc").json() == {"text": "ac"}


def test_invalid_base64_400(client):
    assert post_ocr(client, image="!!!not base64!!!").status_code == 400


def test_cors_only_whitelisted(client):
    ok = client.options(
        "/ocr",
        headers={"Origin": f"https://{SITE_NUM}", "Access-Control-Request-Method": "POST"},
    )
    assert ok.headers.get("access-control-allow-origin") == f"https://{SITE_NUM}"
    bad = client.options(
        "/ocr",
        headers={"Origin": "https://evil.example.com", "Access-Control-Request-Method": "POST"},
    )
    assert "access-control-allow-origin" not in bad.headers
