/* ── ScanIQ — app.js ──────────────────────────────────────────────────────── */

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const LS_KEY = 'scaniq_groq_key';

const ANALYSIS_PROMPT = `You are a product identification and pricing expert. Analyze this product image carefully.

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):
{
  "found": true,
  "product": "Full product name",
  "brand": "Brand or manufacturer",
  "category": "Product category (e.g. Electronics, Food, Beverage, Personal Care, Clothing)",
  "price_low": 9.99,
  "price_high": 14.99,
  "currency": "USD",
  "rating": 4,
  "description": "One or two sentences about the product quality, typical use, or key features.",
  "alternatives": ["Alternative product 1", "Alternative product 2", "Alternative product 3"]
}

If you cannot identify any product, return:
{"found": false, "reason": "Brief reason"}

Rules:
- rating must be 1–5 (integer)
- price_low and price_high must be numbers (no currency symbols)
- alternatives must have exactly 2–3 items
- Keep description under 120 characters`;

/* ── State ─────────────────────────────────────────────────────────────────── */
let apiKey = '';
let currentModel = '';
let stream = null;
let lastResult = null;

/* ── DOM refs ──────────────────────────────────────────────────────────────── */
const video       = document.getElementById('video');
const canvas      = document.getElementById('capture-canvas');
const captureBtn  = document.getElementById('capture-btn');
const resultCard  = document.getElementById('result-card');
const cardContent = document.getElementById('card-content');
const scanAgain   = document.getElementById('scan-again-btn');
const shareBtn    = document.getElementById('share-btn');
const settingsBtn = document.getElementById('settings-btn');
const flash       = document.getElementById('flash');
const hint        = document.getElementById('hint');
const noCamera    = document.getElementById('no-camera');

// Modal
const apiModal     = document.getElementById('api-modal');
const apiKeyInput  = document.getElementById('api-key-input');
const saveKeyBtn   = document.getElementById('save-key-btn');
const toggleVis    = document.getElementById('toggle-visibility');

/* ── Init ──────────────────────────────────────────────────────────────────── */
async function init() {
  // 1. Resolve API key: config.js > localStorage > modal
  apiKey = (typeof GROQ_API_KEY !== 'undefined' && GROQ_API_KEY.trim())
    ? GROQ_API_KEY.trim()
    : (localStorage.getItem(LS_KEY) || '');

  if (!apiKey) {
    showApiModal();
    return;
  }

  await startCamera();

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/* ── API Key Modal ─────────────────────────────────────────────────────────── */
function showApiModal() {
  apiModal.classList.remove('hidden');
  setTimeout(() => apiKeyInput.focus(), 300);
}

function hideApiModal() {
  apiModal.classList.add('hidden');
}

saveKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) { apiKeyInput.focus(); return; }
  apiKey = key;
  localStorage.setItem(LS_KEY, key);
  hideApiModal();
  await startCamera();
});

apiKeyInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') saveKeyBtn.click();
});

toggleVis.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  toggleVis.querySelector('svg').innerHTML = isPassword
    ? `<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`
    : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
});

settingsBtn.addEventListener('click', () => {
  apiKeyInput.value = '';
  apiKeyInput.type = 'password';
  showApiModal();
});

/* ── Camera ────────────────────────────────────────────────────────────────── */
async function startCamera() {
  const constraints = {
    video: {
      facingMode: { ideal: 'environment' },
      width:  { ideal: 1920 },
      height: { ideal: 1080 }
    }
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();
    captureBtn.classList.add('ready');
  } catch (err) {
    // Try any camera
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true });
      video.srcObject = stream;
      await video.play();
      captureBtn.classList.add('ready');
    } catch {
      noCamera.classList.add('visible');
      captureBtn.disabled = true;
    }
  }
}

/* ── Capture Frame ─────────────────────────────────────────────────────────── */
function captureFrame() {
  const w = video.videoWidth  || 640;
  const h = video.videoHeight || 480;

  // Cap at 1280px wide to keep payload reasonable
  const scale = Math.min(1, 1280 / w);
  canvas.width  = Math.round(w * scale);
  canvas.height = Math.round(h * scale);

  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // JPEG at 85% quality
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
}

/* ── Flash animation ───────────────────────────────────────────────────────── */
function doFlash() {
  flash.classList.add('active');
  setTimeout(() => flash.classList.remove('active'), 150);
}

/* ── Groq API call ─────────────────────────────────────────────────────────── */
async function analyzeImage(base64) {
  const models = [
    typeof GROQ_MODEL_PRIMARY  !== 'undefined' ? GROQ_MODEL_PRIMARY  : 'meta-llama/llama-4-scout-17b-16e-instruct',
    typeof GROQ_MODEL_FALLBACK !== 'undefined' ? GROQ_MODEL_FALLBACK : 'llava-v1.5-7b-4096-preview'
  ];

  let lastErr;
  for (const model of models) {
    try {
      const res = await fetch(GROQ_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'high' }
              },
              { type: 'text', text: ANALYSIS_PROMPT }
            ]
          }],
          max_tokens: 512,
          temperature: 0.2
        })
      });

      if (res.status === 401) throw new Error('Invalid API key');
      if (res.status === 413) throw new Error('Image too large');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // If model not found, try next
        if (res.status === 400 && body?.error?.message?.includes('model')) continue;
        throw new Error(body?.error?.message || `HTTP ${res.status}`);
      }

      const data = await res.json();
      currentModel = model;
      const raw = data?.choices?.[0]?.message?.content?.trim() || '';
      return parseGroqResponse(raw);
    } catch (err) {
      if (err.message === 'Invalid API key') {
        apiKey = '';
        localStorage.removeItem(LS_KEY);
        showApiModal();
        throw err;
      }
      lastErr = err;
    }
  }
  throw lastErr || new Error('All models failed');
}

