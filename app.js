const MEDIAPIPE_FACE_MESH_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/face_mesh.js';
const MEDIAPIPE_ASSET_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/';

let mediaPipeFaceMesh = null;
let mediaPipeScriptPromise = null;
let currentRenderToken = 0;

const modeMeta = {
  natural: '元写真に近いまま、自然に整えます。',
  soft: 'やわらかい光に整えます。',
  clear: 'すっきりした印象に整えます。',
};

const els = {
  startPanel: document.getElementById('startPanel'),
  editorPanel: document.getElementById('editorPanel'),
  fileInput: document.getElementById('fileInput'),
  cameraInput: document.getElementById('cameraInput'),
  replaceInput: document.getElementById('replaceInput'),
  beforeImg: document.getElementById('beforeImg'),
  afterImg: document.getElementById('afterImg'),
  compareStage: document.getElementById('compareStage'),
  compareSlider: document.getElementById('compareSlider'),
  intensitySlider: document.getElementById('intensitySlider'),
  intensityOut: document.getElementById('intensityOut'),
  eyeSlider: document.getElementById('eyeSlider'),
  eyeOut: document.getElementById('eyeOut'),
  modeDescription: document.getElementById('modeDescription'),
  status: document.getElementById('status'),
  saveBtn: document.getElementById('saveBtn'),
  modeBtns: [...document.querySelectorAll('.mode-btn')],
};

const state = {
  mode: 'natural',
  sourceFile: null,
  sourceBlob: null,
  sourceUrl: '',
  outputBlob: null,
  outputUrl: '',
  imageWidth: 0,
  imageHeight: 0,
  lastMessage: '',
  isBusy: false,
};

init();

function init() {
  wireEvents();
  updateEyeOutput();
  registerServiceWorker();
}

function wireEvents() {
  [els.fileInput, els.cameraInput, els.replaceInput].forEach((input) => {
    input.addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      await loadSourceImage(file);
      event.target.value = '';
    });
  });

  els.compareSlider.addEventListener('input', () => {
    els.compareStage.style.setProperty('--split', `${els.compareSlider.value}%`);
  });

  els.intensitySlider.addEventListener('input', debounce(async () => {
    els.intensityOut.value = els.intensitySlider.value;
    await renderPreview();
  }, 120));

  els.eyeSlider.addEventListener('input', debounce(async () => {
    updateEyeOutput();
    await renderPreview();
  }, 120));

  els.modeBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.mode = btn.dataset.mode || 'natural';
      els.modeBtns.forEach((b) => b.classList.toggle('active', b === btn));
      els.modeDescription.textContent = modeMeta[state.mode] || modeMeta.natural;
      await renderPreview();
    });
  });

  els.saveBtn.addEventListener('click', saveCurrentImage);
  els.compareStage.addEventListener('pointerdown', updateCompareFromPointer);
  els.compareStage.addEventListener('pointermove', (event) => {
    if (event.buttons === 1) updateCompareFromPointer(event);
  });
}

async function loadSourceImage(file) {
  if (!file.type || !file.type.startsWith('image/')) {
    setStatus('画像ファイルを選んでください。', true);
    return;
  }

  try {
    setBusy(true, '写真を読み込んでいます。');
    state.sourceFile = file;
    state.sourceBlob = null;
    state.outputBlob = null;
    revokeUrl('sourceUrl');
    revokeUrl('outputUrl');

    const normalized = await normalizeImageFile(file, 1800);
    state.sourceBlob = normalized.blob;
    state.sourceUrl = URL.createObjectURL(normalized.blob);
    state.imageWidth = normalized.width;
    state.imageHeight = normalized.height;
    state.lastMessage = normalized.scaled
      ? `写真を読み込みました。`
      : '写真を読み込みました。';

    els.beforeImg.src = state.sourceUrl;
    els.afterImg.src = state.sourceUrl;
    els.startPanel.classList.add('hidden');
    els.editorPanel.classList.remove('hidden');

    await renderPreview(state.lastMessage);
  } catch (error) {
    console.error(error);
    setStatus('画像の読み込みに失敗しました。JPEGまたはPNGで再度お試しください。', true);
  } finally {
    setBusy(false);
  }
}

