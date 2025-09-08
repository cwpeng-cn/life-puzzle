// Simple persistent store for projects (metadata only; images in IndexedDB)
const Store = {
  key: 'puzzele.projects.v1',
  selKey: 'puzzele.selectedId',
  load() {
    try {
      const raw = localStorage.getItem(this.key);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      console.warn('load store failed', e);
      return [];
    }
  },
  save(projects) {
    // strip large transient fields before persisting
    const slim = projects.map(p => {
      const { image, _imageUrl, ...rest } = p || {};
      return rest;
    });
    localStorage.setItem(this.key, JSON.stringify(slim));
  },
  selectedId() {
    return localStorage.getItem(this.selKey);
  },
  setSelectedId(id) {
    if (id == null) localStorage.removeItem(this.selKey);
    else localStorage.setItem(this.selKey, String(id));
  }
};

// IndexedDB wrapper for image blobs
const ImageDB = {
  db: null,
  urlCache: new Map(),
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('puzzele-db', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('images')) {
          db.createObjectStore('images', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  },
  async put(id, blob) {
    const db = await this.open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('images', 'readwrite');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.objectStore('images').put({ id, blob });
    });
    // refresh url cache
    this.revokeUrl(id);
  },
  async get(id) {
    const db = await this.open();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('images', 'readonly');
      tx.onerror = () => reject(tx.error);
      const req = tx.objectStore('images').get(id);
      req.onsuccess = () => resolve(req.result?.blob || null);
      req.onerror = () => reject(req.error);
    });
  },
  async getUrl(id) {
    if (!id) return null;
    if (this.urlCache.has(id)) return this.urlCache.get(id);
    const blob = await this.get(id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.urlCache.set(id, Promise.resolve(url));
    return url;
  },
  revokeUrl(id) {
    const entry = this.urlCache.get(id);
    if (!entry) return;
    Promise.resolve(entry).then(url => { try { URL.revokeObjectURL(url); } catch {} });
    this.urlCache.delete(id);
  }
};

function uid() { return Math.random().toString(36).slice(2, 10); }

// Edge utils for jigsaw pieces
function makeEdges(rows, cols, rng=Math) {
  const h = []; // (rows-1) x cols
  const v = []; // rows x (cols-1)
  for (let r = 0; r < rows - 1; r++) {
    h[r] = [];
    for (let c = 0; c < cols; c++) h[r][c] = rng.random() > 0.5 ? 1 : -1;
  }
  for (let r = 0; r < rows; r++) {
    v[r] = [];
    for (let c = 0; c < cols - 1; c++) v[r][c] = rng.random() > 0.5 ? 1 : -1;
  }
  return { h, v };
}

// Build a jigsaw piece path for given edges
function piecePath(w, h, edgeTop, edgeRight, edgeBottom, edgeLeft) {
  // edgeX: 0 flat, +1 tab outwards, -1 blank inwards relative to this tile
  // Use cubic curves approximating a circle-like tab
  const tab = Math.min(w, h) * 0.23;
  const neck = tab * 0.4;
  const ctrl = tab * 0.6;

  // We construct the full path manually for better control
  const cmds = [];
  // Move to top-left
  cmds.push(`M 0 0`);
  // Top edge
  if (edgeTop === 0) cmds.push(`L ${w} 0`);
  else {
    const y = 0, mid = w/2, sign = edgeTop;
    cmds.push(`L ${mid - neck} ${y}`);
    cmds.push(`C ${mid - neck} ${y} ${mid - neck} ${y - sign*ctrl} ${mid} ${y - sign*ctrl}`);
    cmds.push(`C ${mid + neck} ${y - sign*ctrl} ${mid + neck} ${y} ${mid + neck} ${y}`);
    cmds.push(`L ${w} ${y}`);
  }
  // Right edge
  if (edgeRight === 0) cmds.push(`L ${w} ${h}`);
  else {
    const x = w, mid = h/2, sign = edgeRight;
    cmds.push(`L ${x} ${mid - neck}`);
    cmds.push(`C ${x} ${mid - neck} ${x + sign*ctrl} ${mid - neck} ${x + sign*ctrl} ${mid}`);
    cmds.push(`C ${x + sign*ctrl} ${mid + neck} ${x} ${mid + neck} ${x} ${mid + neck}`);
    cmds.push(`L ${x} ${h}`);
  }
  // Bottom edge
  if (edgeBottom === 0) cmds.push(`L 0 ${h}`);
  else {
    const y = h, mid = w/2, sign = edgeBottom;
    cmds.push(`L ${mid + neck} ${y}`);
    cmds.push(`C ${mid + neck} ${y} ${mid + neck} ${y + sign*ctrl} ${mid} ${y + sign*ctrl}`);
    cmds.push(`C ${mid - neck} ${y + sign*ctrl} ${mid - neck} ${y} ${mid - neck} ${y}`);
    cmds.push(`L 0 ${y}`);
  }
  // Left edge
  if (edgeLeft === 0) cmds.push(`Z`);
  else {
    const x = 0, mid = h/2, sign = edgeLeft;
    cmds.push(`L ${x} ${mid + neck}`);
    cmds.push(`C ${x} ${mid + neck} ${x - sign*ctrl} ${mid + neck} ${x - sign*ctrl} ${mid}`);
    cmds.push(`C ${x - sign*ctrl} ${mid - neck} ${x} ${mid - neck} ${x} ${mid - neck}`);
    cmds.push(`L 0 0`);
    cmds.push(`Z`);
  }

  return cmds.join(' ');
}

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

