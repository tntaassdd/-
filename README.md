# 本機離線驗證碼自動填入

在**你指定的網站**登入頁，自動辨識簡單的圖形驗證碼並填入輸入框。辨識完全在本機離線進行（[ddddocr](https://github.com/sml2h3/ddddocr)），**只填入、不會自動按登入**。

```
瀏覽器（Tampermonkey 腳本）──GM_xmlhttpRequest──▶ http://127.0.0.1:9898/ocr（FastAPI + ddddocr）
```

## 設計原則

| 原則 | 實作方式 |
|---|---|
| 不使用線上 API | 只用本機 ddddocr 模型 |
| 只在指定網站運作 | `@match` 只列白名單登入頁；腳本內 `SITES` 找不到 hostname 就立即結束；後端 `site` 不在白名單回 403 |
| 不自動送出 | 腳本沒有任何 `submit()` / `click()` |
| 不碰行為式驗證 | 偵測到 reCAPTCHA、hCaptcha、Cloudflare Turnstile 就完全不動作 |
| 只對本機開放 | 服務寫死綁定 `127.0.0.1`，並以 `X-Token` 驗證 |
| 不保存圖片 | 圖片只在記憶體中處理；log 只記網站名稱與耗時 |

## 專案結構

```
server/
  main.py            FastAPI 服務（/health、/ocr）
  config.py          後端白名單 SITES、Token 讀取
  ocr_engine.py      ddddocr 包裝、Base64 解碼、字元集過濾
  requirements.txt
  .env.example
userscript/
  captcha-autofill.user.js
tests/
  test_server.py
start.sh / start.bat
```

## 安裝與啟動

### 1. 安裝 Python

建議使用 **Python 3.9–3.12**。ddddocr 依賴 onnxruntime，太新的 Python 版本可能還沒有對應的安裝包。

### 2. 啟動本機服務

- **macOS / Linux**：`./start.sh`
- **Windows**：雙擊 `start.bat`

第一次執行時，腳本會自動做以下事情：

1. 建立 `.venv` 虛擬環境並安裝套件（需要幾分鐘）。
2. 若 `server/.env` 不存在，從 `.env.example` 建立一份，並自動產生 Token 印在畫面上。

看到 `Uvicorn running on http://127.0.0.1:9898` 就代表服務已啟動。可以開啟 <http://127.0.0.1:9898/health> 確認，正常會看到 `{"ok":true}`。

#### 手動設定 Token（不用啟動腳本時）

```bash
cp server/.env.example server/.env
python -c "import secrets; print(secrets.token_hex(16))"
# 把輸出貼到 server/.env 的 CAPTCHA_TOKEN=
```

### 3. 安裝油猴腳本

1. 在瀏覽器安裝 [Tampermonkey](https://www.tampermonkey.net/)。
2. Tampermonkey 選單 →「建立新腳本」→ 貼上 `userscript/captcha-autofill.user.js` 的全部內容。
3. 把腳本頂部的 `API_TOKEN` 改成 `server/.env` 裡的 `CAPTCHA_TOKEN`，**兩邊必須完全一致**。
4. 存檔。第一次呼叫本機服務時，Tampermonkey 會詢問是否允許連線到 `127.0.0.1`，請選「總是允許」。
5. Chrome / Edge 若使用 Manifest V3 版的 Tampermonkey，需要在擴充功能設定中開啟「允許使用者腳本」（或開發人員模式）。

### 4. 使用

打開登入頁後，驗證碼會自動填入，**請自行確認後再按登入**。按 F12 開啟 Console，可以看到 `[Captcha]` 開頭的運作紀錄。

## 執行測試

```bash
.venv/bin/python -m pytest tests -v      # Windows：.venv\Scripts\python -m pytest tests -v
```

測試會用假的 ddddocr 取代真實模型，不需要下載模型。

## 用 DevTools 找選擇器

1. 在登入頁對驗證碼圖片按右鍵 →「檢查」，DevTools 會標出對應的 `<img>`。
2. 依優先順序挑選擇器：
   - 有 `id` 就用 `#id`，例如 `#captchaImg`。
   - 有特定 class 就用 `img.class名稱`，例如 `img.verify-code`。
   - 有 `name` 就用 `input[name="captcha"]`。
3. 驗證選擇器：在 Console 輸入 `document.querySelectorAll('你的選擇器')`，確認**只回傳 1 個**元素，而且是正確的那個。
4. 輸入框用同樣方法找。

> 如果 `SITES` 的選擇器留空或找不到元素，腳本會改用關鍵字（captcha / verify / checkcode / vcode / 驗證）加上尺寸判斷來偵測，並在 Console 提示你補上精確選擇器。關鍵字偵測可能誤判，建議盡量填上精確選擇器。

## 新增網站（三處都要改）

以 `www.example.com.tw/signin` 為例：

**① 油猴腳本 `@match`**

```js
// @match        https://www.example.com.tw/signin*
```

**② 油猴腳本 `SITES`**（key 是 hostname，不含 `https://` 與路徑）

```js
'www.example.com.tw': {
  imgSelector: '#vcodeImg',
  inputSelector: '#vcode',
  charset: '0123456789',   // 英數請填 0-9a-zA-Z 全部字元
  minLen: 4,
  maxLen: 4,
},
```

**③ 後端 `server/config.py` 的 `SITES`**

```python
"www.example.com.tw": {"charset": "0123456789"},
```

改完後重新啟動本機服務，並在 Tampermonkey 存檔。

## 常見問題

### Console 出現「無法連線本機服務」

本機服務沒有啟動。請執行 `start.sh` 或 `start.bat`，並確認 <http://127.0.0.1:9898/health> 可以開啟。

### 出現 403

有兩種可能：

- `API_TOKEN` 和 `server/.env` 不一致。
- 網站沒有加進後端 `config.py` 的 `SITES`。

修改 `.env` 或 `config.py` 後，需要重新啟動服務才會生效。

### CORS / Private Network Access 錯誤

腳本使用 `GM_xmlhttpRequest`，由 Tampermonkey 發出請求，**不受網頁的 CORS 與 Private Network Access 限制**。如果仍然被擋，請確認：

- 腳本標頭有 `@connect 127.0.0.1`。
- 你在 Tampermonkey 的連線詢問中選了允許。

後端的 CORS 只允許白名單網域，是額外的防線。

### 為什麼不能重新下載驗證碼圖片？（Session 綁定）

大多數網站每次請求驗證碼網址，就會產生新答案並寫入你的 Session。如果腳本另外下載一次圖片，畫面上那張的答案就作廢了，填入的值必定錯誤。因此腳本會用 canvas 直接擷取畫面上已載入的圖片。

### canvas 被汙染（tainted）

驗證碼圖片來自其他網域、且沒有 CORS 標頭時，canvas 會禁止讀取像素。這時腳本改用備援方案：

1. 以 `GM_xmlhttpRequest`（帶 Cookie）**只取一次**圖片。
2. 用同一份資料取代畫面上的圖（blob URL），並送去辨識。

這樣你看到的圖與辨識的圖一定是同一張、對應同一個 Session 答案。

### 辨識率不好怎麼辦？

- **限制字元集**：純數字驗證碼請設定 `charset: '0123456789'`，可以排除 `O/0`、`l/1` 這類誤判。
- **設定正確長度**：設好 `minLen` / `maxLen`。結果長度不符時腳本不會填入，你可以點「換一張」重試。
- **大小寫**：ddddocr 的輸出多半是小寫。若網站區分大小寫，辨識率會受影響；多數網站不分大小寫。
- **換用 beta 模型**：在 `server/ocr_engine.py` 中把 `ddddocr.DdddOcr(show_ad=False)` 改成 `ddddocr.DdddOcr(beta=True, show_ad=False)`，有些驗證碼樣式會比較準。
- **高度扭曲或有干擾線的驗證碼**：通用模型可能無法處理，這屬於工具範圍外。

### 同一頁辨識幾次後就不再動作了？

這是刻意的設計：每次頁面載入最多辨識 `MAX_ATTEMPTS`（預設 3）次，避免對網站產生多餘請求。重新整理頁面就會重新計算。

### 我手動輸入後，腳本會覆蓋嗎？

不會。輸入框裡只要有不是腳本填的內容，腳本就不會呼叫辨識，也不會覆寫。