async function renderPreview(prefixMessage = '') {
  if (!state.sourceBlob) return;

  const token = ++currentRenderToken;
  try {
    setBusy(true, '写真を整えています。');
    const result = await makeLocalCorrection({
      blob: state.sourceBlob,
      mode: state.mode,
      intensity: Number(els.intensitySlider.value || 0),
      eyePercent: getEyePercent(),
    });
    if (token !== currentRenderToken) {
      URL.revokeObjectURL(result.url);
      return;
    }

    state.outputBlob = result.blob;
    revokeUrl('outputUrl');
    state.outputUrl = result.url;
    els.afterImg.src = state.outputUrl;

    const msg = prefixMessage || state.lastMessage || 'ローカル補正を反映しました。';
    setStatus('写真を整えました。');
  } catch (error) {
    console.error(error);
    setStatus('処理を調整しています。', true);
    try {
      const smaller = await normalizeImageFile(state.sourceFile, 1200);
      state.sourceBlob = smaller.blob;
      revokeUrl('sourceUrl');
      state.sourceUrl = URL.createObjectURL(smaller.blob);
      els.beforeImg.src = state.sourceUrl;
      await renderPreview('写真を整えました。');
    } catch (fallbackError) {
      console.error(fallbackError);
      setStatus('この画像形式は処理できませんでした。JPEGまたはPNGでお試しください。', true);
    }
  } finally {
    setBusy(false);
  }
}

async function makeLocalCorrection({ blob, mode, intensity, eyePercent }) {
  const decoded = await decodeBlobToCanvas(blob, 1600);
  const { canvas, ctx, width, height } = decoded;
  applyToneCorrection(ctx, width, height, mode, intensity);

  if (mode === 'soft') {
    applySoftLightFinish(ctx, width, height, intensity);
  } else if (mode === 'clear') {
    applyClearFinish(ctx, width, height, intensity);
  }

  let eyeApplied = false;
  if (eyePercent > 0) {
    const eyeHints = await detectEyesWithMediaPipe(canvas);
    if (eyeHints && eyeHints.length === 2) {
      eyeApplied = applyEyeEnlarge(canvas, ctx, eyeHints, eyePercent);
    }
  }

  const outBlob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
  return { blob: outBlob, url: URL.createObjectURL(outBlob), eyeApplied };
}

function applyToneCorrection(ctx, width, height, mode, intensity) {
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  const original = new Uint8ClampedArray(data);
  const i = Math.max(0, Math.min(30, intensity)) / 30;
  const p = getToneParams(mode, i);

  for (let k = 0; k < data.length; k += 4) {
    const or = original[k];
    const og = original[k + 1];
    const ob = original[k + 2];
    let r = or;
    let g = og;
    let b = ob;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const shadow = Math.max(0, 1 - lum / 135);
    const highlight = Math.max(0, (lum - 198) / 57);
    const blacks = Math.max(0, (78 - lum) / 78);

    // Lift only a little, and protect highlights/blacks to avoid washed-out results.
    r += p.shadowLift * shadow - p.highlightCompress * highlight - p.blackAnchor * blacks;
    g += p.shadowLift * shadow - p.highlightCompress * highlight - p.blackAnchor * blacks;
    b += p.shadowLift * shadow - p.highlightCompress * highlight - p.blackAnchor * blacks;

    r = (r - 128) * p.contrast + 128 + p.brightness;
    g = (g - 128) * p.contrast + 128 + p.brightness;
    b = (b - 128) * p.contrast + 128 + p.brightness;

    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    r = gray + (r - gray) * p.saturation;
    g = gray + (g - gray) * p.saturation;
    b = gray + (b - gray) * p.saturation;

    r += p.warmth;
    b -= p.warmth * 0.52;

    // Blend back with the original so the finish stays subtle and does not turn milky.
    r = or * (1 - p.blend) + r * p.blend;
    g = og * (1 - p.blend) + g * p.blend;
    b = ob * (1 - p.blend) + b * p.blend;

    data[k] = clamp(r);
    data[k + 1] = clamp(g);
    data[k + 2] = clamp(b);
  }

  ctx.putImageData(image, 0, 0);
}