// Puzzle renderer
class Puzzle {
  constructor(container) {
    this.container = container;
    this.stage = document.createElement('div');
    this.stage.className = 'puzzle-stage';
    this.container.innerHTML = '';
    this.container.appendChild(this.stage);
    window.addEventListener('resize', () => this.layout());
  }
  setProject(project) {
    this.project = project;
    this.render();
  }
  layout() {
    // recalculates piece positions when size changes
    if (!this.project) return;
    this.render(true);
  }
  render(skipReset=false) {
    const p = this.project;
    if (!p) {
      this.stage.innerHTML = '';
      return;
    }
    const cols = p.cols, rows = p.rows;
    // Fit stage to container using image aspect ratio so the full image shows
    const containerRect = this.container.getBoundingClientRect();
    const maxW = Math.max(200, containerRect.width - 24);
    const maxH = Math.max(200, containerRect.height - 24);
    const aspect = p.imageAspect || (16/10);
    let W = Math.floor(maxW);
    let H = Math.floor(W / aspect);
    if (H > maxH) { H = Math.floor(maxH); W = Math.floor(H * aspect); }
    const pieceW = W / cols;
    const pieceH = H / rows;

    if (!skipReset) this.stage.innerHTML = '';

    // Ensure edges exist
    if (!p.hEdges || !p.vEdges) {
      const edges = makeEdges(rows, cols);
      p.hEdges = edges.h; // between r and r+1
      p.vEdges = edges.v; // between c and c+1
      saveProject(p);
    }

    const total = rows * cols;
    const revealedSet = new Set(p.revealed || []);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const el = document.createElement('div');
        el.className = 'piece' + (revealedSet.has(i) ? ' revealed' : '');
        el.style.left = `${c * pieceW}px`;
        el.style.top = `${r * pieceH}px`;
        el.style.width = `${pieceW}px`;
        el.style.height = `${pieceH}px`;
        const bgUrl = p._imageUrl || null;
        el.style.backgroundImage = bgUrl ? `url(${bgUrl})` : 'linear-gradient(135deg, #ece9e1, #ddd4c5)';
        el.style.backgroundSize = `${W}px ${H}px`;
        el.style.backgroundPosition = `${-c * pieceW}px ${-r * pieceH}px`;

        // Determine edges for this piece
        const top = (r === 0) ? 0 : -p.hEdges[r-1][c];
        const right = (c === cols-1) ? 0 : p.vEdges[r][c];
        const bottom = (r === rows-1) ? 0 : p.hEdges[r][c];
        const left = (c === 0) ? 0 : -p.vEdges[r][c-1];
        const d = piecePath(pieceW, pieceH, top, right, bottom, left);
        el.style.webkitClipPath = `path('${d}')`;
        el.style.clipPath = `path('${d}')`;

        this.stage.appendChild(el);
      }
    }

    // stage size to match grid and center
    this.stage.style.width = `${W}px`;
    this.stage.style.height = `${H}px`;
  }

  reveal(count) {
    const p = this.project;
    if (!p) return 0;
    const cols = p.cols, rows = p.rows;
    const total = rows * cols;
    const revealedSet = new Set(p.revealed || []);
    const hidden = [];
    for (let i = 0; i < total; i++) if (!revealedSet.has(i)) hidden.push(i);
    const toReveal = Math.min(count, hidden.length);
    // shuffle
    for (let i = hidden.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [hidden[i], hidden[j]] = [hidden[j], hidden[i]];
    }
    const pick = hidden.slice(0, toReveal);
    // apply to DOM first for animation
    const nodes = this.stage.querySelectorAll('.piece');
    for (const idx of pick) {
      const el = nodes[idx];
      if (el) requestAnimationFrame(() => el.classList.add('revealed'));
    }
    // update data and lightweight UI
    p.revealed = [...revealedSet, ...pick];
    p.progress = Math.round((p.revealed.length / total) * 100);
    saveAll();
    updateSidebar();
    updateProgressUIOnly(p.progress);
    return toReveal;
  }
}