/* ── Parse response ────────────────────────────────────────────────────────── */
function parseGroqResponse(raw) {
  // Strip markdown fences if present
  const clean = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

  // Extract first JSON object
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');

  const obj = JSON.parse(match[0]);
  return obj;
}

/* ── Render result card ────────────────────────────────────────────────────── */
function renderResult(data) {
  lastResult = data;

  if (!data.found) {
    cardContent.innerHTML = buildErrorHTML(data.reason || 'Could not identify product');
  } else {
    cardContent.innerHTML = buildResultHTML(data);
  }

  resultCard.classList.add('open');
  hint.style.opacity = '0';
}

function buildResultHTML(d) {
  const priceStr = d.price_low && d.price_high
    ? `$${(+d.price_low).toFixed(2)} – $${(+d.price_high).toFixed(2)}`
    : 'Price unavailable';

  const rating = Math.min(5, Math.max(1, Math.round(d.rating) || 3));
  const starsHTML = Array.from({ length: 5 }, (_, i) =>
    `<svg class="star ${i < rating ? '' : 'empty'}" viewBox="0 0 24 24" fill="currentColor">
       <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
     </svg>`
  ).join('');

  const alts = (d.alternatives || []).slice(0, 3);
  const altsHTML = alts.map(a =>
    `<div class="alt-item"><div class="alt-dot"></div>${escapeHTML(a)}</div>`
  ).join('');

  return `
    <div class="category-pill">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/>
        <line x1="7" y1="7" x2="7.01" y2="7"/>
      </svg>
      ${escapeHTML(d.category || 'Product')}
    </div>
    <h2 class="product-name">${escapeHTML(d.product || 'Unknown Product')}</h2>
    <p class="brand-name">${escapeHTML(d.brand || '')}</p>
    <div class="meta-row">
      <div class="price-block">
        <div class="label">Est. Price</div>
        <div class="value">${escapeHTML(priceStr)}</div>
      </div>
      <div class="rating-block">
        <div class="label">Rating</div>
        <div class="stars">${starsHTML}</div>
      </div>
    </div>
    ${d.description ? `<p class="description">${escapeHTML(d.description)}</p>` : ''}
    ${alts.length ? `
      <p class="section-label">Alternatives</p>
      <div class="alternatives">${altsHTML}</div>
    ` : ''}
  `;
}

function buildErrorHTML(reason) {
  return `
    <div class="error-card">
      <div class="category-pill">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        Notice
      </div>
      <h2 class="product-name">Couldn't identify product</h2>
      <p class="description" style="margin-top:8px">${escapeHTML(reason)}</p>
    </div>
  `;
}

/* ── Capture flow ──────────────────────────────────────────────────────────── */
captureBtn.addEventListener('click', async () => {
  if (captureBtn.disabled) return;

  captureBtn.disabled = true;
  captureBtn.classList.remove('ready');
  captureBtn.classList.add('loading');
  hint.style.opacity = '0';

  doFlash();

  try {
    const base64 = captureFrame();
    const result = await analyzeImage(base64);
    renderResult(result);
  } catch (err) {
    if (err.message !== 'Invalid API key') {
      renderResult({ found: false, reason: err.message || 'Analysis failed. Please try again.' });
    }
  } finally {
    captureBtn.disabled = false;
    captureBtn.classList.remove('loading');
  }
});

/* ── Scan again ────────────────────────────────────────────────────────────── */
function resetToScanner() {
  resultCard.classList.remove('open');
  hint.style.opacity = '1';
  captureBtn.classList.add('ready');
  lastResult = null;
}

scanAgain.addEventListener('click', resetToScanner);

// Swipe down to dismiss
let touchStartY = 0;
resultCard.addEventListener('touchstart', e => { touchStartY = e.touches[0].clientY; }, { passive: true });
resultCard.addEventListener('touchend', e => {
  if (e.changedTouches[0].clientY - touchStartY > 80) resetToScanner();
}, { passive: true });

/* ── Share ─────────────────────────────────────────────────────────────────── */
shareBtn.addEventListener('click', async () => {
  if (!lastResult?.found) return;
  const d = lastResult;
  const text = `${d.product} by ${d.brand}\nEstimated price: $${(+d.price_low).toFixed(2)} – $${(+d.price_high).toFixed(2)}\nScanned with ScanIQ`;
  if (navigator.share) {
    navigator.share({ title: d.product, text }).catch(() => {});
  } else {
    await navigator.clipboard.writeText(text).catch(() => {});
    shareBtn.style.color = '#4ade80';
    setTimeout(() => { shareBtn.style.color = ''; }, 1200);
  }
});

/* ── Helpers ───────────────────────────────────────────────────────────────── */
function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Start ─────────────────────────────────────────────────────────────────── */
init();