function getToneParams(mode, i) {
  // v12: mode differences are intentionally visible.
  // Natural: close to the original, only a modest cleanup.
  const base = {
    brightness: 0.1 + 0.9 * i,
    contrast: 1 + 0.012 * i,
    saturation: 1 + 0.006 * i,
    shadowLift: 0.8 + 2.8 * i,
    highlightCompress: 1.6 + 4.5 * i,
    blackAnchor: 1.0 + 2.8 * i,
    warmth: 0.1 + 0.8 * i,
    blend: 0.35 + 0.22 * i,
  };

  // Soft Light: warmer and visibly softer, but highlights are protected.
  if (mode === 'soft') {
    return {
      brightness: 0.6 + 2.8 * i,
      contrast: 1 - 0.030 * i,
      saturation: 1 + 0.006 * i,
      shadowLift: 3.0 + 9.5 * i,
      highlightCompress: 3.2 + 9.5 * i,
      blackAnchor: 2.2 + 5.8 * i,
      warmth: 1.4 + 6.2 * i,
      blend: 0.58 + 0.28 * i,
    };
  }

  // Clear: darker blacks, cooler tone, clearer edges.
  if (mode === 'clear') {
    return {
      brightness: -0.8 - 0.6 * i,
      contrast: 1 + 0.070 * i,
      saturation: 1 + 0.030 * i,
      shadowLift: 0.0 + 0.6 * i,
      highlightCompress: 1.6 + 4.0 * i,
      blackAnchor: 4.0 + 10.0 * i,
      warmth: -0.6 - 1.2 * i,
      blend: 0.62 + 0.30 * i,
    };
  }

  return base;
}



function applySoftLightFinish(ctx, width, height, intensity) {
  const i = Math.max(0, Math.min(30, intensity)) / 30;
  if (i <= 0) return;

  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const sctx = source.getContext('2d');
  sctx.drawImage(ctx.canvas, 0, 0);

  ctx.save();
  ctx.globalAlpha = 0.10 + 0.18 * i;
  ctx.filter = `blur(${Math.max(2, Math.round(5 + 7 * i))}px) brightness(${1.02 + 0.05 * i})`;
  ctx.globalCompositeOperation = 'screen';
  ctx.drawImage(source, 0, 0);
  ctx.restore();

  // Gentle warm veil. Very low alpha, but visible enough to separate the mode.
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  ctx.globalAlpha = 0.08 + 0.12 * i;
  ctx.fillStyle = 'rgb(255, 226, 196)';
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

function applyClearFinish(ctx, width, height, intensity) {
  const i = Math.max(0, Math.min(30, intensity)) / 30;
  if (i <= 0) return;

  const image = ctx.getImageData(0, 0, width, height);
  const original = new Uint8ClampedArray(image.data);
  const data = image.data;
  const amount = 0.18 + 0.42 * i;

  // Light unsharp mask from four-neighbor contrast. This makes Clear visibly different.
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const center = original[idx + c];
        const n =
          original[idx - width * 4 + c] +
          original[idx + width * 4 + c] +
          original[idx - 4 + c] +
          original[idx + 4 + c];
        const blur = n / 4;
        data[idx + c] = clamp(center + (center - blur) * amount);
      }
    }
  }

  ctx.putImageData(image, 0, 0);
}

async function detectEyesWithMediaPipe(canvas) {
  try {
    await ensureMediaPipeFaceMesh();
    if (!mediaPipeFaceMesh) return null;
    const landmarks = await runFaceMesh(canvas);
    if (!landmarks || landmarks.length < 478) return null;

    const viewerLeft = buildMeshEyeHint(canvas, landmarks, {
      corners: [33, 133],
      lids: [159, 145],
      iris: [468, 469, 470, 471, 472],
    });
    const viewerRight = buildMeshEyeHint(canvas, landmarks, {
      corners: [362, 263],
      lids: [386, 374],
      iris: [473, 474, 475, 476, 477],
    });

    if (!viewerLeft || !viewerRight) return null;
    return [viewerLeft, viewerRight];
  } catch (error) {
    console.warn('[FaceMesh] eye detection skipped', error);
    return null;
  }
}