// Global state
let projects = Store.load();
let selectedId = Store.selectedId();
let selected = projects.find(p => p.id === selectedId) || null;
function saveAll() { Store.save(projects); }
function saveProject(p) {
  const i = projects.findIndex(x => x.id === p.id);
  if (i >= 0) projects[i] = p; else projects.push(p);
  saveAll();
  updateSidebar();
  updateToolbar();
}

// UI refs
const els = {
  list: document.getElementById('projectList'),
  newBtn: document.getElementById('newProjectBtn'),
  dlg: document.getElementById('newProjectDialog'),
  form: document.getElementById('newProjectForm'),
  name: document.getElementById('projName'),
  img: document.getElementById('projImage'),
  preview: document.getElementById('imagePreview'),
  previewStage: document.getElementById('previewStage'),
  title: document.getElementById('currentProjectName'),
  progressBar: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
  puzzle: new Puzzle(document.getElementById('puzzleContainer')),
  deleteBtn: document.getElementById('deleteProjectBtn'),
  sessionPercent: document.getElementById('sessionPercent'),
  minutesInput: document.getElementById('minutesInput'),
  timerDisplay: document.getElementById('timerDisplay'),
  startBtn: document.getElementById('startBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  resetBtn: document.getElementById('resetBtn'),
  completeBtn: document.getElementById('completeBtn')
};

function updateSidebar() {
  els.list.innerHTML = '';
  projects.forEach(p => {
    const li = document.createElement('li');
    li.className = 'project-item' + (selected && selected.id === p.id ? ' active' : '');
    li.innerHTML = `<div class="name">${p.name}</div><div class="meta">${p.progress || 0}% ・ ${p.cols}×${p.rows}</div>`;
    li.addEventListener('click', () => selectProject(p.id));
    els.list.appendChild(li);
  });
}

function updateToolbar() {
  if (!selected) {
    els.title.textContent = '未選擇專案';
    els.progressText.textContent = '0%';
    els.progressBar.style.width = '0%';
    els.puzzle.setProject(null);
    return;
  }
  els.title.textContent = selected.name;
  const pct = clamp(Math.round(selected.progress || 0), 0, 100);
  updateProgressUIOnly(pct);
  els.puzzle.setProject(selected);
  els.deleteBtn.disabled = !selected;
}

function updateProgressUIOnly(pct) {
  const clamped = clamp(Math.round(pct || 0), 0, 100);
  els.progressText.textContent = clamped + '%';
  els.progressBar.style.width = clamped + '%';
}

// Delete project
ImageDB.del = async function(id) {
  if (!id) return;
  const db = await this.open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('images', 'readwrite');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.objectStore('images').delete(id);
  });
  this.revokeUrl(id);
};

async function deleteProject(id) {
  const p = projects.find(x => x.id === id);
  if (!p) return;
  const ok = confirm(`確定要刪除專案「${p.name}」嗎？此動作無法復原。`);
  if (!ok) return;
  try { if (p.imageRef) await ImageDB.del(p.imageRef); } catch {}
  projects = projects.filter(x => x.id !== id);
  // Fix selection
  if (selected && selected.id === id) {
    if (projects.length) {
      const next = projects[0];
      Store.setSelectedId(next.id);
      selectedId = next.id; selected = next;
    } else {
      Store.setSelectedId('');
      selectedId = null; selected = null;
    }
  }
  saveAll();
  updateSidebar();
  updateToolbar();
  if (!selected) { els.puzzle.setProject(null); }
}

