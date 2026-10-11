// ==UserScript==
// @name         本機離線驗證碼自動填入
// @namespace    local.captcha.autofill
// @version      1.0.2
// @description  在白名單登入頁辨識簡單圖形驗證碼（本機 ddddocr），只填入、不送出
// @match        https://webapp.yuntech.edu.tw/YunTechSSO/Account/Login*
// @match        https://portal.company-b.com.tw/login*
// @connect      127.0.0.1
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ===================== 使用者設定 =====================

  // ⚠ 必須與 server/.env 的 CAPTCHA_TOKEN 完全一致
  const API_TOKEN = 'PASTE_YOUR_TOKEN_HERE';
  const API_URL = 'http://127.0.0.1:9898';

  const MAX_ATTEMPTS = 3;      // 每次頁面載入最多辨識次數
  const POLL_INTERVAL = 300;   // SPA 輪詢間隔（ms）
  const POLL_MAX = 20;         // SPA 最多輪詢次數
  const REQUEST_TIMEOUT = 8000;

  // 白名單網站（key 為 hostname）。新增網站時須同步修改：
  //   1. 上方 @match  2. 本表  3. server/config.py 的 SITES
  // imgSelector / inputSelector 留空字串時，會改用關鍵字 + 尺寸備援偵測
  const SITES = {
    // 雲科大 SSO。選擇器尚未確認，先留空使用關鍵字備援偵測，確認後請補上
    'webapp.yuntech.edu.tw': {
      imgSelector: '',
      inputSelector: '',
      charset: '0123456789',
      minLen: 4,
      maxLen: 4,
    },
    'portal.company-b.com.tw': {
      imgSelector: 'img.verify-code',
      inputSelector: '#vcode',
      charset: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', // 英數
      minLen: 5,
      maxLen: 6,
    },
  };

  // ===================== 內部邏輯 =====================

  const TAG = '[Captcha]';
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const error = (...a) => console.error(TAG, ...a);

  const HOST = location.hostname;
  const SITE = SITES[HOST];
  if (!SITE) return; // 不在白名單：立即結束，不做任何事

  if (!API_TOKEN || API_TOKEN === 'PASTE_YOUR_TOKEN_HERE') {
    error('尚未設定 API_TOKEN，請填入與 server/.env 相同的 CAPTCHA_TOKEN');
    return;
  }

  const KEYWORDS = ['captcha', 'verify', 'checkcode', 'vcode', 'validate', 'validcode', 'authcode', 'chkcode', '驗證', '圖形'];
  // 鄰近偵測時要排除的欄位（帳號、密碼等）
  const NOT_CAPTCHA_RE = /user|account|acct|login|email|mail|pass|帳號|學號|密碼/i;

  // 行為式驗證（reCAPTCHA / hCaptcha / Turnstile）：偵測到就完全不動作
  const BEHAVIORAL_SELECTORS = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="challenges.cloudflare.com"]',
    '.g-recaptcha', '.h-captcha', '.cf-turnstile',
    'script[src*="recaptcha"]', 'script[src*="hcaptcha"]', 'script[src*="turnstile"]',
  ].join(',');

  const state = {
    attempts: 0,
    busy: false,
    handledSrcs: new Set(), // 已辨識過的 src（同一張圖不重複辨識）
    ownBlobUrls: new Set(), // 我們自己設定的 blob URL（避免觸發重複辨識）
    lastFilled: null,       // 上次自動填入的值（用來判斷輸入框內容是否為使用者手動輸入）
    img: null,
    input: null,
    stopped: false,
  };

  function hasBehavioralCaptcha() {
    return !!document.querySelector(BEHAVIORAL_SELECTORS);
  }

  function matchesKeyword(el, attrs) {
    const hay = attrs.map((a) => (el.getAttribute(a) || '')).join(' ').toLowerCase();
    return KEYWORDS.some((k) => hay.includes(k));
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // ---- 1. 定位驗證碼圖片與輸入框 ----
  function findImage() {
    if (SITE.imgSelector) {
      const el = document.querySelector(SITE.imgSelector);
      if (el) return el;
    }
    // 備援：關鍵字 + 尺寸判斷（驗證碼圖通常寬 40–300、高 15–120）
    const candidates = [...document.querySelectorAll('img')].filter((img) => {
      if (!matchesKeyword(img, ['id', 'class', 'src', 'alt', 'name', 'title'])) return false;
      const r = img.getBoundingClientRect();
      return r.width >= 40 && r.width <= 300 && r.height >= 15 && r.height <= 120;
    });
    if (candidates.length) {
      warnFallback('驗證碼圖片', candidates[0]);
      return candidates[0];
    }
    return null;
  }

  function isTextInput(el) {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return ['text', 'tel', 'number', ''].includes(type) && !el.disabled && !el.readOnly && isVisible(el);
  }

  function findInput(img) {
    if (SITE.inputSelector) {
      const el = document.querySelector(SITE.inputSelector);
      if (el) return el;
    }
    // 備援 1：關鍵字
    const byKeyword = [...document.querySelectorAll('input')].find((el) =>
      isTextInput(el) && matchesKeyword(el, ['id', 'class', 'name', 'placeholder', 'aria-label', 'title']));
    if (byKeyword) {
      warnFallback('驗證碼輸入框', byKeyword);
      return byKeyword;
    }
    // 備援 2：驗證碼圖片附近、距離最近的文字輸入框（排除帳號、密碼欄位）
    if (!img) return null;
    const imgRect = img.getBoundingClientRect();
    let container = img.parentElement;
    for (let depth = 0; container && depth < 5; depth++, container = container.parentElement) {
      const nearby = [...container.querySelectorAll('input')].filter((el) => {
        if (!isTextInput(el)) return false;
        const hay = ['id', 'name', 'placeholder', 'autocomplete', 'aria-label']
          .map((a) => el.getAttribute(a) || '').join(' ');
        return !NOT_CAPTCHA_RE.test(hay);
      });
      if (nearby.length) {
        const dist = (el) => {
          const r = el.getBoundingClientRect();
          return Math.hypot(r.left - imgRect.left, r.top - imgRect.top);
        };
        nearby.sort((a, b) => dist(a) - dist(b));
        warnFallback('驗證碼輸入框', nearby[0]);
        return nearby[0];
      }
    }
    return null;
  }

  const warnedFallback = new Set();
  function warnFallback(what, el) {
    if (warnedFallback.has(what)) return;
    warnedFallback.add(what);
    warn(`${what}是用關鍵字備援偵測找到的，建議到 SITES 補上精確選擇器：`, el);
  }

  // ---- 2. 等待圖片載入完成 ----
  function waitForImage(img, timeout = 10000) {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('圖片載入逾時')); }, timeout);
      const onLoad = () => { cleanup(); img.naturalWidth > 0 ? resolve() : reject(new Error('圖片尺寸為 0')); };
      const onError = () => { cleanup(); reject(new Error('圖片載入失敗')); };
      function cleanup() {
        clearTimeout(timer);
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
      }
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
    });
  }

  // ---- 3. 用 canvas 擷取「畫面上那張圖」 ----
  // 不可重新 fetch 圖片網址：伺服器會產生新答案並寫入 Session，畫面上的圖就作廢了
  function captureFromCanvas(img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // 透明背景補白，提升辨識率
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png'); // 跨網域汙染時會丟出 SecurityError
  }

  // ---- 4. 備援：canvas 被汙染時，以 GM_xmlhttpRequest 只取一次圖 ----
  // 同一份 blob 同時用於「顯示」與「辨識」，確保兩者是同一張、對應同一個 Session 答案
  function fetchImageOnce(img) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: img.src,
        responseType: 'blob',
        anonymous: false, // 帶上 Cookie，維持同一個 Session
        timeout: REQUEST_TIMEOUT,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300 || !res.response) {
            reject(new Error(`取圖失敗 HTTP ${res.status}`));
            return;
          }
          const blob = res.response;
          const blobUrl = URL.createObjectURL(blob);
          state.ownBlobUrls.add(blobUrl);
          state.handledSrcs.add(blobUrl);
          // 原網址的圖已被我們取代；之後網站若再設回同一網址，代表真的換了一張
          state.handledSrcs.delete(img.src);
          img.src = blobUrl; // 用同一份資料取代畫面上的圖
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('blob 轉 Base64 失敗'));
          reader.readAsDataURL(blob);
        },
        onerror: () => reject(new Error('取圖連線失敗')),
        ontimeout: () => reject(new Error('取圖逾時')),
      });
    });
  }

  async function getImageBase64(img) {
    if (img.src.startsWith('data:')) return img.src; // 內嵌圖片直接使用
    try {
      return captureFromCanvas(img);
    } catch (e) {
      if (e && e.name === 'SecurityError') {
        warn('canvas 被跨網域汙染，改用備援方案（只取一次圖並替換顯示）');
        return fetchImageOnce(img);
      }
      throw e;
    }
  }

  // ---- 5. 呼叫本機 API ----
  function callOcr(imageBase64) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${API_URL}/ocr`,
        headers: { 'Content-Type': 'application/json', 'X-Token': API_TOKEN },
        data: JSON.stringify({ image: imageBase64, charset: SITE.charset, site: HOST }),
        timeout: REQUEST_TIMEOUT,
        onload: (res) => {
          if (res.status === 200) {
            try { resolve(JSON.parse(res.responseText).text || ''); }
            catch (e) { reject(new Error('本機服務回應格式錯誤')); }
          } else if (res.status === 403) {
            reject(new Error('本機服務拒絕（403）：請確認 API_TOKEN 與 server/.env 一致，且網站已加入後端白名單'));
          } else {
            reject(new Error(`本機服務錯誤 HTTP ${res.status}：${res.responseText}`));
          }
        },
        onerror: () => reject(new Error(`無法連線本機服務 ${API_URL}，請先執行 start.sh / start.bat 啟動服務`)),
        ontimeout: () => reject(new Error(`本機服務逾時（${REQUEST_TIMEOUT}ms），請確認服務是否正常`)),
      });
    });
  }

  // ---- 7. 用原生 setter 填入，相容 React / Vue ----
  function fillInput(input, value) {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, value);
    for (const type of ['input', 'change', 'blur']) {
      input.dispatchEvent(new Event(type, { bubbles: true }));
    }
    state.lastFilled = value;
  }

  // ---- 主流程：辨識並填入（絕不送出表單） ----
  async function recognize(reason) {
    if (state.stopped || state.busy) return;
    if (hasBehavioralCaptcha()) {
      log('偵測到行為式驗證（reCAPTCHA / hCaptcha / Turnstile），不動作');
      state.stopped = true;
      return;
    }

    const img = state.img && state.img.isConnected ? state.img : findImage();
    const input = state.input && state.input.isConnected ? state.input : findInput(img);
    if (!img || !input) return; // 頁面上沒有驗證碼或輸入框：不呼叫
    state.img = img;
    state.input = input;

    // 輸入框已有內容，且不是我們上次填的 → 使用者手動輸入過，不覆寫
    if (input.value && input.value !== state.lastFilled) {
      log('輸入框已有手動輸入內容，略過');
      return;
    }
    if (state.attempts >= MAX_ATTEMPTS) {
      log(`已達本頁最多辨識次數（${MAX_ATTEMPTS}），不再辨識`);
      return;
    }

    state.busy = true;
    try {
      await waitForImage(img);
      const src = img.src;
      if (state.handledSrcs.has(src)) return; // 同一張圖不重複辨識
      state.handledSrcs.add(src);
      state.attempts += 1;
      log(`開始辨識（第 ${state.attempts} 次，原因：${reason}）`);

      const b64 = await getImageBase64(img);
      const text = await callOcr(b64);

      // 6. 檢查長度是否合理
      if (text.length < SITE.minLen || text.length > SITE.maxLen) {
        warn(`辨識結果長度 ${text.length} 不在 ${SITE.minLen}–${SITE.maxLen} 範圍內，不填入（可點「換一張」重試）`);
        return;
      }
      // 送出 API 期間使用者可能已手動輸入，再檢查一次
      if (input.value && input.value !== state.lastFilled) {
        log('辨識期間使用者已手動輸入，不覆寫');
        return;
      }
      fillInput(input, text);
      log('已填入驗證碼，請自行確認後按登入');
    } catch (e) {
      error(e.message || e);
    } finally {
      state.busy = false;
    }
  }

  // ---- 監聽「換一張」：圖片 src 變化或圖片元素被替換 ----
  let debounceTimer = null;
  function scheduleRecognize(reason) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => recognize(reason), 200);
  }

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      if (state.stopped) { observer.disconnect(); return; }
      for (const m of mutations) {
        if (m.type === 'attributes' && m.target === state.img) {
          if (state.ownBlobUrls.has(state.img.src)) continue; // 我們自己換的 blob，忽略
          scheduleRecognize('圖片已更換');
          return;
        }
        if (m.type === 'childList' && state.img && !state.img.isConnected) {
          state.img = null; // 圖片元素被整個替換，重新定位
          scheduleRecognize('圖片元素已替換');
          return;
        }
      }
    });
    observer.observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['src'],
    });
  }

  // ---- SPA：輪詢等待登入框出現 ----
  function init() {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const img = findImage();
      if (img && findInput(img)) {
        clearInterval(timer);
        startObserver();
        recognize('頁面載入');
      } else if (tries >= POLL_MAX) {
        clearInterval(timer);
        log('未找到驗證碼圖片或輸入框，不動作（若網站有驗證碼，請檢查 SITES 選擇器）');
      }
    }, POLL_INTERVAL);
  }

  init();
})();