async function ensureMediaPipeFaceMesh() {
  if (mediaPipeFaceMesh) return;
  if (!window.FaceMesh) {
    if (!mediaPipeScriptPromise) mediaPipeScriptPromise = loadExternalScript(MEDIAPIPE_FACE_MESH_URL, 10000);
    await mediaPipeScriptPromise;
  }
  if (!window.FaceMesh) return;
  mediaPipeFaceMesh = new window.FaceMesh({ locateFile: (file) => `${MEDIAPIPE_ASSET_BASE}${file}` });
  mediaPipeFaceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

function runFaceMesh(canvas) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, 8000);

    mediaPipeFaceMesh.onResults((results) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(results && results.multiFaceLandmarks ? results.multiFaceLandmarks[0] : null);
    });

    Promise.resolve(mediaPipeFaceMesh.send({ image: canvas })).catch((error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(error);
    });
  });
}

function buildMeshEyeHint(canvas, landmarks, groups) {
  const irisPoints = groups.iris.map((index) => landmarks[index]).filter(Boolean);
  const cornerA = landmarks[groups.corners[0]];
  const cornerB = landmarks[groups.corners[1]];
  const upper = landmarks[groups.lids[0]];
  const lower = landmarks[groups.lids[1]];
  if (!cornerA || !cornerB || !upper || !lower) return null;

  const centerPoints = irisPoints.length >= 3 ? irisPoints : [cornerA, cornerB, upper, lower];
  const cx = centerPoints.reduce((sum, p) => sum + p.x, 0) / centerPoints.length;
  const cy = centerPoints.reduce((sum, p) => sum + p.y, 0) / centerPoints.length;
  const eyeWidth = Math.hypot((cornerA.x - cornerB.x) * canvas.width, (cornerA.y - cornerB.y) * canvas.height);
  const eyeHeight = Math.hypot((upper.x - lower.x) * canvas.width, (upper.y - lower.y) * canvas.height);

  if (!Number.isFinite(cx) || !Number.isFinite(cy) || eyeWidth < 8) return null;
  return {
    x: Math.max(0.02, Math.min(0.98, cx)),
    y: Math.max(0.02, Math.min(0.98, cy)),
    eyeWidth,
    eyeHeight: Math.max(eyeHeight, eyeWidth * 0.16),
  };
}

function applyEyeEnlarge(canvas, ctx, eyes, percent) {
  const width = canvas.width;
  const height = canvas.height;
  const scaleBase = Math.max(0, Math.min(8, percent)) / 100;
  if (scaleBase <= 0 || !eyes.length) return false;

  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const sctx = source.getContext('2d');
  sctx.drawImage(canvas, 0, 0);

  for (const eye of eyes) {
    const cx = eye.x * width;
    const cy = eye.y * height;
    const radiusX = Math.max(16, Math.min(width * 0.18, eye.eyeWidth * 0.68));
    const radiusY = Math.max(12, Math.min(height * 0.12, Math.max(eye.eyeHeight * 2.2, eye.eyeWidth * 0.30)));

    // Both axes are enlarged. X is never reduced, so the eye does not become narrower.
    const scaleX = 1 + scaleBase * 0.95;
    const scaleY = 1 + scaleBase * 1.15;
    drawSoftScaledPatch(ctx, source, cx, cy, radiusX, radiusY, scaleX, scaleY);
  }
  return true;
}

function drawSoftScaledPatch(ctx, sourceCanvas, cx, cy, radiusX, radiusY, scaleX, scaleY) {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  const patchW = Math.max(2, Math.ceil(radiusX * 2));
  const patchH = Math.max(2, Math.ceil(radiusY * 2));
  const sx = clampNumber(cx - radiusX / scaleX, 0, width - 1);
  const sy = clampNumber(cy - radiusY / scaleY, 0, height - 1);
  const sw = Math.max(2, Math.min(width - sx, (radiusX * 2) / scaleX));
  const sh = Math.max(2, Math.min(height - sy, (radiusY * 2) / scaleY));
  const dx = Math.round(cx - patchW / 2);
  const dy = Math.round(cy - patchH / 2);

  const patch = document.createElement('canvas');
  patch.width = patchW;
  patch.height = patchH;
  const pctx = patch.getContext('2d');
  if (!pctx) return;
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, patchW, patchH);

  // Elliptical feather. This hides patch edges and avoids visible frame breaks.
  pctx.globalCompositeOperation = 'destination-in';
  pctx.translate(patchW / 2, patchH / 2);
  pctx.scale(patchW / 2, patchH / 2);
  const grad = pctx.createRadialGradient(0, 0, 0.56, 0, 0, 1);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.70, 'rgba(0,0,0,.92)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  pctx.fillStyle = grad;
  pctx.beginPath();
  pctx.arc(0, 0, 1, 0, Math.PI * 2);
  pctx.fill();
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.globalCompositeOperation = 'source-over';

  ctx.drawImage(patch, dx, dy);
}