els.deleteBtn.addEventListener('click', () => { if (selected) deleteProject(selected.id); });

function selectProject(id) {
  selectedId = id;
  Store.setSelectedId(id);
  selected = projects.find(p => p.id === id) || null;
  updateSidebar();
  updateToolbar();
  // load image asynchronously if needed
  if (selected && selected.imageRef) {
    loadProjectImage(selected, id);
  }
}

function loadProjectImage(p, expectedId) {
  ImageDB.getUrl(p.imageRef).then(async url => {
    if (!selected || selected.id !== expectedId) return; // changed selection
    p._imageUrl = url || null;
    if (url) {
      try {
        const meta = await probeImage(url);
        p.imageAspect = meta.aspect;
      } catch {}
    }
    els.puzzle.setProject(p);
  }).catch(() => {});
}

function probeImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth||img.width, height: img.naturalHeight||img.height, aspect: (img.naturalWidth||img.width)/ (img.naturalHeight||img.height) });
    img.onerror = reject;
    img.src = url;
  });
}

// New project modal
els.newBtn.addEventListener('click', () => {
  els.name.value = '';
  // fixed 10x10; no inputs
  els.img.value = '';
  els.preview.textContent = '未選擇圖片';
  els.preview.style.backgroundImage = '';
  clearPreviewPuzzle();
  els.dlg.showModal();
});

let tempImageFile = null;
let tempImageURL = null;
let tempImageAspect = null;
function setTempImage(file) {
  // revoke previous
  if (tempImageURL) { try { URL.revokeObjectURL(tempImageURL); } catch {} }
  tempImageFile = file || null;
  tempImageURL = file ? URL.createObjectURL(file) : null;
  if (tempImageURL) {
    els.preview.textContent = '';
    els.preview.style.backgroundImage = `url(${tempImageURL})`;
    // probe aspect
    probeImage(tempImageURL).then(meta => { tempImageAspect = meta.aspect; renderPreviewPuzzle(); }).catch(()=>{ tempImageAspect = null; });
  } else {
    els.preview.textContent = '未選擇圖片';
    els.preview.style.backgroundImage = '';
    tempImageAspect = null;
  }
  renderPreviewPuzzle();
}
els.img.addEventListener('change', (e) => {
  const file = e.target.files?.[0] || null;
  setTempImage(file);
});

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = els.name.value.trim();
  const rows = 10;
  const cols = 10;
  if (!name) return;
  const id = uid();
  const edges = makeEdges(rows, cols);
  const proj = {
    id, name, rows, cols,
    imageRef: null,
    createdAt: Date.now(),
    progress: 0,
    revealed: [],
    hEdges: edges.h,
    vEdges: edges.v
  };
  // store image blob in IndexedDB if provided
  if (tempImageFile) {
    const imgId = `img_${id}`;
    try { await ImageDB.put(imgId, tempImageFile); proj.imageRef = imgId; }
    catch (err) { console.warn('save image failed', err); }
  }
  projects.push(proj);
  saveAll();
  selectProject(id);
  els.dlg.close();
});

// Timer logic
const Timer = {
  running: false,
  seconds: 25*60,
  left: 25*60,
  id: null,
  setMinutes(min) {
    this.seconds = Math.round(min * 60);
    this.left = this.seconds;
    renderTimer();
  },
  start() {
    if (this.running) return;
    this.running = true;
    const start = Date.now();
    let last = start;
    this.id = setInterval(() => {
      const now = Date.now();
      const delta = Math.floor((now - last)/1000);
      if (delta >= 1) {
        this.left -= delta;
        last = now;
        if (this.left <= 0) {
          this.left = 0;
          renderTimer();
          this.stop();
          onTimerComplete();
          return;
        }
        renderTimer();
      }
    }, 250);
    renderTimer();
    updateTimerButtons();
  },
  pause() {
    if (!this.running) return;
    clearInterval(this.id); this.id = null; this.running = false; updateTimerButtons();
  },
  stop() { clearInterval(this.id); this.id = null; this.running = false; updateTimerButtons(); },
  reset() { this.left = this.seconds; this.stop(); renderTimer(); }
};

function renderTimer() {
  const m = Math.floor(Timer.left/60).toString().padStart(2,'0');
  const s = Math.floor(Timer.left%60).toString().padStart(2,'0');
  els.timerDisplay.textContent = `${m}:${s}`;
}
function updateTimerButtons() {
  els.startBtn.disabled = Timer.running;
  els.pauseBtn.disabled = !Timer.running;
}
function onTimerComplete() {
  // Apply progress increment
  const pct = clamp(parseFloat(els.sessionPercent.value||'0'), 0, 100);
  if (!selected) return;
  const totalPieces = selected.rows * selected.cols;
  const currentPieces = (selected.revealed || []).length;
  const targetPct = clamp((selected.progress || 0) + pct, 0, 100);
  const targetPieces = Math.round(targetPct * totalPieces / 100);
  const need = Math.max(0, targetPieces - currentPieces);
  const added = els.puzzle.reveal(need);
  // Subtle celebration
  flashToast(`完成！拼圖新增 ${added} 塊`);
  // Refresh quote for next番茄鐘
  loadRandomQuote();
}

// Controls wiring
els.minutesInput.addEventListener('change', () => {
  const v = clamp(parseInt(els.minutesInput.value||'25',10),1,180);
  els.minutesInput.value = String(v);
  Timer.setMinutes(v);
});
els.startBtn.addEventListener('click', () => Timer.start());
els.pauseBtn.addEventListener('click', () => Timer.pause());
els.resetBtn.addEventListener('click', () => Timer.reset());
els.completeBtn.addEventListener('click', () => { Timer.stop(); onTimerComplete(); });

// Toast
let toastEl;
function flashToast(text) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    Object.assign(toastEl.style, {
      position: 'fixed', left: '50%', top: '20px', transform: 'translateX(-50%)',
      background: 'rgba(0,0,0,0.8)', color: 'white', padding: '10px 14px', borderRadius: '10px',
      zIndex: 1000, fontWeight: '600', letterSpacing: '1px', boxShadow: '0 8px 20px rgba(0,0,0,0.2)'
    });
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.style.opacity = '0';
  toastEl.style.transition = 'opacity .2s ease';
  requestAnimationFrame(() => {
    toastEl.style.opacity = '1';
    setTimeout(() => { toastEl.style.opacity = '0'; }, 1200);
  });
}

// Init
updateSidebar();
if (selected) selectProject(selected.id); else updateToolbar();
Timer.setMinutes(parseInt(els.minutesInput.value,10) || 25);