async function normalizeImageFile(file, maxLongEdge = 1800) {
  const decoded = await decodeBlobToCanvas(file, maxLongEdge);
  const blob = await canvasToBlob(decoded.canvas, 'image/jpeg', 0.92);
  const longEdge = Math.max(decoded.width, decoded.height);
  return { blob, width: decoded.width, height: decoded.height, longEdge, scaled: decoded.scaled };
}

async function decodeBlobToCanvas(blob, maxLongEdge = 1800) {
  let bitmap = null;
  if ('createImageBitmap' in window) {
    try {
      bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (error) {
      console.warn('[decode] createImageBitmap fallback', error);
    }
  }

  if (bitmap) {
    const fitted = fitSize(bitmap.width, bitmap.height, maxLongEdge);
    const canvas = document.createElement('canvas');
    canvas.width = fitted.width;
    canvas.height = fitted.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, fitted.width, fitted.height);
    if (bitmap.close) bitmap.close();
    return { canvas, ctx, width: fitted.width, height: fitted.height, scaled: fitted.scaled };
  }

  const img = await loadImageElement(blob);
  const fitted = fitSize(img.naturalWidth || img.width, img.naturalHeight || img.height, maxLongEdge);
  const canvas = document.createElement('canvas');
  canvas.width = fitted.width;
  canvas.height = fitted.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, fitted.width, fitted.height);
  return { canvas, ctx, width: fitted.width, height: fitted.height, scaled: fitted.scaled };
}

function loadImageElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めませんでした。'));
    };
    img.src = url;
  });
}

function fitSize(width, height, maxLongEdge) {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return { width, height, scaled: false };
  const scale = maxLongEdge / longEdge;
  return { width: Math.round(width * scale), height: Math.round(height * scale), scaled: true };
}

function loadExternalScript(src, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (window.FaceMesh) resolve();
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    const script = document.createElement('script');
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('FaceMeshの読み込みがタイムアウトしました。'));
    }, timeoutMs);
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    script.onerror = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(new Error('FaceMeshを読み込めませんでした。'));
    };
    document.head.appendChild(script);
  });
}

function updateCompareFromPointer(event) {
  const rect = els.compareStage.getBoundingClientRect();
  const percent = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
  els.compareSlider.value = String(percent);
  els.compareStage.style.setProperty('--split', `${percent}%`);
}

async function saveCurrentImage() {
  const blob = state.outputBlob || state.sourceBlob;
  if (!blob) {
    setStatus('保存する画像がありません。', true);
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.href = url;
  link.download = `ai-kirei-filter-air-${stamp}.jpg`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus('写真を保存しました。');
}

async function hardRefresh() {
  setStatus('キャッシュを更新しています。');
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((reg) => reg.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (error) {
    console.warn(error);
  }
  window.location.reload();
}

function getEyePercent() {
  return Number(els.eyeSlider.value || 0) / 10;
}

function updateEyeOutput() {
  const v = getEyePercent();
  els.eyeOut.value = v <= 0 ? 'OFF' : `${v.toFixed(1)}%`;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('画像を書き出せませんでした。'));
    }, type, quality);
  });
}

function revokeUrl(key) {
  if (state[key]) URL.revokeObjectURL(state[key]);
  state[key] = '';
}

function setBusy(isBusy, message = '') {
  state.isBusy = isBusy;
  document.body.classList.toggle('is-busy', isBusy);
  if (message) setStatus(message);
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', Boolean(isError));
}

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function debounce(fn, delay) {
  let timer = 0;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch (error) {
    console.warn('[SW] registration skipped', error);
  }
}