// Load and show a random quote from word.txt
async function loadRandomQuote() {
  const box = document.getElementById('quoteBox');
  if (!box) return;
  box.textContent = '…';
  const candidates = [];
  try {
    // 1) relative to current document
    candidates.push(new URL('word.txt', document.baseURI).toString());
  } catch {}
  try {
    // 2) root path
    candidates.push(new URL('/word.txt', location.origin).toString());
  } catch {}
  // 3) if the app is under a subdirectory (e.g., /puzzele/), try that explicitly
  try {
    const baseDir = location.pathname.endsWith('/')
      ? location.pathname
      : location.pathname.replace(/[^/]+$/, '/');
    candidates.push(new URL(baseDir + 'word.txt', location.origin).toString());
  } catch {}

  let lastErr = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`);
      // Decode with charset fallback: utf-8 -> gb18030 -> gbk -> big5
      const buf = await res.arrayBuffer();
      const tryDecode = (label) => {
        try { return new TextDecoder(label, { fatal: true }).decode(buf); }
        catch { return null; }
      };
      let text = tryDecode('utf-8');
      if (text == null) text = tryDecode('gb18030');
      if (text == null) text = tryDecode('gbk');
      if (text == null) text = tryDecode('big5');
      if (text == null) text = new TextDecoder().decode(buf);
      const lines = text
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(s => s && !s.startsWith('#'));
      if (!lines.length) { box.textContent = '（word.txt 內容為空）'; return; }
      const pick = lines[Math.floor(Math.random() * lines.length)];
      box.textContent = pick;
      console.debug('Loaded quote from', url);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  console.error('載入 word.txt 失敗', lastErr, 'tried:', candidates);
  box.textContent = '（無法載入名言）';
}
loadRandomQuote();

// Preview puzzle rendering inside modal
function clearPreviewPuzzle() {
  els.previewStage.innerHTML = '';
}
function renderPreviewPuzzle() {
  els.previewStage.innerHTML = '';
  const rows = 10;
  const cols = 10;
  const container = document.getElementById('previewPuzzle');
  const rect = container.getBoundingClientRect();
  const aspect = tempImageAspect || (16/10);
  const maxW = Math.max(240, rect.width - 24);
  const maxH = Math.max(160, rect.height - 24);
  let W = maxW, H = Math.round(W / aspect);
  if (H > maxH) { H = maxH; W = Math.round(H * aspect); }
  const pieceW = W / cols;
  const pieceH = H / rows;
  const url = tempImageURL || null;
  const stage = els.previewStage;
  stage.style.width = `${W}px`;
  stage.style.height = `${H}px`;
  // generate flat edges for preview consistency
  const edges = makeEdges(rows, cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const el = document.createElement('div');
      el.className = 'piece revealed';
      el.style.left = `${c * pieceW}px`;
      el.style.top = `${r * pieceH}px`;
      el.style.width = `${pieceW}px`;
      el.style.height = `${pieceH}px`;
      el.style.backgroundImage = url ? `url(${url})` : 'linear-gradient(135deg, #ece9e1, #ddd4c5)';
      el.style.backgroundSize = `${W}px ${H}px`;
      el.style.backgroundPosition = `${-c * pieceW}px ${-r * pieceH}px`;
      const top = (r === 0) ? 0 : -edges.h[r-1][c];
      const right = (c === cols-1) ? 0 : edges.v[r][c];
      const bottom = (r === rows-1) ? 0 : edges.h[r][c];
      const left = (c === 0) ? 0 : -edges.v[r][c-1];
      const d = piecePath(pieceW, pieceH, top, right, bottom, left);
      el.style.webkitClipPath = `path('${d}')`;
      el.style.clipPath = `path('${d}')`;
      stage.appendChild(el);
    }
  }
}
// no row/col inputs now

// Migrate legacy data URLs in localStorage to IndexedDB
function dataURLtoBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(',');
  const match = /data:(.*?);base64/.exec(meta || '') || [];
  const mime = match[1] || 'image/png';
  const bin = atob(b64 || '');
  const len = bin.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
(async function migrateLegacyImages() {
  let changed = false;
  for (const p of projects) {
    if (p && typeof p.image === 'string' && p.image.startsWith('data:image')) {
      try {
        const blob = dataURLtoBlob(p.image);
        const imgId = p.imageRef || `img_${p.id}`;
        await ImageDB.put(imgId, blob);
        p.imageRef = imgId;
        delete p.image;
        changed = true;
      } catch (e) { console.warn('migrate image failed', e); }
    }
  }
  if (changed) saveAll();
})();

// Migrate projects to fixed 10x10 (100 pieces) and preserve approx progress
(function migrateToFixedGrid() {
  let changed = false;
  for (const p of projects) {
    const total = (p.rows||0) * (p.cols||0);
    if (total === 100) continue;
    const prevTotal = total > 0 ? total : 100;
    const prevRevealed = Array.isArray(p.revealed) ? p.revealed.length : 0;
    const pct = typeof p.progress === 'number' ? clamp(p.progress,0,100) : Math.round(prevRevealed/prevTotal*100);
    p.rows = 10; p.cols = 10;
    const edges = makeEdges(10,10);
    p.hEdges = edges.h; p.vEdges = edges.v;
    const targetPieces = Math.round((pct/100) * 100);
    // re-seed revealed randomly to match pct
    const idxs = Array.from({length:100}, (_,i)=>i);
    for (let i = idxs.length-1; i>0; i--) { const j = Math.floor(Math.random()*(i+1)); [idxs[i], idxs[j]] = [idxs[j], idxs[i]]; }
    p.revealed = idxs.slice(0, targetPieces);
    p.progress = Math.round((p.revealed.length/100) * 100);
    changed = true;
  }
  if (changed) saveAll();
})();
