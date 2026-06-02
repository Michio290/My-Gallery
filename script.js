/* ═══════════════════════════════════════
   LOVE GALLERY — script.js
   Features: PIN login, auto-lock, settings,
   slideshow, search, lightbox, themes, captions,
   tags/kategori, export/import backup, PWA offline,
   PIN attempt limit + persistent lockout
═══════════════════════════════════════ */

// ── State ──────────────────────────────
let photos   = [];
let settings = {};
let filter   = 'all';
let lbIdx    = 0;
let filteredList = []; // daftar foto setelah filter/search aktif
let searchQ  = '';
let ssTimer  = null;
let ssIdx    = 0;
let autoLockTimer = null;
let selectMode = false;
let selectedIds = new Set();
let cloudSyncEnabled = false;

// FIX: deklarasi eksplisit agar tidak implicit global
let folderPhotos = { game: [], her: [] };

// Tags / Kategori
let allTags      = [];   // { id, name, color, emoji }
let activeTagIds = new Set(); // tag-filter yang aktif

// PIN default tidak disimpan di source code.
// Jika belum ada PIN (first run), user akan dipaksa membuat PIN baru.
const DEFAULT_PIN      = null; // tidak ada fallback — lihat checkPin() dan firstRunPinSetup()
const DEFAULT_SETTINGS = {
  pin:         null,   // diisi saat user pertama kali set PIN
  autoLock:    5,
  galleryName: 'My Love Gallery',
  quote:       '"Every photo of you is a moment I never want to forget."',
  theme:       '#e8637a',
  themeLight:  '#f4a0af',
};

// ── Unique ID generator (anti-duplikat saat upload batch) ──
let _idCounter = 0;
function genId() {
  return `${Date.now()}_${++_idCounter}_${Math.random().toString(36).slice(2, 7)}`;
}
(async function init() {
  // Register Service Worker (PWA offline)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('[PWA] SW registered:', reg.scope))
      .catch(err => console.warn('[PWA] SW failed:', err));
  }

  // Migrasi dari localStorage ke IndexedDB (sekali saja)
  await dbMigrateFromLocalStorage();

  // Load dari IndexedDB
  try { photos = await dbLoadPhotos(); } catch(e) {
    try { photos = JSON.parse(localStorage.getItem('lovegal') || '[]'); } catch(e2){ photos = []; }
  }
  try {
    const cfg = await dbLoadConfig('settings');
    settings = cfg || {};
  } catch(e) {
    try { settings = JSON.parse(localStorage.getItem('lovegal_cfg') || '{}'); } catch(e2){ settings = {}; }
  }

  settings = Object.assign({}, DEFAULT_SETTINGS, settings);

  // Migrasi PIN plain-text lama → hash (sekali saja)
  await migratePinToHash();

  // Jika sudah ada PIN, set UID cloud dari PIN hash
  if (settings.pin) {
    sbSetUserFromPin(settings.pin);
    await _continueInit();
    return;
  }

  // Belum ada PIN — perangkat baru, tampilkan setup
  showFirstRunPinSetup();
})();

// Lanjutan init — dipanggil setelah PIN dipastikan ada
async function _continueInit() {
  applyTheme(settings.theme, settings.themeLight);

  // Load folder dari IndexedDB
  try { folderPhotos = await dbLoadFolders(); } catch(e) {
    try { folderPhotos = JSON.parse(localStorage.getItem('lovegal_folders') || '{"game":[],"her":[]}'); } catch(e2){ folderPhotos = { game: [], her: [] }; }
  }
  // Pastikan key her selalu ada
  if (!folderPhotos.her) folderPhotos.her = [];

  spawnHearts();

  // Load tags
  try { allTags = await dbLoadTags(); } catch(e) { allTags = []; }

  // Load lockout state (bertahan setelah browser ditutup)
  try {
    const lockout = await dbLoadLockout();
    if (lockout) {
      _pinAttempts    = lockout.attempts    || 0;
      _pinLockedUntil = lockout.lockedUntil || 0;
      if (_pinLockedUntil > 0 && Date.now() >= _pinLockedUntil) {
        _pinAttempts = 0; _pinLockedUntil = 0;
        await dbClearLockout();
      } else if (_pinLockedUntil > Date.now()) {
        const sisa = Math.ceil((_pinLockedUntil - Date.now()) / 1000);
        showPinError(`Terlalu banyak percobaan. Tunggu ${sisa}s lagi.`);
        startLockoutCountdown();
      }
    }
  } catch(e) { /* ignore */ }

  // ── CLOUD SYNC: pastikan UID sudah di-set, lalu init ──
  if (settings.pin && typeof sbSetUserFromPin === 'function') sbSetUserFromPin(settings.pin);
  initCloudSync().catch(e => console.warn('[Cloud] Init gagal:', e));
}

// ── Persist ───────────────────────────
async function savePhotos() {
  // Simpan ke localStorage dulu (fallback cepat)
  try { localStorage.setItem('lovegal', JSON.stringify(photos)); } catch(e){
    if (e && e.name === 'QuotaExceededError') {
      toast('⚠️ Penyimpanan hampir penuh!');
    }
  }
  // Lalu simpan ke IndexedDB (utama) — await agar tidak race condition
  try {
    await dbSavePhotos(photos);
  } catch(err) {
    if (err && err.name === 'QuotaExceededError') {
      toast('⚠️ Penyimpanan hampir penuh! Hapus beberapa foto untuk memberi ruang.');
    }
  }
  // ── Sync ke Supabase cloud (non-blocking) ──
  cloudSync();
}
async function saveFolders() {
  try { localStorage.setItem('lovegal_folders', JSON.stringify(folderPhotos)); } catch(e){}
  await dbSaveFolders(folderPhotos).catch(() => {});
  if (cloudSyncEnabled) sbSaveFolders(folderPhotos).catch(()=>{});
}
function saveSettings() {
  const gName = document.getElementById('gallery-name-input').value.trim();
  const quote  = document.getElementById('quote-input').value.trim();
  if (gName) settings.galleryName = gName;
  if (quote) settings.quote = quote.startsWith('"') ? quote : `"${quote}"`;
  dbSaveConfig('settings', settings).catch(() => {});
  if (cloudSyncEnabled) sbSaveSettings(settings).catch(()=>{});
  try {
    const { pin: _omit, ...settingsWithoutPin } = settings;
    localStorage.setItem('lovegal_cfg', JSON.stringify(settingsWithoutPin));
  } catch(e){}
  applySettingsToUI();
  toast('✅ Pengaturan disimpan!');
  closeSettings();
}
function saveCfg() {
  dbSaveConfig('settings', settings).catch(() => {});
  // Simpan ke localStorage tanpa PIN hash (PIN hanya ada di IndexedDB)
  try {
    const { pin: _omit, ...settingsWithoutPin } = settings;
    localStorage.setItem('lovegal_cfg', JSON.stringify(settingsWithoutPin));
  } catch(e){}
}

// ── Theme ─────────────────────────────
function applyTheme(rose, roseLight) {
  document.documentElement.style.setProperty('--rose',       rose);
  document.documentElement.style.setProperty('--rose-light', roseLight);
  document.documentElement.style.setProperty('--rose-pale',  roseLight + '33');
  document.documentElement.style.setProperty('--shadow',     rose + '30');
  document.documentElement.style.setProperty('--border',     rose + '28');
}
function setTheme(rose, roseLight, el) {
  settings.theme      = rose;
  settings.themeLight = roseLight;
  applyTheme(rose, roseLight);
  document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
  el.classList.add('active');
}
function applySettingsToUI() {
  const t = document.getElementById('nav-title');
  if (t) t.textContent = settings.galleryName || 'Love Gallery';
  const q = document.getElementById('hero-quote');
  if (q) q.textContent = settings.quote;
  // Apply custom icon if set
  if (typeof applyCustomIconToAll === 'function') applyCustomIconToAll();
}

/* ── PIN Hashing (Web Crypto API) ────────────────────
   PIN tidak pernah disimpan plain-text.
   Semua perbandingan dilakukan lewat SHA-256 hash.
   Salt = DB_SALT (tetap per-instalasi, bukan per-PIN,
   karena kita tidak perlu rainbow-table resistance
   tinggi — ini bukan password server).
──────────────────────────────────────────────────── */
const PIN_SALT = 'LoveGallery_v1_salt_2024';

async function hashPin(pin) {
  const encoder = new TextEncoder();
  const data    = encoder.encode(PIN_SALT + pin);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  // Konversi ke hex string
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── First Run: Setup PIN ──────────────────────────────
// Ditampilkan saat belum ada PIN tersimpan (instalasi baru)
function showFirstRunPinSetup() {
  const lockCard = document.querySelector('.lock-card');
  if (!lockCard) return;
  lockCard.innerHTML = `
    <div class="lock-icon-wrap">
      <div class="lock-rose" id="lock-rose-el">🌹</div>
      <div class="lock-ring"></div>
    </div>
    <p class="lock-label">✦ Selamat Datang ✦</p>
    <h1 class="lock-title">Buat PIN Kamu</h1>
    <p class="lock-sub">Masukkan PIN 8 digit baru untuk mengamankan galeri ini</p>
    <div style="display:flex;flex-direction:column;gap:10px;width:100%;max-width:260px;margin:16px auto 0">
      <input type="password" id="fr-pin1" inputmode="numeric" maxlength="8" placeholder="PIN baru (8 digit)"
        style="text-align:center;letter-spacing:6px;font-size:22px;padding:10px;border:1.5px solid var(--rose);border-radius:12px;outline:none"/>
      <input type="password" id="fr-pin2" inputmode="numeric" maxlength="8" placeholder="Ulangi PIN"
        style="text-align:center;letter-spacing:6px;font-size:22px;padding:10px;border:1.5px solid var(--rose);border-radius:12px;outline:none"/>
      <p id="fr-error" style="color:#e8637a;font-size:13px;min-height:18px;text-align:center"></p>
      <button onclick="confirmFirstRunPin()"
        style="background:var(--rose);color:#fff;border:none;border-radius:12px;padding:12px;font-size:15px;cursor:pointer;font-weight:600">
        🔐 Buat PIN & Mulai
      </button>
    </div>
    <p class="lock-hint">💕 PIN hanya tersimpan di perangkat ini</p>
  `;
}

async function confirmFirstRunPin() {
  const p1 = (document.getElementById('fr-pin1')?.value || '').trim();
  const p2 = (document.getElementById('fr-pin2')?.value || '').trim();
  const errEl = document.getElementById('fr-error');
  if (!/^\d{8}$/.test(p1)) { errEl.textContent = '❌ PIN harus tepat 8 digit angka'; return; }
  if (p1 !== p2)             { errEl.textContent = '❌ PIN tidak cocok, coba lagi'; return; }
  settings.pin = await hashPin(p1);
  saveCfg();
  // Set UID cloud dari PIN baru
  sbSetUserFromPin(settings.pin);
  // Lanjutkan inisialisasi normal
  await _continueInit();
}

// Cek PIN: bandingkan hash input dengan hash tersimpan
async function verifyPin(inputPin, storedHash) {
  const inputHash = await hashPin(inputPin);
  return inputHash === storedHash;
}

// Migrasi PIN plain-text lama ke hash (jalankan sekali saat init)
async function migratePinToHash() {
  const pin = settings.pin;
  if (!pin) return;
  // Kalau panjangnya 64 karakter, sudah berupa SHA-256 hex → skip
  if (pin.length === 64) return;
  // Masih plain-text → hash & simpan
  console.log('🔄 Migrasi PIN plain-text ke hash...');
  settings.pin = await hashPin(pin);
  saveCfg();
  console.log('✅ PIN berhasil di-hash');
}

// ── Lock / Unlock ─────────────────────
let pinBuffer = '';

function pinPress(digit) {
  if (_pinLockedUntil > Date.now()) return; // blokir saat lockout
  if (pinBuffer.length >= 8) return;
  pinBuffer += digit;
  updatePinDots();
  if (pinBuffer.length === 8) {
    setTimeout(checkPin, 180);
  }
}

function pinDel() {
  if (_pinLockedUntil > Date.now()) return; // blokir saat lockout
  if (!pinBuffer.length) return;
  pinBuffer = pinBuffer.slice(0, -1);
  updatePinDots();
  clearPinError();
}

function updatePinDots() {
  const dots = document.querySelectorAll('#pin-dots .dot');
  dots.forEach((d, i) => d.classList.toggle('filled', i < pinBuffer.length));
}

// PIN attempt tracking
let _pinAttempts = 0;
let _pinLockedUntil = 0;
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MS   = 3 * 60 * 1000; // 3 menit

async function checkPin() {
  const now = Date.now();
  if (_pinLockedUntil > now) {
    const sisa = Math.ceil((_pinLockedUntil - now) / 1000);
    showPinError(`Terlalu banyak percobaan. Tunggu ${sisa}s lagi.`);
    pinBuffer = '';
    updatePinDots();
    return;
  }

  const storedHash = settings.pin;
  if (!storedHash) {
    // Belum ada PIN — harusnya tidak sampai sini, tapi jaga-jaga
    showFirstRunPinSetup(); return;
  }
  const isCorrect  = await verifyPin(pinBuffer, storedHash);

  if (isCorrect) {
    _pinAttempts    = 0;
    _pinLockedUntil = 0;
    await dbClearLockout().catch(() => {});
    unlockApp();
  } else {
    _pinAttempts++;
    pinBuffer = '';
    updatePinDots();
    if (_pinAttempts >= MAX_PIN_ATTEMPTS) {
      _pinLockedUntil = Date.now() + PIN_LOCKOUT_MS;
      _pinAttempts    = 0;
      await dbSaveLockout(0, _pinLockedUntil).catch(() => {});
      showPinError(`Terlalu banyak percobaan. Kunci 3 menit. 🔒`);
      startLockoutCountdown();
    } else {
      await dbSaveLockout(_pinAttempts, 0).catch(() => {});
      const sisa = MAX_PIN_ATTEMPTS - _pinAttempts;
      showPinError(`PIN salah. Sisa percobaan: ${sisa}`);
    }
  }
}

// Countdown live di layar kunci
let _countdownTimer = null;
function startLockoutCountdown() {
  clearInterval(_countdownTimer);
  _countdownTimer = setInterval(() => {
    const sisa = Math.ceil((_pinLockedUntil - Date.now()) / 1000);
    if (sisa <= 0) {
      clearInterval(_countdownTimer);
      _pinLockedUntil = 0;
      _pinAttempts    = 0;
      dbClearLockout().catch(() => {});
      showPinError('');
      clearPinError();
    } else {
      showPinError(`🔒 Terlalu banyak percobaan. Tunggu ${sisa}s lagi.`);
    }
  }, 1000);
}

function showPinError(msg) {
  const el = document.getElementById('pin-error');
  el.textContent = msg;
  el.classList.remove('shake');
  void el.offsetWidth; // reflow
  el.classList.add('shake');
}
function clearPinError() {
  const el = document.getElementById('pin-error');
  if (el) el.textContent = '';
}

function unlockApp() {
  // Hide lock screen, show welcome animation first
  document.getElementById('lock-screen').style.display = 'none';
  playWelcomeAnimation();
}

// ── Welcome Animation ─────────────────
function playWelcomeAnimation() {
  const overlay = document.getElementById('welcome-overlay');
  overlay.classList.remove('hidden');
  overlay.classList.remove('fade-out');

  // Canvas particle system
  const canvas = document.getElementById('welcome-canvas');
  const ctx    = canvas.getContext('2d');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;

  const particles = [];
  const COLORS = ['#e8637a','#f4a0af','#fde8ec','#fff','#c9956a','#f7c5d0'];

  for (let i = 0; i < 80; i++) {
    particles.push({
      x:    Math.random() * canvas.width,
      y:    canvas.height + Math.random() * 200,
      vx:   (Math.random() - 0.5) * 1.2,
      vy:   -(1.5 + Math.random() * 2.5),
      size: 3 + Math.random() * 5,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      alpha: 0,
      delay: Math.random() * 1500,
      born:  performance.now() + Math.random() * 1500,
      shape: Math.random() > 0.4 ? 'circle' : 'heart',
    });
  }

  let rafId;
  function drawParticles(now) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      if (now < p.born) return;
      const age = now - p.born;
      p.alpha = Math.min(1, age / 400);
      if (p.y < -20) p.alpha = Math.max(0, p.alpha - 0.015);
      p.x += p.vx;
      p.y += p.vy;
      ctx.save();
      ctx.globalAlpha = p.alpha * 0.75;
      ctx.fillStyle   = p.color;
      if (p.shape === 'heart') {
        drawHeart(ctx, p.x, p.y, p.size * 0.6);
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });
    rafId = requestAnimationFrame(drawParticles);
  }
  rafId = requestAnimationFrame(drawParticles);

  function drawHeart(ctx, x, y, r) {
    ctx.beginPath();
    ctx.moveTo(x, y + r * 0.3);
    ctx.bezierCurveTo(x, y - r * 0.3, x - r, y - r * 0.3, x - r, y + r * 0.3);
    ctx.bezierCurveTo(x - r, y + r * 0.9, x, y + r * 1.4, x, y + r * 1.6);
    ctx.bezierCurveTo(x, y + r * 1.4, x + r, y + r * 0.9, x + r, y + r * 0.3);
    ctx.bezierCurveTo(x + r, y - r * 0.3, x, y - r * 0.3, x, y + r * 0.3);
    ctx.fill();
  }

  // Get name from settings for personalised greeting
  const name = (settings.galleryName || 'My Love Gallery').replace(' Gallery','').replace('My ','');

  // Sequence of lines — romantic welcome messages
  const messages = [
    { el: 'wl1', text: 'Selamat Datang ✦',    delay: 300  },
    { el: 'wl2', text: `"Galeri kenangan kita yang paling berharga"`, delay: 900  },
    { el: 'wl3', text: 'dengan cinta · selalu & selamanya',          delay: 1500 },
  ];

  // Show rose — apply custom icon first if set
  setTimeout(() => {
    const rose = document.getElementById('welcome-rose');
    if (settings && settings.customIcon) applyIconToElement(rose, settings.customIcon);
    rose.classList.add('show');
    setTimeout(() => rose.classList.add('pulse'), 800);
  }, 100);

  // Typewriter effect for each line
  messages.forEach(({ el, text, delay }) => {
    setTimeout(() => {
      const elem = document.getElementById(el);
      elem.classList.add('show');
      typeWriter(elem, text, 38);
    }, delay);
  });

  // Animated mini hearts row
  const heartEmojis = ['💕','🌹','💖','✨','💗'];
  setTimeout(() => {
    const wrap = document.getElementById('welcome-hearts');
    wrap.innerHTML = heartEmojis.map((e,i) =>
      `<span class="w-heart" id="wh${i}">${e}</span>`
    ).join('');
    heartEmojis.forEach((_, i) => {
      setTimeout(() => {
        const h = document.getElementById('wh' + i);
        if (h) { h.classList.add('show'); setTimeout(() => h.classList.add('bounce'), 500 + i * 60); }
      }, i * 120);
    });
  }, 1900);

  // Fade out and enter app after sequence
  setTimeout(() => {
    cancelAnimationFrame(rafId);
    overlay.classList.add('fade-out');
    setTimeout(() => {
      overlay.classList.add('hidden');
      overlay.classList.remove('fade-out');
      // Reset all animation states
      document.getElementById('welcome-rose').classList.remove('show','pulse');
      ['wl1','wl2','wl3'].forEach(id => {
        const el = document.getElementById(id);
        el.classList.remove('show');
        el.textContent = '';
      });
      document.getElementById('welcome-hearts').innerHTML = '';
      // Show main app
      document.getElementById('app').classList.remove('hidden');
      applySettingsToUI();
      render();
      renderTagFilterBar();
      resetAutoLock();
      maybeAutoSlideshow();
      // Auto-play musik jika ada lagu tersimpan
      if (musicTracks.length > 0 && musicCurrentIdx === -1) {
        playTrack(0);
      }
    }, 800);
  }, 3400);
}

function typeWriter(el, text, speed) {
  let i = 0;
  el.textContent = '';
  function tick() {
    if (i < text.length) {
      el.textContent += text[i++];
      setTimeout(tick, speed);
    }
  }
  tick();
}

function lockApp() {
  pinBuffer = '';
  updatePinDots();
  clearPinError();
  document.getElementById('lock-screen').style.display = 'flex';
  document.getElementById('app').classList.add('hidden');
  clearTimeout(autoLockTimer);
  stopSlideshow();
  closeLb();
  closeSettings();
}

// Auto-lock
function resetAutoLock() {
  clearTimeout(autoLockTimer);
  const mins = parseInt(settings.autoLock || 0);
  if (!mins) return;
  autoLockTimer = setTimeout(lockApp, mins * 60 * 1000);
}

// Reset auto-lock saat ada interaksi apapun (klik, sentuh, scroll, ketik)
['click', 'touchstart', 'scroll', 'keydown', 'mousemove'].forEach(evt =>
  document.addEventListener(evt, resetAutoLock, { passive: true })
);
document.addEventListener('keydown', (e) => {
  // Numpad keyboard support on lock screen
  if (!document.getElementById('lock-screen').style.display || document.getElementById('lock-screen').style.display !== 'none') {
    if (e.key >= '0' && e.key <= '9') pinPress(e.key);
    if (e.key === 'Backspace') pinDel();
  }
  // Lightbox keyboard
  const lb = document.getElementById('lightbox');
  if (!lb.classList.contains('hidden')) {
    if (e.key === 'Escape')     closeLb();
    if (e.key === 'ArrowLeft')  lbNav(-1);
    if (e.key === 'ArrowRight') lbNav(1);
  }
});

function saveAutoLock() {
  settings.autoLock = parseInt(document.getElementById('autolock-select').value);
  saveCfg();
  resetAutoLock();
}

// ── Floating hearts ───────────────────
function spawnHearts() {
  const bg = document.getElementById('hearts-bg');
  if (!bg) return;
  const emojis = ['💕','💗','🌸','💖','🌹','💝','✨'];
  for (let i = 0; i < 14; i++) {
    const h = document.createElement('div');
    h.className = 'heart-float';
    h.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    h.style.left = Math.random() * 100 + '%';
    h.style.fontSize = (12 + Math.random() * 12) + 'px';
    h.style.animationDuration = (8 + Math.random() * 12) + 's';
    h.style.animationDelay   = (Math.random() * 10) + 's';
    bg.appendChild(h);
  }
}

// ── Toast (dengan antrian agar tidak saling timpa) ───
let _toastQueue = [];
let _toastRunning = false;
function toast(msg) {
  _toastQueue.push(msg);
  if (!_toastRunning) _processToast();
}
function _processToast() {
  if (!_toastQueue.length) { _toastRunning = false; return; }
  _toastRunning = true;
  const msg = _toastQueue.shift();
  const t = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  t.classList.add('show');
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(_processToast, 300); // jeda kecil antar toast
  }, 2200);
}

// ── Helpers ───────────────────────────
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// FIX: Sinkronkan field yang bisa berubah (caption, fav, tags, secretNote, filter)
// dari photos[] ke semua salinan di folderPhotos
function syncPhotoToFolders(photo) {
  const SYNC_FIELDS = ['caption', 'fav', 'favCount', 'tags', 'secretNote', 'filter'];
  ['game', 'her'].forEach(key => {
    const arr = folderPhotos[key];
    if (!arr) return;
    const copy = arr.find(p => String(p.id) === String(photo.id));
    if (copy) {
      SYNC_FIELDS.forEach(f => { if (photo[f] !== undefined) copy[f] = photo[f]; });
    }
  });
}

let dblTapTimer = null;
let dblTapLastIdx = -1;
let revealVisible = -1;

function gridDblTap(e, idx) {
  e.stopPropagation();
  // Hide any currently shown reveal
  if (revealVisible >= 0 && revealVisible !== idx) {
    const prev = document.getElementById('sr-' + revealVisible);
    if (prev) prev.classList.remove('visible');
  }
  const el = document.getElementById('sr-' + idx);
  if (!el) return;
  if (el.classList.contains('visible')) {
    el.classList.remove('visible');
    revealVisible = -1;
  } else {
    el.classList.add('visible');
    revealVisible = idx;
    // Auto-hide after 4 seconds
    setTimeout(() => { el.classList.remove('visible'); if (revealVisible === idx) revealVisible = -1; }, 4000);
  }
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtShortDate(ts) {
  return new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

function updateStats() {
  document.getElementById('s-total').textContent = photos.length;
  document.getElementById('s-fav').textContent   = photos.filter(p => p.fav).length;
  if (photos.length) {
    const latest = Math.max(...photos.map(p => p.ts));
    document.getElementById('s-date').textContent = fmtShortDate(latest);
  } else {
    document.getElementById('s-date').textContent = '—';
  }
}

function getFiltered() {
  let list = [...photos];
  if (filter === 'fav')    list = list.filter(p => p.fav);
  if (filter === 'recent') list = list.slice(0, 12);
  if (searchQ) {
    const q = searchQ.toLowerCase();
    list = list.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.caption || '').toLowerCase().includes(q) ||
      // Cari juga nama file tanpa ekstensi agar cocok dengan caption yang ditampilkan
      p.name.replace(/\.[^.]+$/, '').toLowerCase().includes(q) ||
      (p.tags || []).some(tid => {
        const t = allTags.find(t => t.id === tid);
        return t && t.name.toLowerCase().includes(q);
      })
    );
  }
  // Filter by active tags (AND logic: foto harus punya SEMUA tag yang aktif)
  if (activeTagIds.size > 0) {
    list = list.filter(p =>
      [...activeTagIds].every(tid => (p.tags || []).includes(tid))
    );
  }
  filteredList = list; // simpan untuk lbNav
  return list;
}

// ── Render ────────────────────────────
function render() {
  const grid  = document.getElementById('grid');
  const empty = document.getElementById('empty');
  if (!grid) return;
  const list  = getFiltered();
  updateStats();

  if (!list.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  grid.innerHTML = list.map((p, i) => {
    const realIdx = photos.indexOf(p);
    const cap = p.caption || p.name.replace(/\.[^.]+$/, '');
    const favCount = p.favCount || 0;
    const topIdx = getTopFavIdx();
    const isTopFav = realIdx === topIdx && topIdx >= 0;
    const hasSecret = !!p.secretNote;
    const isSelected = selectedIds.has(p.id);

    // Badge album asal
    const albumBadges = (p.albums || []).map(a => {
      if (a === 'game') return `<span class="album-badge badge-game">🎮 Main Bareng</span>`;
      if (a === 'her')  return `<span class="album-badge badge-her">🌸 My Person</span>`;
      return '';
    }).join('');

    // Tag badges
    const tagBadgesHtml = renderPhotoTagBadges(p)
      ? `<div class="photo-tag-badges">${renderPhotoTagBadges(p)}</div>`
      : '';

    const selectOverlay = selectMode
      ? `<div class="select-check ${isSelected ? 'checked' : ''}" data-photoid="${p.id}" onclick="toggleSelectPhoto(event,'${p.id}')">
           ${isSelected ? '✓' : ''}
         </div>`
      : '';

    return `<div class="photo-item ${p.fav ? 'is-fav' : ''} ${isTopFav ? 'top-fav' : ''} ${selectMode ? 'select-mode-item' : ''} ${isSelected ? 'selected-item' : ''}" style="animation-delay:${i * 0.04}s" onclick="${selectMode ? `toggleSelectPhoto(event,'${p.id}')` : `openLb(${realIdx})`}" ondblclick="${selectMode ? '' : `gridDblTap(event,${realIdx})`}">
      <img src="${p.src || p.cloudUrl || ''}" alt="${p.name}" loading="lazy"/>
      ${selectOverlay}
      ${favCount > 0 && !selectMode ? `<div class="heart-count-badge"><span class="hc-icon">♥</span>${favCount}</div>` : ''}
      ${hasSecret && !selectMode ? `<div class="secret-hint-badge">💌</div>` : ''}
      ${tagBadgesHtml && !selectMode ? tagBadgesHtml : ''}
      ${albumBadges && !selectMode ? `<div class="album-badges-wrap">${albumBadges}</div>` : ''}
      <div class="secret-reveal" id="sr-${realIdx}">
        <span class="secret-reveal-icon">💌</span>
        <span class="secret-reveal-text">${p.secretNote ? escHtml(p.secretNote) : 'Belum ada pesan rahasia'}</span>
      </div>
      <div class="photo-overlay">
        <div class="photo-caption">${cap}</div>
        <div class="photo-meta">${fmtDate(p.ts)}</div>
      </div>
      ${!selectMode ? `<div class="photo-btns">
        <button class="pbtn ${p.fav ? 'fav-on' : ''}" onclick="toggleFav(event,${realIdx})" title="Favorit">♥</button>
        <button class="pbtn" onclick="delPhoto(event,${realIdx})" title="Hapus">🗑</button>
      </div>` : ''}
    </div>`;
  }).join('');
}

// ── File Handling ─────────────────────
// ── Album Picker ───────────────────────
let _pendingFiles = [];

function openAlbumPicker(files) {
  const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
  if (!imageFiles.length) return;
  _pendingFiles = imageFiles;

  document.getElementById('ap-count').textContent = imageFiles.length;

  // Preview thumbnails (max 5)
  const preview = document.getElementById('ap-preview');
  preview.innerHTML = '';
  imageFiles.slice(0, 5).forEach(f => {
    const url = URL.createObjectURL(f);
    const img = document.createElement('img');
    img.className = 'ap-thumb';
    img.src = url;
    img.onload = () => URL.revokeObjectURL(url);
    preview.appendChild(img);
  });
  if (imageFiles.length > 5) {
    const more = document.createElement('div');
    more.className = 'ap-thumb-more';
    more.textContent = `+${imageFiles.length - 5}`;
    preview.appendChild(more);
  }

  // Reset checkboxes
  document.getElementById('ap-check-game').checked = false;
  document.getElementById('ap-check-her').checked  = false;

  document.getElementById('album-picker-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeAlbumPicker() {
  document.getElementById('album-picker-modal').classList.add('hidden');
  document.body.style.overflow = '';
  document.getElementById('file-input').value = '';
  _pendingFiles = [];
}

function confirmAlbumPicker() {
  const toGame = document.getElementById('ap-check-game').checked;
  const toHer  = document.getElementById('ap-check-her').checked;

  // Kumpulkan label album tambahan
  const albumTags = [];
  if (toGame) albumTags.push('game');
  if (toHer)  albumTags.push('her');

  let done = 0;
  const total = _pendingFiles.length;

  _pendingFiles.forEach(f => {
    const r = new FileReader();
    r.onload = e => {
      const newPhoto = {
        id:      genId(),
        name:    f.name,
        src:     e.target.result,
        ts:      Date.now(),
        fav:     false,
        size:    f.size,
        caption: '',
        albums:  albumTags
      };

      // SELALU masuk Koleksi Kenangan
      photos.unshift({ ...newPhoto });

      // Tambah ke folder jika dipilih
      if (toGame) { folderPhotos['game'] = folderPhotos['game'] || []; folderPhotos['game'].unshift({ ...newPhoto }); }
      if (toHer)  { folderPhotos['her']  = folderPhotos['her']  || []; folderPhotos['her'].unshift({ ...newPhoto }); }

      done++;
      if (done === total) {
        savePhotos();
        if (toGame || toHer) saveFolders();
        render();
        updateFolderCounts();
        updatePeekCard();

        const labels = ['Koleksi Kenangan'];
        if (toGame) labels.push('Main Bareng');
        if (toHer)  labels.push('My Person');
        toast(`🌸 ${total} foto → ${labels.join(' & ')}!`);
        closeAlbumPicker();
      }
    };
    r.readAsDataURL(f);
  });
}

function handleFiles(files) {
  openAlbumPicker(files);
}


// ── Fav / Delete ──────────────────────
function toggleFav(e, idx) {
  e.stopPropagation();
  photos[idx].fav = !photos[idx].fav;
  if (photos[idx].fav) {
    // favCount hanya set 1 jika belum pernah difavoritkan, tidak akumulasi
    if (!photos[idx].favCount) photos[idx].favCount = 1;
    // Tambah ke folder My Person jika belum ada
    folderPhotos.her = folderPhotos.her || [];
    if (!folderPhotos.her.some(p => String(p.id) === String(photos[idx].id))) {
      folderPhotos.her.unshift({ ...photos[idx] });
    }
  } else {
    // Reset favCount
    photos[idx].favCount = 0;
    // Hapus dari folder My Person HANYA jika foto tidak masuk via album picker (albums tidak mengandung 'her')
    const isInHerAlbum = (photos[idx].albums || []).includes('her');
    if (!isInHerAlbum) {
      folderPhotos.her = (folderPhotos.her || []).filter(p => String(p.id) !== String(photos[idx].id));
    } else {
      // Tetap di folder, tapi sync status fav di salinan folder
      const folderCopy = (folderPhotos.her || []).find(p => String(p.id) === String(photos[idx].id));
      if (folderCopy) folderCopy.fav = false;
    }
  }
  savePhotos(); saveFolders(); render(); updateFolderCounts(); updatePeekCard();
  if (photos[idx]?.fav) {
    burstHearts(e.clientX, e.clientY);
    toast('❤️ Ditambahkan ke My Person!');
  } else {
    toast('Dihapus dari My Person');
  }
}

async function delPhoto(e, idx) {
  e.stopPropagation();
  const photo = photos[idx];
  if (!photo) return;
  showConfirm({
    icon: '🗑',
    title: 'Hapus Foto?',
    message: 'Foto ini akan dihapus permanen dan tidak bisa dikembalikan.',
    okText: 'Ya, Hapus',
    onOk: async () => {
      photos.splice(idx, 1);
      ['game','her'].forEach(folder => {
        if (folderPhotos[folder]) folderPhotos[folder] = folderPhotos[folder].filter(p => p.id !== photo.id);
      });
      await savePhotos(); await saveFolders();
      render(); updateFolderCounts();
      toast('Foto dihapus 🗑');
    }
  });
}

// ── Filter / Search ───────────────────
function setFilter(f, el) {
  filter = f;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  render();
}

function openSearch() {
  const bar = document.getElementById('search-bar');
  const nav = document.querySelector('.topnav');
  bar.classList.remove('hidden');
  nav.classList.add('searching');
  setTimeout(() => document.getElementById('search-input').focus(), 50);
}
function closeSearch() {
  searchQ = '';
  document.getElementById('search-input').value = '';
  document.getElementById('search-bar').classList.add('hidden');
  document.querySelector('.topnav').classList.remove('searching');
  render();
}
function doSearch(val) {
  searchQ = val;
  render();
}

// ── Lightbox ──────────────────────────
function openLb(idx) {
  lbIdx = idx;
  const p = photos[idx];
  document.getElementById('lb-img').src = p.src || p.cloudUrl || '';
  document.getElementById('lb-cap').textContent  = p.caption || p.name.replace(/\.[^.]+$/, '');
  document.getElementById('lb-date').textContent = fmtDate(p.ts);
  const favBtn = document.getElementById('lb-fav-btn');
  favBtn.classList.toggle('active', !!p.fav);
  favBtn.textContent = p.fav ? '❤️ Favorit' : '♥ Favorit';
  lbResetZoom();
  document.getElementById('lightbox').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  initLbPanZoom();
}
function closeLb() {
  document.getElementById('lightbox').classList.add('hidden');
  document.body.style.overflow = '';
  lbResetZoom();
}

/* ══════════════════════════════════════════════════════
   LIGHTBOX — PAN & ZOOM
   Scroll mouse / pinch gesture = zoom
   Drag saat zoom > 1 = pan
══════════════════════════════════════════════════════ */
let _lbScale = 1;
let _lbPanX  = 0;
let _lbPanY  = 0;
let _lbDragging = false;
let _lbDragStartX = 0, _lbDragStartY = 0;
let _lbPanStartX  = 0, _lbPanStartY  = 0;
let _lbPinchDist  = 0;
let _lbPinchMidX  = 0, _lbPinchMidY  = 0;

function lbApplyTransform() {
  const img = document.getElementById('lb-img');
  if (!img) return;
  img.style.transform = `scale(${_lbScale}) translate(${_lbPanX / _lbScale}px, ${_lbPanY / _lbScale}px)`;
  img.style.cursor    = _lbScale > 1 ? (_lbDragging ? 'grabbing' : 'grab') : 'default';

  const resetBtn  = document.getElementById('lb-zoom-reset');
  const zoomHint  = document.getElementById('lb-zoom-hint');
  if (resetBtn) resetBtn.classList.toggle('hidden', _lbScale <= 1);
  if (zoomHint) zoomHint.classList.toggle('hidden', _lbScale <= 1);
}

function lbResetZoom() {
  _lbScale = 1; _lbPanX = 0; _lbPanY = 0;
  lbApplyTransform();
}

function lbZoomAt(delta, originX, originY) {
  const wrap = document.getElementById('lb-img-wrap');
  if (!wrap) return;
  const rect   = wrap.getBoundingClientRect();
  const factor = delta > 0 ? 1.15 : 0.87;
  const newScale = Math.max(1, Math.min(6, _lbScale * factor));
  if (newScale === _lbScale) return;
  // Adjust pan so zoom centers on pointer
  const ox = originX - rect.left - rect.width / 2;
  const oy = originY - rect.top  - rect.height / 2;
  _lbPanX = (_lbPanX - ox) * (newScale / _lbScale) + ox;
  _lbPanY = (_lbPanY - oy) * (newScale / _lbScale) + oy;
  _lbScale = newScale;
  lbApplyTransform();
}

function initLbPanZoom() {
  const wrap = document.getElementById('lb-img-wrap');
  if (!wrap || wrap._lbPZInited) return;
  wrap._lbPZInited = true;

  // Scroll wheel zoom
  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    e.stopPropagation();
    lbZoomAt(-e.deltaY, e.clientX, e.clientY);
  }, { passive: false });

  // Mouse drag pan
  wrap.addEventListener('mousedown', e => {
    if (_lbScale <= 1) return;
    e.preventDefault();
    e.stopPropagation();
    _lbDragging = true;
    _lbDragStartX = e.clientX;
    _lbDragStartY = e.clientY;
    _lbPanStartX  = _lbPanX;
    _lbPanStartY  = _lbPanY;
    lbApplyTransform();
  });
  document.addEventListener('mousemove', e => {
    if (!_lbDragging) return;
    _lbPanX = _lbPanStartX + (e.clientX - _lbDragStartX);
    _lbPanY = _lbPanStartY + (e.clientY - _lbDragStartY);
    lbApplyTransform();
  });
  document.addEventListener('mouseup', () => {
    if (!_lbDragging) return;
    _lbDragging = false;
    lbApplyTransform();
  });

  // Touch: pinch zoom + drag pan
  function pinchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx*dx + dy*dy);
  }
  function pinchMid(touches) {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    };
  }

  wrap.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      e.preventDefault();
      _lbPinchDist = pinchDist(e.touches);
      const mid = pinchMid(e.touches);
      _lbPinchMidX = mid.x; _lbPinchMidY = mid.y;
    } else if (e.touches.length === 1 && _lbScale > 1) {
      e.preventDefault();
      _lbDragging = true;
      _lbDragStartX = e.touches[0].clientX;
      _lbDragStartY = e.touches[0].clientY;
      _lbPanStartX  = _lbPanX;
      _lbPanStartY  = _lbPanY;
    }
  }, { passive: false });

  wrap.addEventListener('touchmove', e => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dist  = pinchDist(e.touches);
      const mid   = pinchMid(e.touches);
      const delta = dist - _lbPinchDist;
      lbZoomAt(delta, mid.x, mid.y);
      _lbPinchDist = dist;
      _lbPinchMidX = mid.x; _lbPinchMidY = mid.y;
    } else if (e.touches.length === 1 && _lbDragging) {
      e.preventDefault();
      _lbPanX = _lbPanStartX + (e.touches[0].clientX - _lbDragStartX);
      _lbPanY = _lbPanStartY + (e.touches[0].clientY - _lbDragStartY);
      lbApplyTransform();
    }
  }, { passive: false });

  wrap.addEventListener('touchend', e => {
    if (e.touches.length < 2) _lbPinchDist = 0;
    if (e.touches.length === 0) { _lbDragging = false; lbApplyTransform(); }
  });

  // Double-tap to zoom in/out
  let _lastTap = 0;
  wrap.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - _lastTap < 300 && e.changedTouches.length === 1) {
      e.preventDefault();
      if (_lbScale > 1) { lbResetZoom(); }
      else { lbZoomAt(100, e.changedTouches[0].clientX, e.changedTouches[0].clientY); }
    }
    _lastTap = now;
  });
}
function lbBgClick(e) {
  if (e.target === document.getElementById('lightbox')) closeLb();
}
function lbNav(d) {
  // Navigasi dalam filteredList (yang sedang tampil di grid), bukan seluruh photos
  const list = filteredList.length ? filteredList : photos;
  const curPos = list.findIndex(p => p === photos[lbIdx]);
  const newPos = ((curPos < 0 ? 0 : curPos) + d + list.length) % list.length;
  const realIdx = photos.indexOf(list[newPos]);
  lbResetZoom();
  if (realIdx >= 0) openLb(realIdx);
}
function lbToggleFav() {
  if (!photos[lbIdx]) return;
  photos[lbIdx].fav = !photos[lbIdx].fav;
  if (photos[lbIdx].fav) {
    // favCount hanya set 1 jika belum pernah difavoritkan, tidak akumulasi
    if (!photos[lbIdx].favCount) photos[lbIdx].favCount = 1;
    // Tambah ke folder My Person jika belum ada
    folderPhotos.her = folderPhotos.her || [];
    if (!folderPhotos.her.some(p => String(p.id) === String(photos[lbIdx].id))) {
      folderPhotos.her.unshift({ ...photos[lbIdx] });
    }
  } else {
    // Reset favCount
    photos[lbIdx].favCount = 0;
    // Hapus dari folder My Person HANYA jika foto tidak masuk via album picker
    const isInHerAlbum = (photos[lbIdx].albums || []).includes('her');
    if (!isInHerAlbum) {
      folderPhotos.her = (folderPhotos.her || []).filter(p => String(p.id) !== String(photos[lbIdx].id));
    } else {
      const folderCopy = (folderPhotos.her || []).find(p => String(p.id) === String(photos[lbIdx].id));
      if (folderCopy) folderCopy.fav = false;
    }
  }
  savePhotos(); saveFolders(); render(); updateFolderCounts(); updatePeekCard();
  openLb(lbIdx);
  if (photos[lbIdx].fav) {
    burstHearts(window.innerWidth / 2, window.innerHeight / 2);
    toast('❤️ Ditambahkan ke My Person!');
  } else {
    toast('Dihapus dari My Person');
  }
}
async function lbDelete() {
  if (!photos[lbIdx]) return;
  const photo = photos[lbIdx];
  showConfirm({
    icon: '🗑',
    title: 'Hapus Foto?',
    message: 'Foto ini akan dihapus permanen dari galeri.',
    okText: 'Ya, Hapus',
    onOk: async () => {
      photos.splice(lbIdx, 1);
      ['game','her'].forEach(folder => {
        if (folderPhotos[folder]) folderPhotos[folder] = folderPhotos[folder].filter(p => p.id !== photo.id);
      });
      await savePhotos(); await saveFolders();
      render(); updateFolderCounts();
      if (!photos.length) { closeLb(); return; }
      openLb(Math.min(lbIdx, photos.length - 1));
      toast('Foto dihapus 🗑');
    }
  });
}
function lbEditCaption() {
  const p = photos[lbIdx];
  if (!p) return;
  document.getElementById('caption-input').value = p.caption || '';
  document.getElementById('caption-modal').classList.remove('hidden');
}

// ── Caption Modal ─────────────────────
function closeCaptionModal() {
  document.getElementById('caption-modal').classList.add('hidden');
}
function saveCaption() {
  const val = document.getElementById('caption-input').value.trim();
  photos[lbIdx].caption = val;
  syncPhotoToFolders(photos[lbIdx]); // sinkronkan ke folderPhotos
  savePhotos(); saveFolders(); render();
  closeCaptionModal();
  openLb(lbIdx);
  toast('✏️ Caption disimpan!');
}

// ── Slideshow ─────────────────────────
const SS_INTERVAL = 4000;

function startSlideshow() {
  if (!photos.length) { toast('🌸 Upload foto dulu ya!'); return; }
  ssIdx = 0;
  document.getElementById('slideshow-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  buildSsDots();
  ssShow();
  document.getElementById('slideshow-btn').textContent = '⏸';
}

function stopSlideshow() {
  clearTimeout(ssTimer);
  document.getElementById('slideshow-overlay').classList.add('hidden');
  document.body.style.overflow = '';
  document.getElementById('slideshow-btn').textContent = '▶';
  document.getElementById('ss-bar').style.transition = 'none';
  document.getElementById('ss-bar').style.width = '0%';
}

function ssShow() {
  clearTimeout(ssTimer);
  const p = photos[ssIdx];
  document.getElementById('ss-img').src = p.src || p.cloudUrl || '';
  document.getElementById('ss-caption').textContent = p.caption || p.name.replace(/\.[^.]+$/, '');
  // progress bar
  const bar = document.getElementById('ss-bar');
  bar.style.transition = 'none'; bar.style.width = '0%';
  void bar.offsetWidth;
  bar.style.transition = `width ${SS_INTERVAL}ms linear`;
  bar.style.width = '100%';
  // dots
  document.querySelectorAll('.ss-dot').forEach((d, i) => d.classList.toggle('active', i === ssIdx));
  ssTimer = setTimeout(() => {
    ssIdx = (ssIdx + 1) % photos.length;
    ssShow();
  }, SS_INTERVAL);
}

function buildSsDots() {
  const wrap = document.getElementById('ss-dots');
  wrap.innerHTML = photos.map((_, i) => `<div class="ss-dot"></div>`).join('');
}

// ── Settings ──────────────────────────
function openSettings() {
  // Populate fields
  document.getElementById('gallery-name-input').value = settings.galleryName || '';
  const rawQuote = (settings.quote || '').replace(/^"|"$/g, '');
  document.getElementById('quote-input').value = rawQuote;
  document.getElementById('autolock-select').value = settings.autoLock || 5;
  document.getElementById('settings-total-desc').textContent = `${photos.length} foto tersimpan`;
  // Swatch
  document.querySelectorAll('.swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.color === settings.theme);
  });
  document.getElementById('settings-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeSettings() {
  document.getElementById('settings-overlay').classList.add('hidden');
  document.body.style.overflow = '';
}
function settingsBgClick(e) {
  if (e.target === document.getElementById('settings-overlay')) closeSettings();
}

// ── Change PIN ────────────────────────
function openChangePin() {
  document.getElementById('old-pin-input').value     = '';
  document.getElementById('new-pin-input').value     = '';
  document.getElementById('confirm-pin-input').value = '';
  document.getElementById('pin-modal-error').textContent = '';
  document.getElementById('change-pin-modal').classList.remove('hidden');
}
function closeChangePin() {
  document.getElementById('change-pin-modal').classList.add('hidden');
}
async function submitChangePin() {
  const oldPin  = document.getElementById('old-pin-input').value.trim();
  const newPin  = document.getElementById('new-pin-input').value.trim();
  const confPin = document.getElementById('confirm-pin-input').value.trim();
  const errEl   = document.getElementById('pin-modal-error');

  if (!/^\d{8}$/.test(newPin)) { errEl.textContent = '❌ PIN baru harus tepat 8 digit angka.'; return; }
  if (newPin !== confPin)       { errEl.textContent = '❌ Konfirmasi PIN tidak cocok.'; return; }

  // Verifikasi PIN lama via hash
  const storedHash = settings.pin;
  if (!storedHash) { errEl.textContent = '❌ Tidak ada PIN tersimpan.'; return; }
  const oldCorrect = await verifyPin(oldPin, storedHash);
  if (!oldCorrect) { errEl.textContent = '❌ PIN lama salah.'; return; }

  // Simpan PIN baru sebagai hash
  settings.pin = await hashPin(newPin);
  saveCfg();
  // Update UID cloud agar sync tetap pakai PIN baru
  sbSetUserFromPin(settings.pin);
  closeChangePin();
  toast('🔐 PIN berhasil diubah! Pastikan pacar juga update PIN-nya ya 💕');
}

// ── Clear all photos ──────────────────
function clearAllPhotos() {
  showConfirm({
    icon: '⚠️',
    title: 'Hapus Semua Foto?',
    message: 'SEMUA foto akan dihapus permanen. Tindakan ini tidak bisa dibatalkan.',
    okText: 'Hapus Semua',
    onOk: async () => {
      photos = [];
      folderPhotos = { game: [], her: [] };
      await savePhotos();
      await saveFolders();
      // Hapus juga dari cloud
      if (cloudSyncEnabled) {
        try {
          await sbFullSync({ photos: [], settings, tags: allTags, folderPhotos });
        } catch(e) { console.warn('[Cloud] Gagal hapus cloud:', e.message); }
      }
      render();
      updateFolderCounts();
      updatePeekCard();
      document.getElementById('settings-total-desc').textContent = '0 foto tersimpan';
      toast('🗑 Semua foto dihapus');
    }
  });
}

// ── Hearts burst ──────────────────────
function burstHearts(x, y) {
  const wrap = document.createElement('div');
  wrap.className = 'burst';
  wrap.style.left = x + 'px'; wrap.style.top = y + 'px';
  const emojis = ['💕','💗','💖','🌸','✨'];
  for (let i = 0; i < 8; i++) {
    const h = document.createElement('div');
    h.className = 'burst-heart';
    h.textContent = emojis[i % emojis.length];
    const angle = (i / 8) * 360;
    const dist  = 55 + Math.random() * 30;
    h.style.setProperty('--tx', Math.cos(angle * Math.PI / 180) * dist + 'px');
    h.style.setProperty('--ty', Math.sin(angle * Math.PI / 180) * dist + 'px');
    wrap.appendChild(h);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 900);
}

// ── Drag & drop ───────────────────────
const dz = document.getElementById('drop-zone');
if (dz) {
  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', ()  => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag');
    handleFiles(e.dataTransfer.files);
  });
}
/* ══════════════════════════════════════════════════════
   FEATURE 1: HEART COUNT + TOP FAVORITE HIGHLIGHT
══════════════════════════════════════════════════════ */

function getTopFavIdx() {
  // Find photo with most hearts (favCount), among fav photos
  let topIdx = -1, topCount = 0;
  photos.forEach((p, i) => {
    const c = p.favCount || 0;
    if (c > topCount) { topCount = c; topIdx = i; }
  });
  return topCount > 0 ? topIdx : -1;
}

/* ══════════════════════════════════════════════════════
   FEATURE 2: SECRET NOTE PER FOTO
══════════════════════════════════════════════════════ */

let secretNoteIdx = -1;

function lbOpenSecretNote() {
  secretNoteIdx = lbIdx;
  openSecretNote(lbIdx);
}

function openSecretNote(idx) {
  secretNoteIdx = idx;
  const p = photos[idx];
  const modal = document.getElementById('secret-note-modal');
  const display = document.getElementById('secret-note-display');
  const edit = document.getElementById('secret-note-edit');
  const envelope = modal.querySelector('.secret-envelope');

  // re-trigger envelope animation
  envelope.style.animation = 'none';
  void envelope.offsetWidth;
  envelope.style.animation = '';

  if (p.secretNote) {
    document.getElementById('secret-note-text').textContent = p.secretNote;
    display.classList.remove('hidden');
    edit.classList.add('hidden');
  } else {
    document.getElementById('secret-note-input').value = '';
    display.classList.add('hidden');
    edit.classList.remove('hidden');
  }
  modal.classList.remove('hidden');
}

function editSecretNote() {
  const p = photos[secretNoteIdx];
  document.getElementById('secret-note-input').value = p.secretNote || '';
  document.getElementById('secret-note-display').classList.add('hidden');
  document.getElementById('secret-note-edit').classList.remove('hidden');
}

function saveSecretNote() {
  const val = document.getElementById('secret-note-input').value.trim();
  if (secretNoteIdx < 0 || !photos[secretNoteIdx]) return;
  photos[secretNoteIdx].secretNote = val;
  syncPhotoToFolders(photos[secretNoteIdx]); // sinkronkan ke folderPhotos
  savePhotos();
  render();
  closeSecretNote();
  toast(val ? '💌 Pesan rahasia disimpan!' : '🗑 Pesan rahasia dihapus');
}

function closeSecretNote() {
  document.getElementById('secret-note-modal').classList.add('hidden');
  secretNoteIdx = -1;
}

/* ══════════════════════════════════════════════════════
   FEATURE 3: AUTO SLIDESHOW ON OPEN (opening film)
   — already has startSlideshow(), we add auto-open
   — triggered after welcome animation, if >2 photos
══════════════════════════════════════════════════════ */
// Hooked into unlockApp flow — after gallery renders, auto-start if >2 photos
function maybeAutoSlideshow() {
  // Hanya auto-start jika ada foto dengan src lokal
  // Mencegah layar hitam saat foto hanya punya cloudUrl (restore dari cloud)
  const hasLocalSrc = photos.some(p => p.src && p.src.startsWith('data:'));
  if (photos.length >= 2 && hasLocalSrc) {
    setTimeout(() => {
      toast('▶ Auto slideshow dimulai… 🎬');
      setTimeout(startSlideshow, 1200);
    }, 600);
  }
}

/* ══════════════════════════════════════════════════════
   FEATURE 4: MOOD BOARD
══════════════════════════════════════════════════════ */

let mbDragging = null;
let mbDragOffX = 0, mbDragOffY = 0;

function openMoodboard() {
  if (!photos.length) { toast('🌸 Upload foto dulu ya!'); return; }
  const overlay = document.getElementById('moodboard-overlay');
  overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  buildMoodboard();
}

function closeMoodboard() {
  document.getElementById('moodboard-overlay').classList.add('hidden');
  document.body.style.overflow = '';
}

function shuffleMoodboard() {
  buildMoodboard();
}

function buildMoodboard() {
  const canvas = document.getElementById('moodboard-canvas');
  canvas.innerHTML = '';
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight;

  // Use favorites first, then fill with rest; max 12
  let pool = [...photos.filter(p => p.fav), ...photos.filter(p => !p.fav)].slice(0, 12);

  // Assign random sizes and positions
  const sizes = [
    [160, 200], [130, 160], [180, 140], [140, 180],
    [200, 160], [120, 150], [160, 130], [150, 200]
  ];

  pool.forEach((p, i) => {
    const [w, h] = sizes[i % sizes.length];
    const x = Math.random() * Math.max(20, W - w - 20);
    const y = Math.random() * Math.max(20, H - h - 20);
    const rot = (Math.random() - 0.5) * 12;

    const el = document.createElement('div');
    el.className = 'mb-photo';
    el.style.cssText = `width:${w}px;height:${h}px;left:${x}px;top:${y}px;transform:rotate(${rot}deg);z-index:${i+1}`;
    el.dataset.rot = rot;

    const cap = p.caption || p.name.replace(/\.[^.]+$/, '');
    el.innerHTML = `<img src="${p.src || p.cloudUrl || ''}" alt=""/><div class="mb-cap">${cap}</div>`;

    // Drag support (mouse + touch)
    el.addEventListener('mousedown', mbStartDrag);
    el.addEventListener('touchstart', mbStartDragTouch, { passive: true });

    canvas.appendChild(el);
  });
}

function mbStartDrag(e) {
  const el = e.currentTarget;
  mbDragging = el;
  el.classList.add('dragging');
  const rect = el.getBoundingClientRect();
  const canvas = document.getElementById('moodboard-canvas').getBoundingClientRect();
  mbDragOffX = e.clientX - rect.left;
  mbDragOffY = e.clientY - rect.top;
  el.style.zIndex = 100;
  e.preventDefault();
}

function mbStartDragTouch(e) {
  const el = e.currentTarget;
  mbDragging = el;
  el.classList.add('dragging');
  const rect = el.getBoundingClientRect();
  mbDragOffX = e.touches[0].clientX - rect.left;
  mbDragOffY = e.touches[0].clientY - rect.top;
  el.style.zIndex = 100;
}

document.addEventListener('mousemove', (e) => {
  if (!mbDragging) return;
  const canvas = document.getElementById('moodboard-canvas');
  const cr = canvas.getBoundingClientRect();
  let nx = e.clientX - cr.left - mbDragOffX;
  let ny = e.clientY - cr.top - mbDragOffY;
  nx = Math.max(0, Math.min(cr.width - mbDragging.offsetWidth, nx));
  ny = Math.max(0, Math.min(cr.height - mbDragging.offsetHeight, ny));
  const rot = mbDragging.dataset.rot || 0;
  mbDragging.style.left = nx + 'px';
  mbDragging.style.top  = ny + 'px';
  mbDragging.style.transform = `rotate(${rot}deg)`;
});

document.addEventListener('touchmove', (e) => {
  if (!mbDragging) return;
  const canvas = document.getElementById('moodboard-canvas');
  const cr = canvas.getBoundingClientRect();
  let nx = e.touches[0].clientX - cr.left - mbDragOffX;
  let ny = e.touches[0].clientY - cr.top - mbDragOffY;
  nx = Math.max(0, Math.min(cr.width - mbDragging.offsetWidth, nx));
  ny = Math.max(0, Math.min(cr.height - mbDragging.offsetHeight, ny));
  const rot = mbDragging.dataset.rot || 0;
  mbDragging.style.left = nx + 'px';
  mbDragging.style.top  = ny + 'px';
  mbDragging.style.transform = `rotate(${rot}deg)`;
}, { passive: true });

document.addEventListener('mouseup', () => {
  if (!mbDragging) return;
  mbDragging.classList.remove('dragging');
  mbDragging = null;
});

document.addEventListener('touchend', () => {
  if (!mbDragging) return;
  mbDragging.classList.remove('dragging');
  mbDragging = null;
});


/* ══════════════════════════════════════════════════════
   FOLDER SYSTEM — Main Bareng & My Person
══════════════════════════════════════════════════════ */

// folderPhotos dideklarasikan di atas bersama state lain
let activeFolderKey = null;

const FOLDER_LABELS = {
  game: 'Main Bareng 🎮',
  her:  'My Person 🌹'
};

(function initFoldersUI() {
  // Data sudah diload di init() atas via IndexedDB
  // Tunggu sebentar lalu update UI
  setTimeout(() => {
    updateFolderCounts();
    updatePeekCard();
  }, 300);
})();

function updateFolderCounts() {
  const gc = document.getElementById('fc-game');
  const hc = document.getElementById('fc-her');
  if (gc) gc.textContent = (folderPhotos.game.length || 0) + ' foto';
  if (hc) hc.textContent = (folderPhotos.her.length  || 0) + ' foto';
}

function updatePeekCard() {
  const herPhotos = folderPhotos.her;
  const dateEl = document.getElementById('folder-peek-date');
  const imgEl  = document.getElementById('folder-peek-img');
  if (!herPhotos.length) {
    // Reset peek card ke default
    if (dateEl) dateEl.textContent = '—';
    if (imgEl)  imgEl.innerHTML = '<span>🌹</span>';
    return;
  }
  const latest = herPhotos[0];
  if (dateEl) dateEl.textContent = fmtShortDate(latest.ts);
  const imgSrc = latest.src || latest.cloudUrl || '';
  if (imgEl && imgSrc) {
    imgEl.innerHTML = `<img src="${imgSrc}" alt=""/>`;
  }
}

function openFolder(key) {
  activeFolderKey = key;
  document.getElementById('folder-lb-title').textContent = FOLDER_LABELS[key];
  document.getElementById('folder-lb').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderFolderGrid();
}

function closeFolderLb(e) {
  if (e && e.target !== document.getElementById('folder-lb')) return;
  document.getElementById('folder-lb').classList.add('hidden');
  document.body.style.overflow = '';
  activeFolderKey = null;
}

function renderFolderGrid() {
  const grid  = document.getElementById('folder-lb-grid');
  const empty = document.getElementById('folder-lb-empty');
  const list  = folderPhotos[activeFolderKey] || [];

  if (!list.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    const isGame = activeFolderKey === 'game';
    empty.innerHTML = `
      <div class="empty-icon-big">${isGame ? '🎮' : '🌸'}</div>
      <h3>${isGame ? 'Belum ada momen main bareng' : 'Belum ada foto dia'}</h3>
      <p>${isGame ? 'Capture momen seru bersama dan simpan di sini 💕' : 'Tambahkan foto cantik dia ke album spesial ini ✨'}</p>
      <button class="empty-btn" onclick="document.getElementById('folder-file-input').click()">🌸 Tambah Foto Sekarang</button>`;
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = list.map((p, i) => {
    const inMain = photos.some(mp => mp.id === p.id);
    return `
    <div class="folder-lb-item">
      <img src="${p.src || p.cloudUrl || ''}" alt=""/>
      <button class="flb-del" onclick="deleteFolderPhoto(${i})" title="Hapus">🗑</button>
      ${!inMain ? `<button class="flb-sync" onclick="syncFolderPhotoToMain(${i})" title="Tambah ke Galeri Utama">＋</button>` : `<span class="flb-synced" title="Sudah di galeri">✓</span>`}
    </div>`;
  }).join('');
}

// Sinkronkan satu foto folder ke galeri utama
function syncFolderPhotoToMain(idx) {
  const p = folderPhotos[activeFolderKey][idx];
  if (!p) return;
  if (photos.some(mp => mp.id === p.id)) { toast('✓ Foto sudah ada di galeri utama'); return; }
  photos.unshift({
    id:      p.id,
    name:    p.name || 'foto.jpg',
    src:     p.src,
    ts:      p.ts || Date.now(),
    fav:     false,
    caption: p.caption || ''
  });
  savePhotos();
  render();
  renderFolderGrid();
  toast('✅ Foto ditambahkan ke Koleksi Kenangan!');
}

// Sinkronkan SEMUA foto folder ke galeri utama
function syncAllFolderToMain() {
  const list = folderPhotos[activeFolderKey] || [];
  if (!list.length) { toast('🌸 Folder kosong'); return; }
  let added = 0;
  list.forEach(p => {
    if (!photos.some(mp => mp.id === p.id)) {
      photos.unshift({
        id:      p.id,
        name:    p.name || 'foto.jpg',
        src:     p.src,
        ts:      p.ts || Date.now(),
        fav:     false,
        caption: p.caption || ''
      });
      added++;
    }
  });
  if (added > 0) {
    savePhotos();
    render();
    renderFolderGrid();
    toast(`✅ ${added} foto disinkronkan ke Koleksi Kenangan!`);
  } else {
    toast('✓ Semua foto sudah ada di galeri utama');
  }
}

function handleFolderFiles(files) {
  if (!activeFolderKey) return;
  const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
  if (!imageFiles.length) return;
  let done = 0;
  imageFiles.forEach(f => {
    const r = new FileReader();
    r.onload = e => {
      const newPhoto = {
        id:      genId(),
        name:    f.name,
        src:     e.target.result,
        ts:      Date.now(),
        fav:     false,
        caption: ''
      };
      // Tambah ke folder
      folderPhotos[activeFolderKey].unshift(newPhoto);
      // Sinkronkan langsung ke galeri utama juga
      photos.unshift({ ...newPhoto });
      done++;
      if (done === imageFiles.length) {
        saveFolders();
        savePhotos();
        updateFolderCounts();
        updatePeekCard();
        renderFolderGrid();
        render();
        document.getElementById('folder-file-input').value = '';
        toast(`🌸 ${done} foto ditambahkan ke album & galeri!`);
      }
    };
    r.readAsDataURL(f);
  });
}

function deleteFolderPhoto(idx) {
  if (!activeFolderKey) return;
  showConfirm({
    icon: '🗑',
    title: 'Hapus dari Album?',
    message: 'Foto dihapus dari album ini (tidak dihapus dari galeri utama).',
    okText: 'Ya, Hapus',
    onOk: () => {
      folderPhotos[activeFolderKey].splice(idx, 1);
      saveFolders(); updateFolderCounts(); updatePeekCard(); renderFolderGrid();
      toast('🗑 Foto dihapus dari album');
    }
  });
}
/* ══════════════════════════════════════════════════════
   FEATURE: DARK MODE
══════════════════════════════════════════════════════ */
function toggleDarkMode() {
  const isDark = document.body.classList.toggle('dark-mode');
  settings.darkMode = isDark;
  saveCfg();
  const btn = document.getElementById('darkmode-btn');
  btn.textContent = isDark ? '☀️' : '🌙';
  btn.classList.toggle('active', isDark);
  toast(isDark ? '🌙 Dark mode aktif' : '☀️ Light mode aktif');
}

function applyDarkMode() {
  if (settings.darkMode) {
    document.body.classList.add('dark-mode');
    const btn = document.getElementById('darkmode-btn');
    if (btn) { btn.textContent = '☀️'; btn.classList.add('active'); }
  }
}

/* ══════════════════════════════════════════════════════
   FEATURE: ANNIVERSARY COUNTDOWN
══════════════════════════════════════════════════════ */
function openAnniversaryModal() {
  const modal = document.getElementById('anniversary-modal');
  if (settings.anniversaryDate) {
    document.getElementById('ann-date-input').value = settings.anniversaryDate;
  }
  modal.classList.remove('hidden');
}
function closeAnniversaryModal() {
  document.getElementById('anniversary-modal').classList.add('hidden');
}
function saveAnniversary() {
  const val = document.getElementById('ann-date-input').value;
  if (!val) { document.getElementById('ann-modal-error').textContent = 'Pilih tanggal dulu ya 💕'; return; }
  settings.anniversaryDate = val;
  saveCfg();
  updateAnniversaryBar();
  closeAnniversaryModal();
  toast('💑 Tanggal anniversary disimpan!');
}
function updateAnniversaryBar() {
  const barEl = document.getElementById('anniversary-bar');
  const countEl = document.getElementById('ann-count');
  if (!barEl) return;
  if (!settings.anniversaryDate) {
    barEl.classList.add('ann-hidden');
    return;
  }
  barEl.classList.remove('ann-hidden');
  if (!countEl) return;
  const start  = new Date(settings.anniversaryDate);
  const now    = new Date();
  const diffMs = now - start;
  if (diffMs < 0) { countEl.textContent = 'Belum dimulai ✨'; return; }
  const days   = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const months = Math.floor(days / 30.44);
  const years  = Math.floor(days / 365.25);
  let txt = '';
  if (years >= 1) txt = `${years} tahun ${Math.floor((days % 365.25) / 30.44)} bulan bersama 🌹`;
  else if (months >= 1) txt = `${months} bulan ${days % 30} hari bersama 💕`;
  else txt = `${days} hari bersama 💖`;
  countEl.textContent = txt;
}

/* ══════════════════════════════════════════════════════
   FEATURE: BACKGROUND MUSIC (Web Audio API ambient)
══════════════════════════════════════════════════════ */


/* ══════════════════════════════════════════════════════
   FEATURE: PHOTO FILTERS IN LIGHTBOX
══════════════════════════════════════════════════════ */
const FILTER_MAP = {
  none:    '',
  vintage: 'filter-vintage',
  warm:    'filter-warm',
  cool:    'filter-cool',
  bw:      'filter-bw',
  dreamy:  'filter-dreamy',
  golden:  'filter-golden',
};

function toggleFilterPanel() {
  const panel = document.getElementById('filter-panel');
  panel.classList.toggle('hidden');
}

function applyFilter(name, el) {
  const img = document.getElementById('lb-img');
  // Remove all filter classes
  Object.values(FILTER_MAP).forEach(cls => { if (cls) img.classList.remove(cls); });
  if (FILTER_MAP[name]) img.classList.add(FILTER_MAP[name]);
  // Update active button
  document.querySelectorAll('.fopt').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  // Save filter to photo
  if (photos[lbIdx]) {
    photos[lbIdx].filter = name;
    syncPhotoToFolders(photos[lbIdx]); // sinkronkan ke folderPhotos
    savePhotos();
  }
}

function resetFilterPanel() {
  document.querySelectorAll('.fopt').forEach(b => b.classList.remove('active'));
  const firstBtn = document.querySelector('.fopt');
  if (firstBtn) firstBtn.classList.add('active');
  const img = document.getElementById('lb-img');
  Object.values(FILTER_MAP).forEach(cls => { if (cls) img.classList.remove(cls); });
  document.getElementById('filter-panel').classList.add('hidden');
}

/* ══════════════════════════════════════════════════════
   FEATURE: LOVE LETTER GENERATOR
══════════════════════════════════════════════════════ */
const LOVE_LETTERS = [
  `Kamu tahu tidak, setiap kali aku melihat galeri ini, aku selalu tersenyum sendiri. Bukan karena fotonya saja, tapi karena di setiap gambar ada kamu — dan kamu adalah alasan terbesar aku bersyukur.\n\nAda momen yang tidak bisa diungkapkan dengan kata-kata, tapi entah kenapa, setiap foto kita seperti bercerita ribuan hal. Cerita tentang tawa yang tulus, momen yang sederhana tapi bermakna, dan kebersamaan yang aku tidak mau tukar dengan apapun.\n\nTerima kasih sudah ada. Terima kasih sudah menjadi bagian dari setiap kenangan indah ini. Aku sayang kamu — hari ini, besok, dan seterusnya. 💕`,

  `Untuk kamu yang selalu bikin hari-hari terasa lebih berwarna,\n\nAku pernah berpikir, apa jadinya hidup ini tanpa momen-momen yang kita abadikan bersama? Sepi, pasti. Karena kamu adalah warna yang mengisi kanvas hidupku.\n\nSetiap foto yang tersimpan di sini bukan sekadar gambar — itu adalah potongan waktu yang aku ingin kenang selamanya. Senyummu, tawamu, bahkan saat kamu tidak sadar dipotret — semuanya sempurna di mataku.\n\nSemoga kita terus menciptakan kenangan yang lebih banyak lagi. Aku selalu di sini, selalu bersamamu. 🌹`,

  `Hei kamu yang cantik / ganteng,\n\nTahukah kamu betapa beruntungnya aku? Di setiap momen yang kita lalui, aku selalu menemukan alasan baru untuk jatuh cinta padamu — lagi dan lagi.\n\nGaleri ini adalah bukti nyata bahwa kita punya cerita yang indah. Dan cerita itu belum selesai — masih banyak halaman yang ingin aku tulis bersamamu.\n\nDengan cinta yang tulus, aku berjanji untuk selalu menjaga setiap kenangan kita. Karena kamu layak mendapatkan yang terbaik, dan aku akan selalu berusaha untuk itu.\n\nSayang kamu, sangat. 💖`,

  `Kalau aku bisa memilih satu hal untuk diulang terus-menerus, itu adalah momen bersama kamu.\n\nFoto-foto ini mungkin hanya gambar di layar, tapi bagiku setiap piksel-nya menyimpan kehangatan yang nyata. Kehangatan dari tanganmu, dari senyummu, dari kehadiranmu yang selalu bisa bikin aku merasa aman.\n\nAku tidak butuh kata-kata mahal atau gestur besar untuk membuktikan perasaanku. Cukup ini — aku ada di sini, selalu ingin tahu kabarmu, selalu mau jadi tempat pulangmu.\n\nCinta itu sederhana, tapi dalam. Persis seperti perasaanku padamu. ✨`,
];

let currentLetterIdx = 0;

function openLoveLetter() {
  const modal = document.getElementById('love-letter-modal');
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  generateLetter();
}

function generateLetter() {
  const loading = document.getElementById('ll-loading');
  const text    = document.getElementById('ll-text');
  loading.classList.remove('hidden');
  text.classList.add('hidden');

  setTimeout(() => {
    currentLetterIdx = Math.floor(Math.random() * LOVE_LETTERS.length);
    const letter = LOVE_LETTERS[currentLetterIdx];
    loading.classList.add('hidden');
    text.classList.remove('hidden');
    // Typewriter effect
    text.textContent = '';
    let i = 0;
    const chars = letter.split('');
    function tick() {
      if (i < chars.length) {
        text.textContent += chars[i++];
        setTimeout(tick, 12);
      }
    }
    tick();
  }, 1200);
}

function regenerateLetter() {
  // Pick a different one
  let newIdx;
  do { newIdx = Math.floor(Math.random() * LOVE_LETTERS.length); } while (newIdx === currentLetterIdx && LOVE_LETTERS.length > 1);
  currentLetterIdx = newIdx;

  const loading = document.getElementById('ll-loading');
  const text    = document.getElementById('ll-text');
  loading.classList.remove('hidden');
  text.classList.add('hidden');
  setTimeout(() => {
    loading.classList.add('hidden');
    text.classList.remove('hidden');
    text.textContent = '';
    let i = 0;
    const chars = LOVE_LETTERS[currentLetterIdx].split('');
    function tick() { if (i < chars.length) { text.textContent += chars[i++]; setTimeout(tick, 12); } }
    tick();
  }, 800);
}

function copyLetter() {
  const txt = document.getElementById('ll-text').textContent;
  if (!txt) return;
  navigator.clipboard.writeText(txt).then(() => toast('📋 Surat disalin ke clipboard!')).catch(() => toast('Salin gagal, coba manual'));
}

function closeLoveLetter() {
  document.getElementById('love-letter-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

/* ══════════════════════════════════════════════════════
   FEATURE: CURSOR PARTICLE TRAIL
══════════════════════════════════════════════════════ */
(function initCursorParticles() {
  const canvas = document.getElementById('cursor-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const particles = [];
  const emojis = ['💕','✨','🌸','💖','🌹'];
  let mouseX = -999, mouseY = -999;

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    // Spawn particle occasionally
    if (Math.random() < 0.35) {
      particles.push({
        x: mouseX, y: mouseY,
        vx: (Math.random() - 0.5) * 1.5,
        vy: -(0.8 + Math.random() * 1.5),
        alpha: 1,
        size: 10 + Math.random() * 8,
        emoji: emojis[Math.floor(Math.random() * emojis.length)],
        life: 1,
      });
    }
  });

  function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.025;
      p.alpha = p.life;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = p.alpha * 0.8;
      ctx.font = `${p.size}px serif`;
      ctx.fillText(p.emoji, p.x, p.y);
      ctx.restore();
    }
    requestAnimationFrame(loop);
  }
  loop();
})();

/* ══════════════════════════════════════════════════════
   PATCH: Hook dark mode & anniversary into existing flow
══════════════════════════════════════════════════════ */

// Panggil applyDarkMode & updateAnniversaryBar setelah app tampil
// dengan meng-override applySettingsToUI yang sudah dipanggil saat unlock
const _origApplySettingsToUI = applySettingsToUI;
applySettingsToUI = function() {
  _origApplySettingsToUI();
  applyDarkMode();
  updateAnniversaryBar();
};

// Patch closeLb tanpa redeclare function (pakai assignment)
const _origCloseLb = closeLb;
closeLb = function() {
  resetFilterPanel();
  _origCloseLb();
};
/* ══════════════════════════════════════
   MUSIC PLAYER (compact dropdown)
══════════════════════════════════════ */
let musicTracks = [];
let musicCurrentIdx = -1;
let musicAudio = null;
let musicDropdownOpen = false;

function toggleMusicDropdown() {
  musicDropdownOpen = !musicDropdownOpen;
  const dd = document.getElementById('music-dropdown');
  const btn = document.getElementById('music-btn');
  if (musicDropdownOpen) {
    dd.classList.remove('hidden');
    btn.classList.add('music-open');
    // Close on outside click
    setTimeout(() => document.addEventListener('click', closeMusicOutside), 10);
  } else {
    dd.classList.add('hidden');
    btn.classList.remove('music-open');
    document.removeEventListener('click', closeMusicOutside);
  }
}

function closeMusicOutside(e) {
  const wrap = document.getElementById('music-btn-wrap');
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById('music-dropdown').classList.add('hidden');
    document.getElementById('music-btn').classList.remove('music-open');
    musicDropdownOpen = false;
    document.removeEventListener('click', closeMusicOutside);
  }
}

function addMusicFiles(files) {
  Array.from(files).forEach(file => {
    const name = file.name.replace(/\.[^/.]+$/, '');
    // Simpan ke IndexedDB sebagai Blob
    const reader = new FileReader();
    reader.onload = async e => {
      const blob = new Blob([e.target.result], { type: file.type });
      const id = genId();
      const url = URL.createObjectURL(blob);
      const tmp = new Audio(url);
      tmp.addEventListener('loadedmetadata', async () => {
        const track = { id, name, blob, duration: tmp.duration, type: file.type };
        await dbSaveMusic(track).catch(() => {});
        // Upload ke cloud jika aktif
        let cloudUrl = null;
        if (cloudSyncEnabled) {
          try {
            cloudUrl = await sbUploadMusic({ id, blob });
            console.log('[Cloud] Upload lagu OK:', name);
          } catch(e) {
            console.warn('[Cloud] Upload lagu gagal:', name, e.message);
          }
        }
        musicTracks.push({ id, name, url, duration: tmp.duration, cloudUrl });
        // Sync metadata setelah upload
        if (cloudSyncEnabled) sbSyncMusicMeta(musicTracks).catch(() => {});
        renderMiniPlaylist();
        updateMusicCount();
        if (musicCurrentIdx === -1) playTrack(musicTracks.length - 1);
      });
    };
    reader.readAsArrayBuffer(file);
  });
  const fi = document.getElementById('music-file-input');
  if (fi) fi.value = '';
}

// Load lagu dari IndexedDB saat startup
async function loadMusicFromDB() {
  try {
    const tracks = await dbLoadMusic();
    if (!tracks.length) return;
    tracks.forEach(t => {
      if (!t.blob) return;
      const blob = new Blob([t.blob], { type: t.type || 'audio/mpeg' });
      const url  = URL.createObjectURL(blob);
      musicTracks.push({ id: t.id, name: t.name, url, duration: t.duration });
    });
    renderMiniPlaylist();
    updateMusicCount();
    // Auto-play jika app sudah terbuka (welcome selesai lebih cepat dari load DB)
    const appVisible = !document.getElementById('app').classList.contains('hidden');
    if (appVisible && musicTracks.length > 0 && musicCurrentIdx === -1) {
      playTrack(0);
    }
  } catch(e) { console.warn('Gagal load musik dari DB:', e); }
}
// Panggil setelah DOM ready
setTimeout(loadMusicFromDB, 500);

function clearAllTracks() {
  if (!musicTracks.length) return;
  if (!confirm('Hapus semua lagu dari playlist?')) return;
  stopMusicAudio();
  musicTracks.forEach(t => {
    URL.revokeObjectURL(t.url);
    if (t.id) dbDeleteMusic(t.id).catch(() => {});
  });
  musicTracks = [];
  musicCurrentIdx = -1;
  resetMiniUI();
  renderMiniPlaylist();
  updateMusicCount();
  toast('🎵 Semua lagu dihapus');
}

function deleteTrack(e, idx) {
  e.stopPropagation();
  const t = musicTracks[idx];
  if (!t) return;
  if (!confirm(`Hapus lagu "${t.name}"?`)) return;
  URL.revokeObjectURL(t.url);
  if (t.id) dbDeleteMusic(t.id).catch(() => {});
  musicTracks.splice(idx, 1);
  if (musicCurrentIdx === idx) {
    stopMusicAudio();
    musicCurrentIdx = -1;
    resetMiniUI();
    if (musicTracks.length > 0) playTrack(0);
  } else if (musicCurrentIdx > idx) {
    musicCurrentIdx--;
  }
  renderMiniPlaylist();
  updateMusicCount();
  toast('🎵 Lagu dihapus');
}

function updateMusicCount() {
  const el = document.getElementById('music-count-desc');
  if (el) el.textContent = musicTracks.length + ' lagu tersimpan';
}

function renderMiniPlaylist() {
  const pl = document.getElementById('mdd-playlist');
  if (!pl) return;
  const empty = document.getElementById('mdd-empty');
  pl.querySelectorAll('.mdd-item').forEach(e => e.remove());
  if (musicTracks.length === 0) {
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  musicTracks.forEach((t, i) => {
    const item = document.createElement('div');
    item.className = 'mdd-item' + (i === musicCurrentIdx ? ' active' : '');
    item.style.cssText = 'display:flex;align-items:center;gap:6px;';
    item.innerHTML = `<span class="mdd-item-icon" style="flex-shrink:0">${i === musicCurrentIdx ? '♪' : (i+1)}</span><span class="mdd-item-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.name}</span><button class="mdd-del-btn" title="Hapus lagu" style="flex-shrink:0;background:none;border:none;cursor:pointer;font-size:13px;opacity:0.5;padding:0 2px;" onclick="deleteTrack(event,${i})">✕</button>`;
    item.querySelector('.mdd-item-name, .mdd-item-icon').addEventListener && void 0;
    item.onclick = (e) => { if (!e.target.classList.contains('mdd-del-btn')) playTrack(i); };
    pl.appendChild(item);
  });
}

function playTrack(idx) {
  if (idx < 0 || idx >= musicTracks.length) return;
  stopMusicAudio();
  musicCurrentIdx = idx;
  const track = musicTracks[idx];
  musicAudio = new Audio(track.url);
  musicAudio.volume = 0.8;
  musicAudio.addEventListener('timeupdate', updateMiniProgress);
  musicAudio.addEventListener('ended', () => nextTrack());
  musicAudio.play().catch(() => {});

  // UI
  const trackEl = document.getElementById('mdd-track');
  const subEl = document.getElementById('mdd-sub');
  const playBtn = document.getElementById('mdd-play-btn');
  const art = document.getElementById('mdd-art');
  if (trackEl) trackEl.textContent = track.name;
  if (subEl) subEl.textContent = formatMusicTime(track.duration || 0);
  if (playBtn) playBtn.textContent = '⏸';
  if (art) art.classList.add('spinning');

  // Nav btn pulse
  const navBtn = document.getElementById('music-btn');
  if (navBtn) { navBtn.textContent = '🎶'; navBtn.classList.add('music-open'); }

  renderMiniPlaylist();
}

function stopMusicAudio() {
  if (musicAudio) {
    musicAudio.pause();
    musicAudio = null;
  }
  const art = document.getElementById('mdd-art');
  if (art) art.classList.remove('spinning');
}

function toggleMusicPlay() {
  if (!musicAudio) {
    if (musicTracks.length > 0) playTrack(musicCurrentIdx >= 0 ? musicCurrentIdx : 0);
    return;
  }
  const playBtn = document.getElementById('mdd-play-btn');
  const art = document.getElementById('mdd-art');
  if (musicAudio.paused) {
    musicAudio.play();
    if (playBtn) playBtn.textContent = '⏸';
    if (art) art.classList.add('spinning');
  } else {
    musicAudio.pause();
    if (playBtn) playBtn.textContent = '▶';
    if (art) art.classList.remove('spinning');
  }
}

function prevTrack() {
  if (!musicTracks.length) return;
  playTrack(musicCurrentIdx <= 0 ? musicTracks.length - 1 : musicCurrentIdx - 1);
}
function nextTrack() {
  if (!musicTracks.length) return;
  playTrack((musicCurrentIdx + 1) % musicTracks.length);
}

function updateMiniProgress() {
  if (!musicAudio) return;
  const pct = musicAudio.duration ? (musicAudio.currentTime / musicAudio.duration) * 100 : 0;
  const fill = document.getElementById('mdd-progress-fill');
  const cur = document.getElementById('mdd-current');
  const tot = document.getElementById('mdd-total');
  if (fill) fill.style.width = pct + '%';
  if (cur) cur.textContent = formatMusicTime(musicAudio.currentTime);
  if (tot && musicAudio.duration) tot.textContent = formatMusicTime(musicAudio.duration);
}

function seekMusic(e) {
  if (!musicAudio || !musicAudio.duration) return;
  const bar = document.getElementById('mdd-progress-bar');
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  musicAudio.currentTime = pct * musicAudio.duration;
}

function resetMiniUI() {
  const trackEl = document.getElementById('mdd-track');
  const subEl = document.getElementById('mdd-sub');
  const playBtn = document.getElementById('mdd-play-btn');
  const fill = document.getElementById('mdd-progress-fill');
  const cur = document.getElementById('mdd-current');
  const tot = document.getElementById('mdd-total');
  if (trackEl) trackEl.textContent = 'Tidak Ada Lagu';
  if (subEl) subEl.textContent = 'Tambah lagu di ⚙️ Settings';
  if (playBtn) playBtn.textContent = '▶';
  if (fill) fill.style.width = '0%';
  if (cur) cur.textContent = '0:00';
  if (tot) tot.textContent = '0:00';
  const navBtn = document.getElementById('music-btn');
  if (navBtn) navBtn.textContent = '🎵';
}

function formatMusicTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

// Legacy stubs
function toggleMusic() { toggleMusicDropdown(); }
function openMusicPlayer() { toggleMusicDropdown(); }
function startMusic() {}
function stopMusic() {}
/* ══════════════════════════════════════════════════════
   FITUR: STATISTIK CINTA
══════════════════════════════════════════════════════ */

function openStats() {
  document.getElementById('stats-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderStats();
}

function closeStats() {
  document.getElementById('stats-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

function renderStats() {
  if (!photos.length) {
    document.getElementById('stats-subtitle').textContent = 'Belum ada foto — yuk tambahkan kenangan! 🌸';
    return;
  }

  const now = new Date();

  /* ── Ringkasan ── */
  const totalFav    = photos.filter(p => p.fav).length;
  const totalAlbum  = photos.filter(p => p.albums && p.albums.length).length;

  // Bulan unik yang ada fotonya
  const monthSet = new Set(photos.map(p => {
    const d = new Date(p.ts);
    return `${d.getFullYear()}-${d.getMonth()}`;
  }));

  document.getElementById('st-total').textContent  = photos.length;
  document.getElementById('st-fav').textContent    = totalFav;
  document.getElementById('st-albums').textContent = totalAlbum;
  document.getElementById('st-streak').textContent = monthSet.size;

  // Subtitle: rentang waktu
  const sorted = [...photos].sort((a,b) => a.ts - b.ts);
  const first  = new Date(sorted[0].ts);
  const last   = new Date(sorted[sorted.length-1].ts);
  document.getElementById('stats-subtitle').textContent =
    `${fmtDateShort(first)} — ${fmtDateShort(last)}`;

  /* ── Grafik per bulan ── */
  renderMonthlyChart();

  /* ── Hari terfavorit ── */
  renderWeekdayBars();

  /* ── Album breakdown ── */
  renderAlbumBreakdown();

  /* ── Journey ── */
  renderJourney(sorted);
}

/* Grafik batang foto per bulan (12 bulan terakhir) */
function renderMonthlyChart() {
  const canvas = document.getElementById('chart-monthly');
  const ctx    = canvas.getContext('2d');
  const W = canvas.parentElement.clientWidth - 32;
  const H = 140;
  canvas.width  = W;
  canvas.height = H;
  ctx.clearRect(0, 0, W, H);

  // Ambil 12 bulan terakhir
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth(), count: 0, label: d.toLocaleString('id-ID', { month: 'short' }) });
  }

  photos.forEach(p => {
    const d = new Date(p.ts);
    const m = months.find(m => m.year === d.getFullYear() && m.month === d.getMonth());
    if (m) m.count++;
  });

  const maxCount = Math.max(...months.map(m => m.count), 1);
  const barW  = Math.floor((W - 24) / months.length) - 4;
  const padL  = 12;
  const padB  = 28;
  const chartH = H - padB - 10;

  // Grid lines
  ctx.strokeStyle = 'rgba(232,99,122,0.1)';
  ctx.lineWidth = 1;
  [0.25, 0.5, 0.75, 1].forEach(r => {
    const y = 10 + chartH * (1 - r);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - 12, y); ctx.stroke();
  });

  // Bars
  months.forEach((m, i) => {
    const x   = padL + i * (barW + 4);
    const bH  = m.count ? Math.max(4, (m.count / maxCount) * chartH) : 2;
    const y   = 10 + chartH - bH;

    // Bar gradient
    const grad = ctx.createLinearGradient(0, y, 0, y + bH);
    grad.addColorStop(0, '#e8637a');
    grad.addColorStop(1, '#f4a0af');
    ctx.fillStyle = m.count ? grad : 'rgba(232,99,122,0.12)';
    ctx.beginPath();
    ctx.roundRect(x, y, barW, bH, [4, 4, 0, 0]);
    ctx.fill();

    // Count label on bar
    if (m.count > 0) {
      ctx.fillStyle = '#e8637a';
      ctx.font = `bold ${Math.min(10, barW - 2)}px DM Sans, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(m.count, x + barW / 2, y - 4);
    }

    // Month label
    ctx.fillStyle = 'rgba(100,60,70,0.55)';
    ctx.font = `${Math.min(9, barW)}px DM Sans, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(m.label, x + barW / 2, H - 8);
  });
}

/* Bar hari dalam seminggu */
function renderWeekdayBars() {
  const days  = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'];
  const emoji = ['☀️','💼','🌸','🌿','💫','🎉','😴'];
  const counts = Array(7).fill(0);
  photos.forEach(p => { counts[new Date(p.ts).getDay()]++; });
  const max = Math.max(...counts, 1);

  const el = document.getElementById('weekday-bars');
  el.innerHTML = days.map((d, i) => {
    const pct = Math.round((counts[i] / max) * 100);
    const isMax = counts[i] === Math.max(...counts) && counts[i] > 0;
    return `
    <div class="wday-item ${isMax ? 'wday-max' : ''}">
      <div class="wday-emoji">${emoji[i]}</div>
      <div class="wday-bar-wrap">
        <div class="wday-bar" style="width:${pct}%"></div>
      </div>
      <div class="wday-label">${d}</div>
      <div class="wday-count">${counts[i]}</div>
    </div>`;
  }).join('');
}

/* Album breakdown */
function renderAlbumBreakdown() {
  const total     = photos.length;
  const mainOnly  = photos.filter(p => !p.albums || !p.albums.length).length;
  const gameCount = (folderPhotos.game || []).length;
  const herCount  = (folderPhotos.her  || []).length;

  const items = [
    { label: '🌹 Koleksi Kenangan', count: total,     color: '#e8637a' },
    { label: '🎮 Main Bareng',      count: gameCount, color: '#7c5cbf' },
    { label: '🌸 My Person',        count: herCount,  color: '#e87aa0' },
  ];

  const el = document.getElementById('album-breakdown');
  el.innerHTML = items.map(item => {
    const pct = total ? Math.round((item.count / total) * 100) : 0;
    return `
    <div class="ab-row">
      <div class="ab-label">${item.label}</div>
      <div class="ab-bar-wrap">
        <div class="ab-bar" style="width:${Math.max(pct,2)}%;background:${item.color}"></div>
      </div>
      <div class="ab-count">${item.count} foto</div>
    </div>`;
  }).join('');
}

/* Journey: foto pertama & terbaru */
function renderJourney(sorted) {
  if (!sorted.length) return;
  const el    = document.getElementById('journey-row');
  const first = sorted[0];
  const last  = sorted[sorted.length - 1];
  const diff  = Math.floor((last.ts - first.ts) / (1000 * 60 * 60 * 24));

  el.innerHTML = `
    <div class="journey-card">
      <img src="${first.src || first.cloudUrl || ''}" class="journey-thumb" alt=""/>
      <div class="journey-info">
        <div class="journey-tag">📸 Foto Pertama</div>
        <div class="journey-date">${fmtDateLong(new Date(first.ts))}</div>
        <div class="journey-name">${first.caption || first.name.replace(/\.[^.]+$/,'')}</div>
      </div>
    </div>
    <div class="journey-mid">
      <div class="journey-line"></div>
      <div class="journey-days">${diff > 0 ? diff + ' hari' : 'Hari ini'}</div>
      <div class="journey-line"></div>
    </div>
    <div class="journey-card">
      <img src="${last.src || last.cloudUrl || ''}" class="journey-thumb" alt=""/>
      <div class="journey-info">
        <div class="journey-tag">🌟 Foto Terbaru</div>
        <div class="journey-date">${fmtDateLong(new Date(last.ts))}</div>
        <div class="journey-name">${last.caption || last.name.replace(/\.[^.]+$/,'')}</div>
      </div>
    </div>`;
}

function fmtDateShort(d) {
  return d.toLocaleString('id-ID', { month: 'long', year: 'numeric' });
}
function fmtDateLong(d) {
  return d.toLocaleString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}
/* ══════════════════════════════════════════════════════
   FITUR: CUSTOM ICON / GANTI IKON GALERI
══════════════════════════════════════════════════════ */

let _pendingIconData = null; // { type: 'emoji'|'image', value: string (emoji or base64) }

function openIconPicker() {
  // Load current icon into preview
  const preview = document.getElementById('icon-picker-preview');
  applyIconToElement(preview, settings.customIcon || null);
  _pendingIconData = null;
  document.getElementById('icon-picker-modal').classList.remove('hidden');
}

function closeIconPicker() {
  document.getElementById('icon-picker-modal').classList.add('hidden');
  _pendingIconData = null;
}

function handleIconFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const base64 = e.target.result;
    _pendingIconData = { type: 'image', value: base64 };
    const preview = document.getElementById('icon-picker-preview');
    preview.style.backgroundImage = `url(${base64})`;
    preview.style.backgroundSize = 'cover';
    preview.style.backgroundPosition = 'center';
    preview.style.backgroundRepeat = 'no-repeat';
    preview.style.fontSize = '0px';
    preview.textContent = '';
  };
  reader.readAsDataURL(file);
}

function selectEmoji(emoji) {
  _pendingIconData = { type: 'emoji', value: emoji };
  const preview = document.getElementById('icon-picker-preview');
  preview.style.backgroundImage = '';
  preview.style.fontSize = '';
  preview.textContent = emoji;
  // Highlight selected
  document.querySelectorAll('.emoji-opt').forEach(b => b.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
}

function saveIcon() {
  if (!_pendingIconData) { closeIconPicker(); return; }
  settings.customIcon = _pendingIconData;
  saveCfg();
  applyCustomIconToAll();
  toast('✅ Ikon berhasil diubah!');
  closeIconPicker();
}

function applyIconToElement(el, iconData) {
  if (!el) return;
  if (!iconData) {
    el.style.backgroundImage = '';
    el.style.fontSize = '';
    el.textContent = '🌹';
    return;
  }
  if (iconData.type === 'image') {
    el.style.backgroundImage = `url(${iconData.value})`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.style.backgroundRepeat = 'no-repeat';
    el.style.fontSize = '0px';
    el.textContent = '';
  } else {
    el.style.backgroundImage = 'none';
    el.style.fontSize = '';
    el.textContent = iconData.value;
  }
}

function applyCustomIconToAll() {
  const icon = settings.customIcon || null;
  const ids = ['lock-rose-el','nav-rose-el','hero-rose-el','welcome-rose'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) applyIconToElement(el, icon);
  });
  // Also update folder-peek-img default
  const folderPeek = document.getElementById('folder-peek-img');
  if (folderPeek && !folderPeek.querySelector('img')) {
    const span = folderPeek.querySelector('span');
    if (span) {
      if (icon && icon.type === 'image') {
        span.style.display = 'none';
      } else {
        span.style.display = '';
        span.textContent = icon ? icon.value : '🌹';
      }
    }
  }
}

// Apply icon after page load
window.addEventListener('load', () => {
  setTimeout(() => { if (settings && settings.customIcon) applyCustomIconToAll(); }, 600);
});

/* ══════════════════════════════════════════════════════
   FITUR: KAPSUL KENANGAN (Memory Capsule)
══════════════════════════════════════════════════════ */

function openCapsule() {
  document.getElementById('capsule-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderCapsule();
}

function closeCapsule() {
  document.getElementById('capsule-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

async function renderCapsule() {
  const capsule = await dbLoadConfig('capsule');
  const form    = document.getElementById('capsule-form');
  const locked  = document.getElementById('capsule-locked');
  const opened  = document.getElementById('capsule-open');

  [form, locked, opened].forEach(el => el.classList.add('hidden'));

  if (!capsule) {
    // No capsule — show form
    const minDate = new Date();
    minDate.setDate(minDate.getDate() + 1);
    document.getElementById('capsule-date-input').min = minDate.toISOString().split('T')[0];
    document.getElementById('capsule-date-input').value = '';
    document.getElementById('capsule-msg-input').value = '';
    form.classList.remove('hidden');
    return;
  }

  const openDate = new Date(capsule.openDate);
  const now = new Date();

  if (now >= openDate) {
    // Capsule is ready to open!
    opened.classList.remove('hidden');
    document.getElementById('capsule-open-msg').textContent = capsule.message;
    // Trigger confetti
    setTimeout(spawnCapsuleConfetti, 300);
  } else {
    // Still locked
    locked.classList.remove('hidden');
    const diff = openDate - now;
    const days  = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    document.getElementById('capsule-lock-title').textContent = '🔒 Kapsul Terkunci';
    document.getElementById('capsule-lock-date').textContent  = `Terbuka: ${fmtDateLong(openDate)}`;
    document.getElementById('capsule-lock-countdown').textContent = days > 0
      ? `${days} hari ${hours} jam lagi…`
      : `${hours} jam lagi…`;
  }
}

async function saveCapsule() {
  const dateVal = document.getElementById('capsule-date-input').value;
  const msg     = document.getElementById('capsule-msg-input').value.trim();
  if (!dateVal) { toast('❌ Pilih tanggal dulu!'); return; }
  if (!msg)     { toast('❌ Tulis pesan dulu!'); return; }
  const openDate = new Date(dateVal);
  const now = new Date(); now.setHours(0,0,0,0);
  if (openDate <= now) { toast('❌ Tanggal harus di masa depan!'); return; }
  await dbSaveConfig('capsule', { openDate: openDate.getTime(), message: msg, createdAt: Date.now() });
  toast('💊 Kapsul kenangan disimpan!');
  renderCapsule();
}

async function deleteCapsule() {
  if (!confirm('Hapus kapsul kenangan ini?')) return;
  await dbSaveConfig('capsule', null);
  renderCapsule();
}

async function resetCapsule() {
  await dbSaveConfig('capsule', null);
  renderCapsule();
}

function spawnCapsuleConfetti() {
  const modal = document.getElementById('capsule-modal');
  if (!modal) return;
  const colors = ['#e8637a','#f4a0af','#fde8ec','#c9956a','#fff'];
  for (let i = 0; i < 40; i++) {
    const el = document.createElement('div');
    el.style.cssText = `
      position:fixed;
      left:${20 + Math.random()*60}vw;
      top:${20 + Math.random()*30}vh;
      width:${6+Math.random()*8}px;
      height:${6+Math.random()*8}px;
      border-radius:${Math.random()>0.5?'50%':'2px'};
      background:${colors[Math.floor(Math.random()*colors.length)]};
      pointer-events:none;
      z-index:9999;
      animation:confettiFall ${1.2+Math.random()*1.5}s ease-out forwards;
      animation-delay:${Math.random()*0.5}s;
    `;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }
}

// Inject confetti keyframes
if (!document.getElementById('confetti-style')) {
  const s = document.createElement('style');
  s.id = 'confetti-style';
  s.textContent = `@keyframes confettiFall {
    0%   { opacity:1; transform:translateY(0) rotate(0deg); }
    100% { opacity:0; transform:translateY(120px) rotate(360deg); }
  }`;
  document.head.appendChild(s);
}

/* ══════════════════════════════════════════════════════
   FITUR: SELECT MODE — PILIH & HAPUS BANYAK FOTO
══════════════════════════════════════════════════════ */

function enterSelectMode() {
  selectMode = true;
  selectedIds.clear();
  document.getElementById('select-toolbar').classList.remove('hidden');
  document.getElementById('select-enter-wrap').classList.add('hidden');
  updateSelCount();
  render();
}

function exitSelectMode() {
  selectMode = false;
  selectedIds.clear();
  document.getElementById('select-toolbar').classList.add('hidden');
  document.getElementById('select-enter-wrap').classList.remove('hidden');
  render();
}

function toggleSelectPhoto(e, id) {
  e.stopPropagation();
  const sid = String(id); // pastikan selalu string
  if (selectedIds.has(sid)) {
    selectedIds.delete(sid);
  } else {
    selectedIds.add(sid);
  }
  updateSelCount();

  const isSelected = selectedIds.has(sid);
  const checkEl = document.querySelector(`.select-check[data-photoid="${sid}"]`);
  if (checkEl) {
    checkEl.classList.toggle('checked', isSelected);
    checkEl.textContent = isSelected ? '✓' : '';
    const item = checkEl.closest('.photo-item');
    if (item) {
      item.classList.toggle('selected-item', isSelected);
      const img = item.querySelector('img');
      if (img) img.style.opacity = isSelected ? '0.7' : '';
    }
  }
}

function toggleSelectAll() {
  const list = getFiltered();
  const allSelected = list.every(p => selectedIds.has(String(p.id)));
  if (allSelected) {
    list.forEach(p => selectedIds.delete(String(p.id)));
  } else {
    list.forEach(p => selectedIds.add(String(p.id)));
  }
  updateSelCount();

  document.querySelectorAll('.photo-item.select-mode-item').forEach(item => {
    const check = item.querySelector('.select-check');
    if (!check) return;
    const id = check.dataset.photoid;
    if (!id) return;
    const isSelected = selectedIds.has(id);
    check.classList.toggle('checked', isSelected);
    check.textContent = isSelected ? '✓' : '';
    item.classList.toggle('selected-item', isSelected);
    const img = item.querySelector('img');
    if (img) img.style.opacity = isSelected ? '0.7' : '';
  });
}

function updateSelCount() {
  const count = selectedIds.size;
  const countEl = document.getElementById('sel-count');
  const deleteBtn = document.getElementById('delete-selected-btn');
  if (countEl) countEl.textContent = `${count} dipilih`;
  if (deleteBtn) {
    deleteBtn.disabled = count === 0;
    deleteBtn.style.opacity = count === 0 ? '0.4' : '1';
  }
  // Update select-all btn text
  const list = getFiltered();
  const allSelected = list.length > 0 && list.every(p => selectedIds.has(String(p.id)));
  const selAllBtn = document.getElementById('select-all-btn');
  if (selAllBtn) selAllBtn.textContent = allSelected ? '☐ Batal Semua' : '☑ Pilih Semua';
}

async function deleteSelected() {
  if (selectedIds.size === 0) { toast('Belum ada foto yang dipilih'); return; }
  const count = selectedIds.size;
  showConfirm({
    icon: '🗑',
    title: `Hapus ${count} Foto?`,
    message: `${count} foto yang dipilih akan dihapus permanen dan tidak bisa dikembalikan.`,
    okText: `Hapus ${count} Foto`,
    onOk: async () => {
      photos = photos.filter(p => !selectedIds.has(String(p.id)));
      if (folderPhotos) {
        folderPhotos.game = (folderPhotos.game || []).filter(p => !selectedIds.has(String(p.id)));
        folderPhotos.her  = (folderPhotos.her  || []).filter(p => !selectedIds.has(String(p.id)));
      }
      await savePhotos(); await saveFolders(); updateFolderCounts();
      selectedIds.clear(); exitSelectMode();
      toast(`🗑 ${count} foto berhasil dihapus`);
    }
  });
}
/* ══════════════════════════════════════════════════════
   FITUR: TAG / KATEGORI FOTO
══════════════════════════════════════════════════════ */

const TAG_PRESETS = [
  { name: 'Romantis',   color: '#e8637a', emoji: '💕' },
  { name: 'Petualangan',color: '#f59e0b', emoji: '🏔' },
  { name: 'Makanan',    color: '#10b981', emoji: '🍜' },
  { name: 'Selfie',     color: '#8b5cf6', emoji: '🤳' },
  { name: 'Game',       color: '#3b82f6', emoji: '🎮' },
  { name: 'Ulang Tahun',color: '#ec4899', emoji: '🎂' },
  { name: 'Liburan',    color: '#06b6d4', emoji: '✈️' },
  { name: 'Keluarga',   color: '#84cc16', emoji: '👨‍👩‍👧' },
];

function openTagManager() {
  renderTagManager();
  document.getElementById('tag-manager-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeTagManager() {
  document.getElementById('tag-manager-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

function renderTagManager() {
  const list = document.getElementById('tag-list');
  if (!list) return;
  list.innerHTML = allTags.length === 0
    ? '<p style="opacity:.5;font-size:.85rem;text-align:center;padding:16px">Belum ada tag. Tambah di bawah!</p>'
    : allTags.map(t => `
        <div class="tag-item-row" style="border-left:3px solid ${t.color}">
          <span class="tag-emoji">${t.emoji}</span>
          <span class="tag-name">${escHtml(t.name)}</span>
          <span class="tag-pill" style="background:${t.color}22;color:${t.color}">${countPhotosWithTag(t.id)} foto</span>
          <button class="tag-del-btn" onclick="deleteTag('${t.id}')">✕</button>
        </div>`
    ).join('');
}

function countPhotosWithTag(tid) {
  return photos.filter(p => (p.tags || []).includes(tid)).length;
}

async function addTagFromForm() {
  const nameEl  = document.getElementById('new-tag-name');
  const colorEl = document.getElementById('new-tag-color');
  const emojiEl = document.getElementById('new-tag-emoji');
  const name = (nameEl?.value || '').trim();
  if (!name) { toast('❌ Nama tag tidak boleh kosong!'); return; }
  const tag = {
    id:        'tag_' + Date.now(),
    name,
    color:     colorEl?.value || '#e8637a',
    emoji:     emojiEl?.value || '🏷',
    createdAt: Date.now(),
  };
  allTags.push(tag);
  await dbPutTag(tag);
  if (nameEl)  nameEl.value  = '';
  if (emojiEl) emojiEl.value = '';
  renderTagManager();
  renderTagFilterBar();
  toast(`🏷 Tag "${name}" ditambahkan!`);
}

async function addPresetTag(idx) {
  const p = TAG_PRESETS[idx];
  if (!p) return;
  const tag = { id: 'tag_' + Date.now(), ...p, createdAt: Date.now() };
  allTags.push(tag);
  await dbPutTag(tag);
  renderTagManager();
  renderTagFilterBar();
  toast(`🏷 Tag "${p.name}" ditambahkan!`);
}

async function deleteTag(id) {
  if (!confirm('Hapus tag ini? Tag akan dihapus dari semua foto.')) return;
  allTags = allTags.filter(t => t.id !== id);
  // Hapus dari semua foto
  photos.forEach(p => { p.tags = (p.tags || []).filter(tid => tid !== id); });
  await dbDeleteTag(id);
  await dbSavePhotos(photos);
  activeTagIds.delete(id);
  renderTagManager();
  renderTagFilterBar();
  render();
  toast('🗑 Tag dihapus');
}

// Bar filter tag di bawah tab utama
function renderTagFilterBar() {
  const bar = document.getElementById('tag-filter-bar');
  if (!bar) return;
  if (!allTags.length) { bar.innerHTML = ''; return; }
  bar.innerHTML = allTags.map(t => {
    const active = activeTagIds.has(t.id);
    return `<button class="tag-filter-btn ${active ? 'active' : ''}"
              style="--tc:${t.color}"
              onclick="toggleTagFilter('${t.id}')">
              ${t.emoji} ${escHtml(t.name)}
            </button>`;
  }).join('');
}

function toggleTagFilter(id) {
  if (activeTagIds.has(id)) activeTagIds.delete(id);
  else activeTagIds.add(id);
  renderTagFilterBar();
  render();
}

function clearTagFilter() {
  activeTagIds.clear();
  renderTagFilterBar();
  render();
}

// Edit tag foto di lightbox
function openPhotoTagEditor() {
  const p = photos[lbIdx];
  if (!p) return;
  if (!allTags.length) {
    toast('❌ Belum ada tag. Buat tag dulu di ⚙️ Settings → Kelola Tag.');
    return;
  }
  renderPhotoTagEditor(p);
  document.getElementById('photo-tag-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closePhotoTagEditor() {
  document.getElementById('photo-tag-modal').classList.add('hidden');
  document.body.style.overflow = '';
}
function renderPhotoTagEditor(p) {
  const wrap = document.getElementById('photo-tag-picker');
  if (!wrap) return;
  const cur = p.tags || [];
  wrap.innerHTML = allTags.map(t => {
    const on = cur.includes(t.id);
    return `<label class="photo-tag-opt ${on ? 'on' : ''}" style="--tc:${t.color}">
      <input type="checkbox" value="${t.id}" ${on ? 'checked' : ''} onchange="togglePhotoTag('${t.id}',this.checked)">
      ${t.emoji} ${escHtml(t.name)}
    </label>`;
  }).join('');
}
async function togglePhotoTag(tid, checked) {
  const p = photos[lbIdx];
  if (!p) return;
  p.tags = p.tags || [];
  if (checked && !p.tags.includes(tid)) p.tags.push(tid);
  if (!checked) p.tags = p.tags.filter(id => id !== tid);
  syncPhotoToFolders(p); // sinkronkan ke folderPhotos
  await dbSavePhotos(photos).catch(() => {});
  render();
}
async function savePhotoTags() {
  await dbSavePhotos(photos).catch(() => {});
  closePhotoTagEditor();
  render();
  toast('🏷 Tag foto disimpan!');
}

// Render tag pills di photo grid
function renderPhotoTagBadges(p) {
  if (!p.tags || !p.tags.length || !allTags.length) return '';
  return p.tags.slice(0,2).map(tid => {
    const t = allTags.find(t => t.id === tid);
    if (!t) return '';
    return `<span class="photo-tag-badge" style="background:${t.color}dd">${t.emoji}</span>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════
   FITUR: EXPORT / IMPORT BACKUP
══════════════════════════════════════════════════════ */

function openBackupModal() {
  document.getElementById('backup-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  // Update info
  const infoEl = document.getElementById('backup-info');
  if (infoEl) {
    infoEl.textContent = `${photos.length} foto · ${allTags.length} tag · terakhir diubah: ${photos.length ? fmtDate(Math.max(...photos.map(p=>p.ts))) : '—'}`;
  }
}
function closeBackupModal() {
  document.getElementById('backup-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

async function doExportWithPhotos() {
  toast('📦 Menyiapkan backup... (mungkin butuh beberapa detik)');
  try {
    await dbExportBackup(true);
    toast('✅ Backup dengan foto berhasil diunduh!');
  } catch(e) {
    toast('❌ Export gagal: ' + e.message);
  }
  closeBackupModal();
}

async function doExportMetaOnly() {
  try {
    await dbExportBackup(false);
    toast('✅ Backup metadata berhasil diunduh!');
  } catch(e) {
    toast('❌ Export gagal: ' + e.message);
  }
  closeBackupModal();
}

async function doImportBackup(fileInput) {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const backup = await dbParseBackupFile(file);
    const photoCount = backup.photos?.length || 0;
    const tagCount   = backup.tags?.length   || 0;
    const ok = confirm(
      `Import backup dari ${backup._exportedAt?.slice(0,10) || '?'}?\n\n` +
      `📷 ${photoCount} foto\n🏷 ${tagCount} tag\n\n` +
      `⚠️ Data saat ini akan ditimpa!`
    );
    if (!ok) { fileInput.value = ''; return; }
    toast('📥 Mengimport data...');
    await dbImportBackup(backup);
    // Reload state
    photos   = await dbLoadPhotos();
    allTags  = await dbLoadTags();
    folderPhotos = await dbLoadFolders();
    const cfg = await dbLoadConfig('settings');
    if (cfg) { settings = Object.assign({}, DEFAULT_SETTINGS, cfg); applySettingsToUI(); }
    // Reload musik dari backup
    stopMusicAudio();
    musicTracks = [];
    musicCurrentIdx = -1;
    await loadMusicFromDB();
    render();
    renderTagFilterBar();
    toast('✅ Import berhasil!');
  } catch(e) {
    toast('❌ Import gagal: ' + e.message);
  }
  fileInput.value = '';
  closeBackupModal();
}

/* ══════════════════════════════════════════════════════
   PWA: Install prompt & offline indicator
══════════════════════════════════════════════════════ */

let deferredPwaPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPwaPrompt = e;
  // Tampilkan tombol install jika ada
  const btn = document.getElementById('pwa-install-btn');
  if (btn) btn.classList.remove('hidden');
});

window.addEventListener('appinstalled', () => {
  deferredPwaPrompt = null;
  const btn = document.getElementById('pwa-install-btn');
  if (btn) btn.classList.add('hidden');
  toast('📲 Love Gallery berhasil diinstall!');
});

async function installPwa() {
  if (!deferredPwaPrompt) {
    toast('📲 App sudah terinstall atau browser tidak mendukung');
    return;
  }
  deferredPwaPrompt.prompt();
  const { outcome } = await deferredPwaPrompt.userChoice;
  if (outcome === 'accepted') toast('💕 Terima kasih sudah install!');
  deferredPwaPrompt = null;
}

// Offline / online indicator
function updateOnlineStatus() {
  const el = document.getElementById('offline-badge');
  if (!el) return;
  if (navigator.onLine) {
    el.classList.add('hidden');
  } else {
    el.classList.remove('hidden');
  }
}
window.addEventListener('online',  updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
window.addEventListener('load',    updateOnlineStatus);

/* ═══════════════════════════════════════════════════════════
   PATCH: timeline.js + scrapbook.js
   Tambahkan file ini ke project, lalu di index.html
   sebelum </body>, tambahkan:
     <script src="timeline.js"></script>
     <script src="scrapbook.js"></script>

   ATAU copy-paste semua isi file ini ke bagian PALING BAWAH
   script.js yang sudah ada (setelah baris terakhir).
═══════════════════════════════════════════════════════════ */


/* ══════════════════════════════════════════════════════════
   FITUR 1 — TIMELINE / MOMEN
══════════════════════════════════════════════════════════ */

function openTimeline() {
  renderTimeline();
  document.getElementById('timeline-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeTimeline() {
  document.getElementById('timeline-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

function renderTimeline() {
  const body = document.getElementById('timeline-body');
  if (!body) return;

  if (!photos.length) {
    body.innerHTML = '<p style="text-align:center;color:var(--muted);padding:32px 0">Belum ada foto 🌸</p>';
    renderOnThisDay();
    return;
  }

  // Kelompokkan foto per bulan (format: "Januari 2025")
  const groups = {};
  photos.forEach(p => {
    const d     = new Date(p.ts);
    const key   = d.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    const order = d.getFullYear() * 100 + d.getMonth(); // angka untuk sorting
    if (!groups[key]) groups[key] = { order, photos: [] };
    groups[key].photos.push(p);
  });

  // Urutkan dari terbaru
  const sorted = Object.entries(groups).sort((a, b) => b[1].order - a[1].order);

  body.innerHTML = sorted.map(([month, { photos: grp }]) => {
    const thumbs = grp.slice(0, 6).map((p, i) => {
      const realIdx = photos.indexOf(p);
      return `<div class="tl-thumb" onclick="closeTimeline();openLb(${realIdx})" title="${escHtml(p.caption || p.name)}">
        <img src="${p.src || p.cloudUrl || ''}" alt="" loading="lazy"/>
        ${p.fav ? '<span class="tl-fav-dot">♥</span>' : ''}
      </div>`;
    }).join('');
    const more = grp.length > 6
      ? `<div class="tl-more">+${grp.length - 6} lagi</div>`
      : '';

    return `
      <div class="tl-group">
        <div class="tl-group-header">
          <div class="tl-dot"></div>
          <span class="tl-month">${month}</span>
          <span class="tl-count">${grp.length} foto</span>
        </div>
        <div class="tl-thumbs-row">${thumbs}${more}</div>
      </div>`;
  }).join('');

  renderOnThisDay();
}

function renderOnThisDay() {
  const banner = document.getElementById('otd-banner');
  if (!banner || !photos.length) return;

  const now     = new Date();
  const todayMD = `${now.getMonth()}-${now.getDate()}`;

  // Foto yang diunggah hari yang sama (bulan & tanggal) di tahun LALU atau lebih
  const matches = photos.filter(p => {
    const d = new Date(p.ts);
    const md = `${d.getMonth()}-${d.getDate()}`;
    return md === todayMD && d.getFullYear() < now.getFullYear();
  });

  if (!matches.length) {
    banner.classList.add('hidden');
    return;
  }

  banner.classList.remove('hidden');

  // Caption: ambil yang punya caption, fallback ke nama file
  const sample = matches[0];
  const cap    = sample.caption || sample.name.replace(/\.[^.]+$/, '');
  document.getElementById('otd-caption').textContent =
    `"${cap}" · ${new Date(sample.ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}`;

  // Thumbnails (max 3)
  const thumbsEl = document.getElementById('otd-thumbs');
  thumbsEl.innerHTML = matches.slice(0, 3).map(p => {
    const realIdx = photos.indexOf(p);
    return `<img src="${p.src || p.cloudUrl || ''}" alt="" class="otd-thumb" onclick="closeTimeline();openLb(${realIdx})"/>`;
  }).join('');
}



/* ═══════════════════════════════════════════════════
   FITUR: SHARE KE WHATSAPP
═══════════════════════════════════════════════════ */

async function lbShareWA() {
  const p = photos[lbIdx];
  if (!p) return;

  const caption = p.caption || p.name?.replace(/\.[^.]+$/, '') || 'Kenangan kita 💕';

  // Coba Web Share API dulu (native share sheet — support di Android Chrome & iOS Safari)
  if (navigator.share && navigator.canShare) {
    try {
      // Konversi base64 src ke File object
      const res   = await fetch(p.src);
      const blob  = await res.blob();
      const ext   = blob.type.split('/')[1] || 'jpg';
      const file  = new File([blob], `kenangan.${ext}`, { type: blob.type });

      const shareData = { files: [file], text: caption + '\n\n📸 via Love Gallery 🌹' };

      if (navigator.canShare(shareData)) {
        await navigator.share(shareData);
        return; // sukses, selesai
      }
    } catch(e) {
      if (e.name !== 'AbortError') console.warn('Share API gagal:', e);
      else return; // user batal, tidak perlu fallback
    }
  }

  // Fallback: download foto dulu, lalu buka WA dengan teks
  // Ini cara paling kompatibel di semua browser
  try {
    // Download foto
    const a    = document.createElement('a');
    a.href     = p.src;
    a.download = `kenangan-${Date.now()}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Buka WA setelah delay singkat
    await new Promise(r => setTimeout(r, 600));

    const teks  = encodeURIComponent(caption + '\n\n📸 via Love Gallery 🌹');
    const waUrl = `https://wa.me/?text=${teks}`;
    window.open(waUrl, '_blank');

    toast('📥 Foto didownload — kirim via WA yang terbuka!');
  } catch(e) {
    toast('❌ Gagal share. Coba screenshot manual ya.');
  }
}
/* ═══════════════════════════════════════════════════════
   ADDITIONS — showConfirm, upload loading, dark mode fix
═══════════════════════════════════════════════════════ */

/* FIX 4: Custom confirm modal */
function showConfirm({ icon = '🗑', title = 'Konfirmasi', message = '', okText = 'Hapus', danger = true, onOk }) {
  const old = document.getElementById('_confirm_modal');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.id = '_confirm_modal';
  overlay.innerHTML = `
    <div class="confirm-box">
      <div class="confirm-icon">${icon}</div>
      <div class="confirm-title">${title}</div>
      <div class="confirm-msg">${message}</div>
      <div class="confirm-actions">
        <button class="confirm-btn-cancel" id="_conf_cancel">Batal</button>
        <button class="confirm-btn-ok ${danger ? '' : 'safe'}" id="_conf_ok">${okText}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  const close = () => { overlay.remove(); document.body.style.overflow = ''; };
  document.getElementById('_conf_cancel').onclick = close;
  document.getElementById('_conf_ok').onclick = () => { close(); onOk(); };
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
}

/* FIX 8: Upload loading overlay */
function showUploadLoading(total) {
  const old = document.getElementById('_upload_loading');
  if (old) old.remove();
  const el = document.createElement('div');
  el.id = '_upload_loading';
  el.className = 'upload-loading-overlay';
  el.innerHTML = `
    <div class="upload-loading-spinner"></div>
    <div class="upload-loading-text">Menyimpan kenangan... 🌹</div>
    <div class="upload-loading-sub" id="_upload_sub">Memproses ${total} foto</div>
    <div class="upload-loading-bar-wrap"><div class="upload-loading-bar" id="_upload_bar"></div></div>`;
  document.body.appendChild(el);
}
function updateUploadLoading(done, total) {
  const bar = document.getElementById('_upload_bar');
  const sub = document.getElementById('_upload_sub');
  if (bar) bar.style.width = Math.round((done / total) * 100) + '%';
  if (sub) sub.textContent = `${done} dari ${total} foto diproses`;
}
function hideUploadLoading() {
  const el = document.getElementById('_upload_loading');
  if (!el) return;
  el.style.opacity = '0'; el.style.transition = 'opacity 0.3s';
  setTimeout(() => el.remove(), 300);
}

/* FIX 8: Override confirmAlbumPicker dengan loading */
const _origConfirmAlbumPicker2 = confirmAlbumPicker;
confirmAlbumPicker = function() {
  const toGame = document.getElementById('ap-check-game').checked;
  const toHer  = document.getElementById('ap-check-her').checked;
  const albumTags = [];
  if (toGame) albumTags.push('game');
  if (toHer)  albumTags.push('her');
  const imageFiles = [..._pendingFiles];
  if (!imageFiles.length) return;
  const total = imageFiles.length;
  closeAlbumPicker();
  if (total > 2) showUploadLoading(total);
  let done = 0;
  imageFiles.forEach(f => {
    const r = new FileReader();
    r.onload = e => {
      const newPhoto = { id: genId(), name: f.name, src: e.target.result, ts: Date.now(), fav: false, size: f.size, caption: '', albums: albumTags };
      photos.unshift({ ...newPhoto });
      if (toGame) { folderPhotos['game'] = folderPhotos['game'] || []; folderPhotos['game'].unshift({ ...newPhoto }); }
      if (toHer)  { folderPhotos['her']  = folderPhotos['her']  || []; folderPhotos['her'].unshift({ ...newPhoto }); }
      done++;
      if (total > 2) updateUploadLoading(done, total);
      if (done === total) {
        savePhotos();
        if (toGame || toHer) saveFolders();
        render(); updateFolderCounts(); updatePeekCard();
        if (total > 2) hideUploadLoading();
        const labels = ['Koleksi Kenangan'];
        if (toGame) labels.push('Main Bareng');
        if (toHer)  labels.push('My Person');
        toast(`🌸 ${total} foto ditambahkan!`);
      }
    };
    r.readAsDataURL(f);
  });
};

/* FIX 7: Pastikan dark mode konsisten saat toggle */
const _origToggleDarkMode2 = toggleDarkMode;
toggleDarkMode = function() {
  _origToggleDarkMode2();
  document.documentElement.classList.toggle('dark-mode', !!settings.darkMode);
};

console.log('✅ Patch berhasil dimuat!');

/* ═══════════════════════════════════════════════════
   PATCH SCRAPBOOK v3 — Script overrides
   Paste ini di bagian PALING BAWAH script.js kamu
   (setelah semua kode yang sudah ada)
═══════════════════════════════════════════════════ */

/* ── Override variabel & state ── */
let scrapSelected = [];
let scrapTemplate = 'mosaic';
let scrapSticker  = null;   // stiker aktif terakhir dipilih (untuk kompatibilitas toggle UI)
let scrapCaption  = '';     // caption/quote custom

// MULTI-STIKER: array [{id, value, x, y}]
// value = string emoji ATAU object {type:'custom', src, id}
let placedStickers = [];
let _stickerIdCounter = 0;
function genStickerId() { return 'sk_' + Date.now() + '_' + (++_stickerIdCounter); }

// Posisi default stiker (koordinat canvas 0-1080)
let scrapStickerX = 540;
let scrapStickerY = 540;


// Posisi foto yang bisa digeser — koordinat canvas (0–1080)
let scrapPhotoPositions = []; // [{x, y}] sesuai index scrapSelected

// Koleksi stiker custom yang sudah diupload (persisten di sesi ini)
let customStickers = []; // [{id, src, name}]

/* ── Helper load image ── */
function loadImg(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload  = () => res(img);
    img.onerror = () => rej(new Error('Gagal load gambar'));
    img.src = src;
  });
}

/* ── Open / Close ── */
function openScrapbook() {
  scrapSelected = [];
  scrapTemplate = 'mosaic';
  scrapSticker  = null;
  scrapCaption  = '';
  scrapStickerX = 540;
  scrapStickerY = 540;
  placedStickers = [];
  scrapPhotoPositions = [];
  _photoDragBound = false;
  _photoDragIdx   = -1;
  _scrapFirstRender = true;
  if (_photoDragAbort) { _photoDragAbort.abort(); _photoDragAbort = null; }
  renderScrapPickGrid();
  updateScrapUI();
  const dlBtn = document.getElementById('scrap-dl-btn');
  if (dlBtn) dlBtn.classList.add('hidden');

  // Reset canvas
  const canvas = document.getElementById('scrap-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // Reset stiker & caption input
  document.querySelectorAll('.scrap-sticker-btn').forEach(b => b.classList.remove('active'));
  // Reset tab ke emoji
  document.querySelectorAll('.scrap-sticker-tab').forEach(b => b.classList.remove('active'));
  const tabEmoji = document.getElementById('sticker-tab-emoji');
  if (tabEmoji) tabEmoji.classList.add('active');
  const panelEmoji = document.getElementById('sticker-panel-emoji');
  if (panelEmoji) panelEmoji.classList.remove('hidden');
  const panelCustom = document.getElementById('sticker-panel-custom');
  if (panelCustom) panelCustom.classList.add('hidden');
  const capInput = document.getElementById('scrap-caption-input');
  if (capInput) capInput.value = '';
  scrapCaption = '';

  // Sembunyikan overlay stiker
  const overlay = document.getElementById('scrap-sticker-overlay');
  if (overlay) overlay.classList.add('hidden');

  document.getElementById('scrapbook-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeScrapbook() {
  document.getElementById('scrapbook-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

/* ── Pick grid ── */
function renderScrapPickGrid() {
  const grid = document.getElementById('scrap-pick-grid');
  if (!grid) return;

  if (!photos.length) {
    grid.innerHTML = '<p style="color:var(--muted);padding:16px">Belum ada foto di galeri 🌸</p>';
    return;
  }

  grid.innerHTML = photos.slice(0, 50).map((p, i) => {
    const sel = scrapSelected.some(s => s.id === p.id);
    const num = sel ? scrapSelected.findIndex(s => s.id === p.id) + 1 : '';
    return `<div class="scrap-pick-item ${sel ? 'picked' : ''}"
                 onclick="toggleScrapPhoto('${p.id}')"
                 title="${escHtml(p.caption || p.name)}">
      <img src="${p.src || p.cloudUrl || ''}" alt="" loading="lazy"/>
      ${sel ? `<div class="scrap-pick-num">${num}</div>` : ''}
    </div>`;
  }).join('');
}

function toggleScrapPhoto(id) {
  const idx = scrapSelected.findIndex(p => p.id === id);
  if (idx >= 0) {
    scrapSelected.splice(idx, 1);
  } else {
    if (scrapSelected.length >= 9) {
      toast('❌ Maksimal 9 foto untuk kolase');
      return;
    }
    const p = photos.find(ph => ph.id === id);
    if (p) scrapSelected.push(p);
  }
  renderScrapPickGrid();
  updateScrapUI();

  // Auto re-render jika sudah ada preview
  const dl = document.getElementById('scrap-dl-btn');
  if (dl && !dl.classList.contains('hidden') && scrapSelected.length >= 2) {
    renderScrapbook();
  }
}

function updateScrapUI() {
  const count = scrapSelected.length;
  const el = document.getElementById('scrap-sel-count');
  if (el) {
    const max = 9;
    el.textContent = count === 0
      ? 'Belum ada foto dipilih'
      : `${count} foto dipilih (maks ${max})`;
  }
  const btn = document.getElementById('scrap-render-btn');
  if (btn) {
    btn.disabled = count < 2;
    btn.style.opacity = count < 2 ? '0.5' : '1';
  }
}

/* ── Template selector ── */
function selectTpl(tpl, el) {
  scrapTemplate = tpl;
  scrapPhotoPositions = []; // reset posisi foto saat ganti template
  _photoDragBound = false;  // reset binding agar canvas bisa re-init
  _photoDragIdx   = -1;
  _scrapFirstRender = true;
  if (_photoDragAbort) { _photoDragAbort.abort(); _photoDragAbort = null; }
  const canvas = document.getElementById('scrap-canvas');
  if (canvas) canvas.classList.remove('drag-ready');
  document.querySelectorAll('.scrap-tpl-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  const dl = document.getElementById('scrap-dl-btn');
  if (dl && !dl.classList.contains('hidden')) renderScrapbook();
}

/* ── Sticker selector ── */
function selectSticker(emoji, el) {
  // Tambah stiker baru ke canvas (multi-stiker)
  const dlBtn = document.getElementById('scrap-dl-btn');
  const canvasReady = dlBtn && !dlBtn.classList.contains('hidden');

  // Tentukan posisi: sebar agar tidak tumpuk
  const offsetStep = 80;
  const baseX = 200 + (placedStickers.length % 5) * offsetStep;
  const baseY = 200 + Math.floor(placedStickers.length / 5) * offsetStep;

  const sk = { id: genStickerId(), value: emoji, x: baseX, y: baseY };
  placedStickers.push(sk);

  // Update UI active (highlight tombol sebentar)
  el.classList.add('active');
  setTimeout(() => el.classList.remove('active'), 500);

  if (canvasReady) {
    renderScrapbook();
  }
  renderStickerOverlays();
}

/* ══════════════════════════════════════════════════════
   MULTI-STIKER OVERLAY — setiap stiker punya elemen drag sendiri
══════════════════════════════════════════════════════ */

/* Render semua overlay stiker di atas canvas */
function renderStickerOverlays() {
  const container = document.getElementById('scrap-sticker-overlay');
  if (!container) return;

  // Hapus semua stiker lama kecuali .sticker-drag-hint
  Array.from(container.children).forEach(ch => {
    if (!ch.classList.contains('sticker-drag-hint')) ch.remove();
  });

  if (!placedStickers.length) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');

  placedStickers.forEach(sk => {
    const el = document.createElement('span');
    el.className   = 'scrap-sticker-el';
    el.dataset.sid = sk.id;
    el.style.left  = (sk.x / 1080 * 100) + '%';
    el.style.top   = (sk.y / 1080 * 100) + '%';

    if (typeof sk.value === 'object' && sk.value.type === 'custom') {
      el.innerHTML = `<img src="${sk.value.src}" alt="stiker" draggable="false"/>`;
    } else {
      el.textContent  = sk.value;
      el.style.fontSize = '52px';
    }

    // Tombol hapus per stiker di overlay
    const delBtn = document.createElement('button');
    delBtn.className   = 'sticker-placed-del';
    delBtn.textContent = '✕';
    delBtn.title       = 'Hapus stiker';
    delBtn.onclick = (e) => {
      e.stopPropagation();
      placedStickers = placedStickers.filter(s => s.id !== sk.id);
      renderStickerOverlays();
      const dl = document.getElementById('scrap-dl-btn');
      if (dl && !dl.classList.contains('hidden')) renderScrapbook();
      toast('🗑 Stiker dihapus');
    };
    el.appendChild(delBtn);

    container.appendChild(el);
    initStickerDrag(el, sk);
  });
}

/* Posisikan ulang overlay stiker (dipanggil setelah canvas resize) */
function updateStickerOverlayPos() {
  placedStickers.forEach(sk => {
    const el = document.querySelector(`.scrap-sticker-el[data-sid="${sk.id}"]`);
    if (el) {
      el.style.left = (sk.x / 1080 * 100) + '%';
      el.style.top  = (sk.y / 1080 * 100) + '%';
    }
  });
}

/* showStickerOverlay — tetap ada untuk kompatibilitas, sekarang panggil renderStickerOverlays */
function showStickerOverlay() {
  renderStickerOverlays();
}

/* ── Drag handler per elemen stiker ── */
function initStickerDrag(el, sk) {
  let isDragging = false, startMX = 0, startMY = 0, startCX = 0, startCY = 0;

  function getCanvasRect() {
    return document.getElementById('scrap-canvas').getBoundingClientRect();
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function onStart(cx, cy) {
    isDragging = true;
    startMX = cx; startMY = cy;
    startCX = sk.x; startCY = sk.y;
    el.classList.add('dragging');
    const hint = document.querySelector('.sticker-drag-hint');
    if (hint) hint.classList.add('fade');
  }
  function onMove(cx, cy) {
    if (!isDragging) return;
    const rect  = getCanvasRect();
    const scale = 1080 / rect.width;
    sk.x = clamp(startCX + (cx - startMX) * scale, 30, 1050);
    sk.y = clamp(startCY + (cy - startMY) * scale, 30, 1050);
    el.style.left = (sk.x / 1080 * 100) + '%';
    el.style.top  = (sk.y / 1080 * 100) + '%';
  }
  function onEnd() {
    if (!isDragging) return;
    isDragging = false;
    el.classList.remove('dragging');
    renderScrapbook();
  }

  el.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); onStart(e.clientX, e.clientY); });
  document.addEventListener('mousemove', e => onMove(e.clientX, e.clientY));
  document.addEventListener('mouseup', () => onEnd());

  el.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); onStart(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
  document.addEventListener('touchmove', e => { if (!isDragging) return; e.preventDefault(); onMove(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
  document.addEventListener('touchend', () => onEnd());
}

/* ── Tab switch: Emoji / Custom ── */
function switchStickerTab(tab, el) {
  document.querySelectorAll('.scrap-sticker-tab').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('sticker-panel-emoji').classList.toggle('hidden', tab !== 'emoji');
  document.getElementById('sticker-panel-custom').classList.toggle('hidden', tab !== 'custom');
}

/* ══════════════════════════════════════════════════════
   HAPUS BACKGROUND STIKER — flood-fill dari 4 sudut
   Toleransi warna bisa disesuaikan lewat BG_TOLERANCE
══════════════════════════════════════════════════════ */
const BG_TOLERANCE_DEFAULT = 40;
// Nilai toleransi diambil dari slider saat upload
function getBgTolerance() {
  const slider = document.getElementById('bg-tol-slider');
  return slider ? parseInt(slider.value) : BG_TOLERANCE_DEFAULT;
}

function colorDistance(r1, g1, b1, r2, g2, b2) {
  return Math.sqrt((r1-r2)**2 + (g1-g2)**2 + (b1-b2)**2);
}

/**
 * removeImageBg — hapus latar belakang dari ImageData.
 * Flood-fill dari 4 sudut lalu hapus piksel yang mirip warna bg.
 * @param {ImageData} imgData
 * @returns {ImageData} baru dengan bg transparan
 */
function removeImageBg(imgData) {
  const tol = getBgTolerance();
  const { data, width, height } = imgData;
  // Buat salinan supaya tidak merusak asli
  const result = new ImageData(new Uint8ClampedArray(data), width, height);
  const rd = result.data;

  // Ambil warna dari 4 sudut sebagai referensi warna background
  function pixelAt(x, y) {
    const i = (y * width + x) * 4;
    return [rd[i], rd[i+1], rd[i+2], rd[i+3]];
  }
  function setAlpha(x, y, a) {
    rd[(y * width + x) * 4 + 3] = a;
  }

  const corners = [
    [0, 0], [width-1, 0], [0, height-1], [width-1, height-1],
    [Math.floor(width/2), 0], [Math.floor(width/2), height-1],
    [0, Math.floor(height/2)], [width-1, Math.floor(height/2)],
  ];
  const visited = new Uint8Array(width * height);

  // Flood-fill BFS dari setiap sudut
  for (const [sx, sy] of corners) {
    const [tr, tg, tb] = pixelAt(sx, sy);
    const queue = [[sx, sy]];
    while (queue.length) {
      const [x, y] = queue.pop();
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const idx = y * width + x;
      if (visited[idx]) continue;
      visited[idx] = 1;
      const [r, g, b, a] = pixelAt(x, y);
      if (a < 30) { setAlpha(x, y, 0); continue; } // sudah transparan
      if (colorDistance(r, g, b, tr, tg, tb) > tol) continue;
      setAlpha(x, y, 0);
      queue.push([x+1,y],[x-1,y],[x,y+1],[x,y-1]);
    }
  }
  return result;
}

/**
 * processCustomStickerFile — load file, hapus bg, kembalikan data URL transparan
 */
function processCustomStickerFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        try {
          // Render ke offscreen canvas
          const cv  = document.createElement('canvas');
          cv.width  = img.naturalWidth  || img.width;
          cv.height = img.naturalHeight || img.height;
          const ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0);
          // Hapus background
          const imgData   = ctx.getImageData(0, 0, cv.width, cv.height);
          const processed = removeImageBg(imgData);
          ctx.putImageData(processed, 0, 0);
          resolve(cv.toDataURL('image/png'));
        } catch(err) {
          // Canvas tainted (CORS) — gunakan asli
          console.warn('[sticker bg] gagal hapus bg:', err);
          resolve(e.target.result);
        }
      };
      img.onerror = () => resolve(e.target.result);
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Gagal baca file'));
    reader.readAsDataURL(file);
  });
}

/* ── Upload stiker custom dari file ── */
async function loadCustomSticker(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';

  if (file.size > 4 * 1024 * 1024) {
    toast('❌ Gambar terlalu besar! Maks 4MB ya.');
    return;
  }

  toast('⏳ Memproses stiker...');
  try {
    const id   = 'cs_' + Date.now();
    const name = file.name.replace(/\.[^.]+$/, '').slice(0, 20);
    const src  = await processCustomStickerFile(file);

    customStickers.push({ id, src, name });
    renderCustomStickerGrid();
    selectCustomSticker(id);
    toast('✅ Stiker diupload (background dihapus otomatis)!');
  } catch(e) {
    toast('❌ Gagal memproses stiker');
    console.error(e);
  }
}

/* ── Render grid stiker custom ── */
function renderCustomStickerGrid() {
  const grid = document.getElementById('scrap-custom-grid');
  if (!grid) return;

  if (!customStickers.length) {
    grid.innerHTML = '<p class="scrap-custom-empty">Belum ada stiker custom 🌸<br><small>Upload gambar favoritmu!</small></p>';
    return;
  }

  grid.innerHTML = customStickers.map(cs => {
    const isActive = scrapSticker && typeof scrapSticker === 'object' && scrapSticker.id === cs.id;
    return `
      <div class="custom-sticker-item ${isActive ? 'active' : ''}"
           onclick="selectCustomSticker('${cs.id}')"
           title="${escHtml ? escHtml(cs.name) : cs.name}">
        <img src="${cs.src}" alt="${cs.name}" draggable="false"/>
        <button class="custom-sticker-del"
                onclick="deleteCustomSticker(event,'${cs.id}')"
                title="Hapus stiker ini">✕</button>
      </div>`;
  }).join('');
}

/* ── Pilih stiker custom ── */
function selectCustomSticker(id) {
  const cs = customStickers.find(s => s.id === id);
  if (!cs) return;

  // Tentukan posisi sebar
  const offsetStep = 80;
  const baseX = 200 + (placedStickers.length % 5) * offsetStep;
  const baseY = 200 + Math.floor(placedStickers.length / 5) * offsetStep;

  const sk = {
    id: genStickerId(),
    value: { type: 'custom', id: cs.id, src: cs.src },
    x: baseX,
    y: baseY
  };
  placedStickers.push(sk);

  // Highlight sebentar
  renderCustomStickerGrid();

  const dl = document.getElementById('scrap-dl-btn');
  if (dl && !dl.classList.contains('hidden')) {
    renderScrapbook();
  }
  renderStickerOverlays();
}

/* ── Hapus stiker custom ── */
function deleteCustomSticker(e, id) {
  e.stopPropagation();
  customStickers = customStickers.filter(s => s.id !== id);

  // Hapus semua placed stiker yang memakai custom ini
  const sebelum = placedStickers.length;
  placedStickers = placedStickers.filter(s =>
    !(typeof s.value === 'object' && s.value.type === 'custom' && s.value.id === id)
  );
  if (placedStickers.length !== sebelum) {
    renderStickerOverlays();
    const dl = document.getElementById('scrap-dl-btn');
    if (dl && !dl.classList.contains('hidden')) renderScrapbook();
  }
  renderCustomStickerGrid();
  toast('🗑 Stiker dihapus');
}
function onScrapCaptionChange(val) {
  scrapCaption = val;
  const dl = document.getElementById('scrap-dl-btn');
  if (dl && !dl.classList.contains('hidden')) renderScrapbook();
}

/* ══════════════════════════════════════════════════════
   FOTO DRAG — Drag foto langsung di canvas preview
══════════════════════════════════════════════════════ */

let _photoDragIdx   = -1;   // index foto yang sedang di-drag
let _photoDragOffX  = 0;
let _photoDragOffY  = 0;
let _photoDragBound = false; // sudah bind event ke canvas?

/* Ukuran & posisi default per template — cocok dengan fungsi draw* */
function getDefaultPhotoLayout() {
  const W = 1080, H = 1080, n = Math.min(scrapSelected.length, 9);

  if (scrapTemplate === 'washi') {
    const size = n <= 3 ? 280 : n <= 6 ? 240 : 200;
    const offs = [
      [50, 60], [W*0.55, 40], [30, H*0.46], [W*0.52, H*0.44],
      [W*0.2, H*0.7], [W*0.62, H*0.66],
      [40, H*0.78], [W*0.42, H*0.76], [W*0.7, H*0.78]
    ];
    return offs.slice(0, n).map(([ox, oy]) => ({
      x: ox, y: oy, w: size, h: size
    }));
  }

  if (scrapTemplate === 'polaroid') {
    // Dari drawPolaroidV2 — ambil posisi rata-rata
    const PW = 220, PH = 260;
    const positions = [
      [80,80],[380,60],[700,90],[120,420],[400,400],[680,430],[200,720],[500,700]
    ];
    return positions.slice(0, n).map(([ox, oy]) => ({
      x: ox, y: oy, w: PW, h: PH
    }));
  }

  if (scrapTemplate === 'mosaic') {
    const pad = 32, gap = 10;
    const area = { x: pad, y: pad, w: W - pad*2, h: H - pad*2 };
    const layouts = {
      2: [[0,0,.5,1],[.5,0,.5,1]],
      3: [[0,0,.6,1],[.6,0,.4,.5],[.6,.5,.4,.5]],
      4: [[0,0,.5,.55],[.5,0,.5,.55],[0,.55,1,.45]],
      5: [[0,0,.4,.5],[.4,0,.3,.5],[.7,0,.3,.5],[0,.5,.5,.5],[.5,.5,.5,.5]],
      6: [[0,0,.4,.4],[.4,0,.3,.4],[.7,0,.3,.4],[0,.4,.35,.6],[.35,.4,.35,.6],[.7,.4,.3,.6]],
      7: [[0,0,.33,.5],[.33,0,.34,.5],[.67,0,.33,.5],[0,.5,.5,.5],[.5,.5,.25,.5],[.75,.5,.25,.5]],
      8: [[0,0,.34,.5],[.34,0,.33,.5],[.67,0,.33,.5],[0,.5,.25,.5],[.25,.5,.25,.5],[.5,.5,.25,.5],[.75,.5,.25,.5]],
      9: [[0,0,.33,.33],[.33,0,.34,.33],[.67,0,.33,.33],[0,.33,.33,.34],[.33,.33,.34,.34],[.67,.33,.33,.34],[0,.67,.33,.33],[.33,.67,.34,.33],[.67,.67,.33,.33]]
    };
    const layout = layouts[Math.min(n,9)] || layouts[9];
    return layout.slice(0, n).map(([fx,fy,fw,fh]) => ({
      x: area.x + fx * area.w,
      y: area.y + fy * area.h,
      w: fw * area.w - gap,
      h: fh * area.h - gap
    }));
  }

  // Fallback: grid merata
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cw = W / cols, ch = H / rows;
  return Array.from({length: n}, (_, i) => ({
    x: (i % cols) * cw + 10,
    y: Math.floor(i / cols) * ch + 10,
    w: cw - 20, h: ch - 20
  }));
}

/* Init posisi foto (panggil sekali sebelum render pertama atau saat template berubah) */
function initPhotoPositions() {
  if (scrapPhotoPositions.length === scrapSelected.length) return; // sudah ada
  scrapPhotoPositions = getDefaultPhotoLayout();
}

let _scrapFirstRender = true; // flag untuk toast & hint hanya muncul pertama kali
/* Simpan AbortController untuk bisa hapus semua listener lama */
let _photoDragAbort = null;

/* Tampilkan overlay transparan di atas canvas yang menangkap drag foto */
function showPhotoDragOverlay() {
  const canvas = document.getElementById('scrap-canvas');
  const wrap   = document.getElementById('scrap-canvas-wrap');
  if (!canvas || !wrap) return;

  initPhotoPositions();

  // Hapus listener lama dulu sebelum pasang yang baru
  if (_photoDragAbort) {
    _photoDragAbort.abort();
    _photoDragAbort = null;
  }
  _photoDragAbort = new AbortController();
  const signal = _photoDragAbort.signal;

  _photoDragBound = true;
  _photoDragIdx   = -1;

  // Tandai canvas siap drag
  canvas.classList.add('drag-ready');
  const hint = document.getElementById('scrap-photo-drag-hint');
  if (hint) {
    hint.classList.remove('hidden');
    setTimeout(() => hint.classList.add('hidden'), 4000);
  }

  function clientToCanvas(clientX, clientY) {
    const rect  = canvas.getBoundingClientRect();
    const scale = 1080 / rect.width;
    return {
      x: (clientX - rect.left) * scale,
      y: (clientY - rect.top)  * scale
    };
  }

  function hitTest(cx, cy) {
    for (let i = scrapPhotoPositions.length - 1; i >= 0; i--) {
      const p = scrapPhotoPositions[i];
      if (!p) continue;
      if (cx >= p.x - 20 && cx <= p.x + p.w + 20 &&
          cy >= p.y - 20 && cy <= p.y + p.h + 20) {
        return i;
      }
    }
    return -1;
  }

  function onStart(clientX, clientY) {
    const {x, y} = clientToCanvas(clientX, clientY);
    const idx = hitTest(x, y);
    if (idx < 0) return;
    _photoDragIdx  = idx;
    _photoDragOffX = x - scrapPhotoPositions[idx].x;
    _photoDragOffY = y - scrapPhotoPositions[idx].y;
    canvas.style.cursor = 'grabbing';
  }

  function onMove(clientX, clientY) {
    if (_photoDragIdx < 0) return;
    const {x, y} = clientToCanvas(clientX, clientY);
    const p = scrapPhotoPositions[_photoDragIdx];
    p.x = Math.max(-p.w * 0.4, Math.min(1080 - p.w * 0.6, x - _photoDragOffX));
    p.y = Math.max(-p.h * 0.4, Math.min(1080 - p.h * 0.6, y - _photoDragOffY));
    renderScrapbookLive();
  }

  function onEnd() {
    if (_photoDragIdx < 0) return;
    _photoDragIdx = -1;
    canvas.style.cursor = 'grab';
    renderScrapbook();
  }

  canvas.addEventListener('mousedown',  e => { e.preventDefault(); onStart(e.clientX, e.clientY); }, { signal });
  canvas.addEventListener('mousemove',  e => { if (_photoDragIdx >= 0) { e.preventDefault(); onMove(e.clientX, e.clientY); } }, { signal });
  canvas.addEventListener('mouseup',    () => onEnd(), { signal });
  canvas.addEventListener('mouseleave', () => { if (_photoDragIdx >= 0) onEnd(); }, { signal });

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    onStart(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false, signal });
  canvas.addEventListener('touchmove', e => {
    if (_photoDragIdx < 0) return;
    e.preventDefault();
    onMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false, signal });
  canvas.addEventListener('touchend', () => onEnd(), { signal });

  canvas.style.cursor = 'grab';
}

/* Render cepat saat drag berlangsung (tanpa efek berat) */
async function renderScrapbookLive() {
  if (scrapSelected.length < 2) return;
  try {
    const imgs   = await Promise.all(scrapSelected.map(p => loadImg(p.src)));
    const canvas = document.getElementById('scrap-canvas');
    const ctx    = canvas.getContext('2d');
    const W = 1080, H = 1080;
    const rootStyle = getComputedStyle(document.documentElement);
    const rose  = rootStyle.getPropertyValue('--rose').trim() || '#e8637a';
    const isDark = document.body.classList.contains('dark-mode');

    switch (scrapTemplate) {
      case 'washi':    await drawWashiPositioned(ctx, imgs, W, H, rose, isDark); break;
      case 'polaroid': await drawPolaroidPositioned(ctx, imgs, W, H, rose, isDark); break;
      case 'mosaic':   await drawMosaicPositioned(ctx, imgs, W, H, rose, isDark); break;
      default:         await renderScrapbook(); return;
    }
  } catch(e) { /* silent */ }
}

/* ══ Washi dengan posisi custom ══ */
async function drawWashiPositioned(ctx, imgs, W, H, rose, isDark) {
  // Background sama persis dengan drawWashi
  if (isDark) {
    fillBg(ctx, W, H, [[0,'#1a1510'],[1,'#2d2518']]);
  } else {
    fillBg(ctx, W, H, [[0,'#fdf6e3'],[0.5,'#fef0d8'],[1,'#fdf6e3']]);
  }
  // Grid
  ctx.save();
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)';
  ctx.lineWidth = 0.5;
  for (let gx = 0; gx < W; gx += 36) {
    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
  }
  for (let gy = 0; gy < H; gy += 36) {
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
  }
  ctx.restore();

  const washiColors = [rose+'bb','#7ec8e3bb','#ffd580bb','#9ad4a4bb','#daa0e0bb','#ff9999bb'];
  const imgAngles   = [-4, 3, -6, 5, -3, 7, -5, 4, -2];
  const n = Math.min(imgs.length, scrapPhotoPositions.length, 9);

  imgs.slice(0, n).forEach((img, i) => {
    const pos   = scrapPhotoPositions[i];
    const size  = pos.w;
    const angle = imgAngles[i % imgAngles.length];
    const rad   = (angle * Math.PI) / 180;
    const wColor = washiColors[i % washiColors.length];
    const cx = pos.x + size / 2, cy = pos.y + size / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rad);
    ctx.shadowColor = 'rgba(0,0,0,0.2)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 8;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-size/2 - 8, -size/2 - 8, size + 16, size + 16);
    ctx.shadowColor = 'transparent';
    drawPhoto(ctx, img, -size/2, -size/2, size, size, 4);
    ctx.fillStyle = wColor;
    ctx.fillRect(-size*0.3, -size/2 - 14, size*0.6, 22);
    for (let ti = -size*0.3; ti < size*0.3; ti += 8) {
      ctx.beginPath();
      ctx.arc(ti + size/2, -size/2 - 14, 3, 0, Math.PI*2);
      ctx.fillStyle = isDark ? '#1a1510' : '#fdf6e3';
      ctx.fill();
    }
    ctx.restore();
  });

  const title = scrapCaption.trim() || '~ our moments ~';
  ctx.save();
  ctx.font = 'italic 36px "Cormorant Garamond", serif';
  ctx.fillStyle = isDark ? rose+'cc' : '#8b4a3a';
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0,0,0,0.15)'; ctx.shadowBlur = 4;
  ctx.fillText(title.slice(0, 30), W/2, 36);
  ctx.restore();
  [[W*0.1,H*0.85],[W*0.88,H*0.2],[W*0.8,H*0.82]].forEach(([x,y]) => drawSparkle(ctx,x,y,12,rose));
}

/* ══ Mosaic dengan posisi custom ══ */
async function drawMosaicPositioned(ctx, imgs, W, H, rose, isDark) {
  if (isDark) {
    fillBg(ctx, W, H, [[0,'#1a0a10'],[1,'#2d1020']]);
  } else {
    fillBg(ctx, W, H, [[0,'#fff8f4'],[0.5,'#fce8ec'],[1,'#fff0f5']]);
  }
  drawFlowerDeco(ctx, 40, 40, 18, rose);
  drawFlowerDeco(ctx, W-40, 40, 18, rose);
  drawFlowerDeco(ctx, 40, H-40, 18, rose);
  drawFlowerDeco(ctx, W-40, H-40, 18, rose);

  const n = Math.min(imgs.length, scrapPhotoPositions.length, 9);
  imgs.slice(0, n).forEach((img, i) => {
    const p = scrapPhotoPositions[i];
    if (p) drawPhoto(ctx, img, p.x, p.y, Math.max(p.w, 40), Math.max(p.h, 40), 16, true);
  });

  drawSparkle(ctx, 120, 60, 14, rose);
  drawSparkle(ctx, W-100, H-70, 10, rose);
  drawCaption(ctx, scrapCaption, W, H, rose);
}

/* ══ Polaroid dengan posisi custom ══ */
async function drawPolaroidPositioned(ctx, imgs, W, H, rose, isDark) {
  if (isDark) {
    fillBg(ctx, W, H, [[0,'#120810'],[1,'#251525']]);
  } else {
    fillBg(ctx, W, H, [[0,'#f5e6f0'],[0.5,'#fce8ec'],[1,'#f0e0f5']]);
  }
  const n = Math.min(imgs.length, scrapPhotoPositions.length, 9);
  const PW = 220, PH = 260;
  imgs.slice(0, n).forEach((img, i) => {
    const p = scrapPhotoPositions[i];
    if (!p) return;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 8;
    ctx.fillStyle = '#fff';
    ctx.fillRect(p.x, p.y, PW, PH + 32);
    ctx.shadowColor = 'transparent';
    drawPhoto(ctx, img, p.x + 10, p.y + 10, PW - 20, PH - 20, 4);
    ctx.restore();
  });
  drawCaption(ctx, scrapCaption, W, H, rose);
}

/* ══════════════════════════════════════════════════════
   RENDER UTAMA
══════════════════════════════════════════════════════ */
async function renderScrapbook() {
  if (scrapSelected.length < 2) { toast('Pilih minimal 2 foto'); return; }

  // Inisialisasi posisi foto jika belum ada
  if (scrapPhotoPositions.length !== scrapSelected.length) {
    scrapPhotoPositions = []; // reset agar getDefaultPhotoLayout() re-kalkulasi
    initPhotoPositions();
  }

  const btn = document.getElementById('scrap-render-btn');
  if (btn) { btn.textContent = '⏳ Membuat...'; btn.disabled = true; }

  // Show spinner
  const wrap = document.querySelector('.scrap-canvas-wrap');
  if (wrap) wrap.classList.add('loading');

  try {
    const imgs = await Promise.all(scrapSelected.map(p => loadImg(p.src || p.cloudUrl || '')));
    const canvas = document.getElementById('scrap-canvas');
    const ctx    = canvas.getContext('2d');
    const W = 1080, H = 1080;
    canvas.width  = W;
    canvas.height = H;

    const rootStyle = getComputedStyle(document.documentElement);
    const rose  = rootStyle.getPropertyValue('--rose').trim()  || '#e8637a';
    const isDark = document.body.classList.contains('dark-mode');

    switch (scrapTemplate) {
      case 'mosaic':    await drawMosaicPositioned(ctx, imgs, W, H, rose, isDark);   break;
      case 'polaroid':  await drawPolaroidPositioned(ctx, imgs, W, H, rose, isDark); break;
      case 'magazine':  await drawMagazine(ctx, imgs, W, H, rose, isDark);  break;
      case 'heart':     await drawHeartV2(ctx, imgs, W, H, rose, isDark);   break;
      case 'strip':     await drawStripV2(ctx, imgs, W, H, rose, isDark);   break;
      case 'washi':     await drawWashiPositioned(ctx, imgs, W, H, rose, isDark);    break;
      case 'vintage':   await drawVintage(ctx, imgs, W, H, rose, isDark);   break;
      case 'bloom':     await drawBloom(ctx, imgs, W, H, rose, isDark);     break;
    }

    // Watermark
    ctx.save();
    ctx.font = 'italic 18px "Cormorant Garamond", serif';
    ctx.fillStyle = 'rgba(232,99,122,0.45)';
    ctx.textAlign = 'right';
    ctx.fillText('Love Gallery ♥', W - 20, H - 16);
    ctx.restore();

    const dlBtn = document.getElementById('scrap-dl-btn');
    if (dlBtn) dlBtn.classList.remove('hidden');
    // Tampilkan overlay stiker draggable
    showStickerOverlay();
    // Tampilkan overlay foto draggable (selalu re-init untuk pasang listener fresh)
    showPhotoDragOverlay();
    if (_scrapFirstRender) {
      toast('✅ Kolase berhasil dibuat! Geser foto untuk mengatur posisi ✨');
      _scrapFirstRender = false;
    }
  } catch(e) {
    toast('❌ Gagal membuat kolase: ' + e.message);
    console.error(e);
  }

  if (wrap) wrap.classList.remove('loading');
  if (btn) { btn.textContent = '🎨 Buat Kolase'; btn.disabled = false; }
}

/* ══════════════════════════════════════════════════════
   HELPERS CANVAS
══════════════════════════════════════════════════════ */

// Gambar foto dengan rounded corner + object-cover
function drawPhoto(ctx, img, x, y, w, h, radius = 12, shadow = false) {
  ctx.save();
  if (shadow) {
    ctx.shadowColor   = 'rgba(0,0,0,0.22)';
    ctx.shadowBlur    = 24;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 8;
  }
  roundRect(ctx, x, y, w, h, radius);
  ctx.clip();
  ctx.shadowColor = 'transparent';

  const scale = Math.max(w / img.width, h / img.height);
  const sw    = img.width  * scale;
  const sh    = img.height * scale;
  const sx    = x + (w - sw) / 2;
  const sy    = y + (h - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Gradient background
function fillBg(ctx, W, H, colors) {
  const grd = ctx.createLinearGradient(0, 0, W, H);
  colors.forEach(([stop, color]) => grd.addColorStop(stop, color));
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);
}

// Tulis teks dengan shadow
function drawText(ctx, text, x, y, font, color, align = 'left', shadow = false) {
  ctx.save();
  ctx.font      = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  if (shadow) {
    ctx.shadowColor  = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur   = 8;
    ctx.shadowOffsetY = 3;
  }
  ctx.fillText(text, x, y);
  ctx.restore();
}

// Gambar stiker emoji besar di posisi tertentu
function drawSticker(ctx, emoji, x, y, size = 80) {
  if (!emoji) return;
  ctx.save();
  ctx.font      = `${size}px serif`;
  ctx.textAlign = 'center';
  ctx.fillText(emoji, x, y);
  ctx.restore();
}

// Gambar caption di bawah
function drawCaption(ctx, caption, W, H, color) {
  if (!caption.trim()) return;
  const text = caption.slice(0, 60);
  ctx.save();
  // Background blur strip
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(0, H - 60, W, 60);
  ctx.font      = 'italic 26px "Cormorant Garamond", serif';
  ctx.fillStyle = '#fffaf8';
  ctx.textAlign = 'center';
  ctx.shadowColor  = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur   = 10;
  ctx.fillText(`"${text}"`, W / 2, H - 22);
  ctx.restore();
}

// Bunga dekorasi kecil (titik-titik petal)
function drawFlowerDeco(ctx, cx, cy, r, color) {
  const petals = 6;
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.35;
  for (let i = 0; i < petals; i++) {
    const angle = (i / petals) * Math.PI * 2;
    const px = cx + Math.cos(angle) * r * 1.3;
    const py = cy + Math.sin(angle) * r * 1.3;
    ctx.beginPath();
    ctx.ellipse(px, py, r * 0.7, r * 0.4, angle, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffe0b2';
  ctx.globalAlpha = 0.7;
  ctx.fill();
  ctx.restore();
}

// Bintang kecil
function drawSparkle(ctx, x, y, size, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = size * 0.18;
  ctx.globalAlpha = 0.7;
  ctx.lineCap = 'round';
  [0, 90, 45, 135].forEach(deg => {
    const rad = (deg * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(rad) * size * 0.28, y + Math.sin(rad) * size * 0.28);
    ctx.lineTo(x + Math.cos(rad) * size, y + Math.sin(rad) * size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(rad + Math.PI) * size * 0.28, y + Math.sin(rad + Math.PI) * size * 0.28);
    ctx.lineTo(x + Math.cos(rad + Math.PI) * size, y + Math.sin(rad + Math.PI) * size);
    ctx.stroke();
  });
  ctx.restore();
}

/* ══════════════════════════════════════════════════════
   TEMPLATE 1 — MOSAIC (Dynamic bento-box grid)
══════════════════════════════════════════════════════ */
async function drawMosaic(ctx, imgs, W, H, rose, isDark) {
  // Background gradient cream/dark
  if (isDark) {
    fillBg(ctx, W, H, [[0,'#1a0a10'],[1,'#2d1020']]);
  } else {
    fillBg(ctx, W, H, [[0,'#fff8f4'],[0.5,'#fce8ec'],[1,'#fff0f5']]);
  }

  // Dekorasi bunga sudut
  drawFlowerDeco(ctx, 40,  40,  18, rose);
  drawFlowerDeco(ctx, W-40, 40, 18, rose);
  drawFlowerDeco(ctx, 40,  H-40, 18, rose);
  drawFlowerDeco(ctx, W-40, H-40, 18, rose);

  const n   = imgs.length;
  const pad = 32;
  const gap = 10;
  const area = { x: pad, y: pad, w: W - pad * 2, h: H - pad * 2 };

  // Bento layouts
  const layouts = {
    2: [
      [0,0,.5,1], [.5,0,.5,1]
    ],
    3: [
      [0,0,.6,1], [.6,0,.4,.5], [.6,.5,.4,.5]
    ],
    4: [
      [0,0,.5,.55], [.5,0,.5,.55],
      [0,.55,1,.45]
    ],
    5: [
      [0,0,.4,.5], [.4,0,.3,.5], [.7,0,.3,.5],
      [0,.5,.5,.5], [.5,.5,.5,.5]
    ],
    6: [
      [0,0,.4,.4], [.4,0,.3,.4], [.7,0,.3,.4],
      [0,.4,.35,.6],[.35,.4,.35,.6],[.7,.4,.3,.6]
    ],
    7: [
      [0,0,.33,.5],[.33,0,.34,.5],[.67,0,.33,.5],
      [0,.5,.5,.5],[.5,.5,.25,.5],[.75,.5,.25,.5]
    ],
    8: [
      [0,0,.34,.5],[.34,0,.33,.5],[.67,0,.33,.5],
      [0,.5,.25,.5],[.25,.5,.25,.5],[.5,.5,.25,.5],[.75,.5,.25,.5]
    ],
    9: [
      [0,0,.33,.33],[.33,0,.34,.33],[.67,0,.33,.33],
      [0,.33,.33,.34],[.33,.33,.34,.34],[.67,.33,.33,.34],
      [0,.67,.33,.33],[.33,.67,.34,.33],[.67,.67,.33,.33]
    ]
  };

  const layout = layouts[Math.min(n, 9)] || layouts[9];

  layout.forEach(([fx, fy, fw, fh], i) => {
    if (i >= imgs.length) return;
    const x = area.x + fx * area.w + (fx > 0 ? gap / 2 : 0);
    const y = area.y + fy * area.h + (fy > 0 ? gap / 2 : 0);
    const w = fw * area.w - gap * (fx > 0 && fx + fw < 1 ? 1 : fx > 0 || fx + fw < 1 ? 0.5 : 0);
    const h = fh * area.h - gap * (fy > 0 && fy + fh < 1 ? 1 : fy > 0 || fy + fh < 1 ? 0.5 : 0);
    drawPhoto(ctx, imgs[i], x, y, Math.max(w, 40), Math.max(h, 40), 16, true);
  });

  // Sparkle dekorasi
  drawSparkle(ctx, 120, 60, 14, rose);
  drawSparkle(ctx, W - 100, H - 70, 10, rose);

  drawCaption(ctx, scrapCaption, W, H, rose);
}

/* ══════════════════════════════════════════════════════
   TEMPLATE 2 — POLAROID V2 (Lebih rapi, nama bawah)
══════════════════════════════════════════════════════ */
async function drawPolaroidV2(ctx, imgs, W, H, rose, isDark) {
  if (isDark) {
    fillBg(ctx, W, H, [[0,'#1a0a10'],[1,'#2a1020']]);
  } else {
    fillBg(ctx, W, H, [[0,'#f5e8d0'],[1,'#ffe0e8']]);
  }

  // Texture dots
  ctx.save();
  ctx.globalAlpha = 0.06;
  for (let ix = 0; ix < W; ix += 22) {
    for (let iy = 0; iy < H; iy += 22) {
      ctx.beginPath();
      ctx.arc(ix, iy, 1.2, 0, Math.PI * 2);
      ctx.fillStyle = rose;
      ctx.fill();
    }
  }
  ctx.restore();

  const n     = Math.min(imgs.length, 9);
  const polW  = n <= 3 ? 280 : n <= 6 ? 240 : 200;
  const polH  = polW + 56;
  const angles = [-9, 6, -5, 11, -7, 4, -3, 8, -6];
  const cx = W / 2, cy = H / 2;

  // Posisi susun spiral
  const positions = [];
  if (n === 1) {
    positions.push([cx, cy]);
  } else if (n <= 3) {
    for (let i = 0; i < n; i++) {
      const t = n === 2 ? (i === 0 ? -0.5 : 0.5) : (i - 1) * 0.7;
      positions.push([cx + t * 280, cy + (i % 2 === 0 ? -30 : 30)]);
    }
  } else if (n <= 5) {
    const ring = [[0,-200],[180,-80],[-180,-80],[120,140],[-120,140]];
    for (let i = 0; i < n; i++) {
      const [rx, ry] = ring[i] || [0, 0];
      positions.push([cx + rx, cy + ry]);
    }
  } else {
    // grid-ish untuk banyak
    const cols = n <= 6 ? 3 : n <= 8 ? 4 : 3;
    const rows = Math.ceil(n / cols);
    const startX = cx - (cols - 1) * (polW * 0.72) / 2;
    const startY = cy - (rows - 1) * (polH * 0.55) / 2;
    for (let i = 0; i < n; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      positions.push([startX + c * (polW * 0.72), startY + r * (polH * 0.55)]);
    }
  }

  // Gambar dari belakang ke depan
  [...imgs].slice(0, n).forEach((img, i) => {
    const [px, py] = positions[i] || [cx, cy];
    const angle    = angles[i % angles.length];
    const rad      = (angle * Math.PI) / 180;
    const p        = scrapSelected[i];
    const capTx    = p ? (p.caption || p.name.replace(/\.[^.]+$/, '')).slice(0, 18) : '✨';

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(rad);

    // Bayangan
    ctx.shadowColor  = 'rgba(0,0,0,0.28)';
    ctx.shadowBlur   = 28;
    ctx.shadowOffsetY = 10;

    // Frame putih polaroid
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, -polW / 2, -polH / 2, polW, polH, 4);
    ctx.fill();
    ctx.shadowColor = 'transparent';

    // Foto
    const imgPad = 10;
    drawPhoto(ctx, img,
      -polW / 2 + imgPad,
      -polH / 2 + imgPad,
      polW - imgPad * 2,
      polW - imgPad * 2,
      4
    );

    // Garis tipis bawah foto
    ctx.strokeStyle = '#f0e0e0';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(-polW / 2 + imgPad, -polH / 2 + polW - imgPad + 4);
    ctx.lineTo(polW / 2 - imgPad, -polH / 2 + polW - imgPad + 4);
    ctx.stroke();

    // Teks
    ctx.font      = 'italic 14px "Cormorant Garamond", serif';
    ctx.fillStyle = '#a08080';
    ctx.textAlign = 'center';
    ctx.fillText(capTx, 0, polH / 2 - 14);

    ctx.restore();
  });

  // Stiker pojok

  // Dekorasi corner
  drawFlowerDeco(ctx, 50, 50, 22, rose);
  drawFlowerDeco(ctx, W - 50, H - 50, 22, rose);

  drawCaption(ctx, scrapCaption, W, H, rose);
}

/* ══════════════════════════════════════════════════════
   TEMPLATE 3 — MAGAZINE (Editorial layout)
══════════════════════════════════════════════════════ */
async function drawMagazine(ctx, imgs, W, H, rose, isDark) {
  if (isDark) {
    fillBg(ctx, W, H, [[0,'#0e0308'],[1,'#1a0a10']]);
  } else {
    ctx.fillStyle = '#f9f3ee';
    ctx.fillRect(0, 0, W, H);
  }

  const n = Math.min(imgs.length, 9);

  // Hero image (besar di atas)
  const heroH = n === 2 ? H * 0.6 : H * 0.5;
  drawPhoto(ctx, imgs[0], 0, 0, W, heroH, 0, false);

  // Overlay gradient gelap di bawah hero
  const fadeGrd = ctx.createLinearGradient(0, heroH * 0.5, 0, heroH);
  fadeGrd.addColorStop(0, 'rgba(0,0,0,0)');
  fadeGrd.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = fadeGrd;
  ctx.fillRect(0, 0, W, heroH);

  // Judul besar di atas hero
  const titleText = scrapCaption.trim() || 'Our Story';
  ctx.save();
  ctx.font = `bold ${n <= 2 ? 72 : 60}px "Cormorant Garamond", serif`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur  = 16;
  ctx.fillText(titleText.slice(0, 20), W / 2, heroH - 36);
  ctx.restore();

  // Bar merah antara hero dan grid
  ctx.fillStyle = rose;
  ctx.fillRect(0, heroH, W, 6);

  // Grid bawah untuk sisa foto
  if (n > 1) {
    const rest   = imgs.slice(1, n);
    const cols   = rest.length <= 2 ? rest.length : Math.min(rest.length, 4);
    const cellW  = W / cols;
    const cellH  = H - heroH - 6;

    rest.forEach((img, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const ch  = row === 0 ? (rest.length > cols ? cellH * 0.55 : cellH) : cellH * 0.45;
      const cy2 = heroH + 6 + (row > 0 ? cellH * 0.55 : 0);
      drawPhoto(ctx, img, col * cellW + 2, cy2 + 2, cellW - 4, ch - 4, 0, false);

      // Label caption
      const p   = scrapSelected[i + 1];
      const cap = p ? (p.caption || '').slice(0, 14) : '';
      if (cap) {
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(col * cellW + 2, cy2 + ch - 30, cellW - 4, 28);
        ctx.font      = '13px "DM Sans", sans-serif';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(cap, col * cellW + cellW / 2, cy2 + ch - 11);
        ctx.restore();
      }
    });
  }

}

/* ══════════════════════════════════════════════════════
   TEMPLATE 4 — HEART V2 (Hati lebih penuh)
══════════════════════════════════════════════════════ */
async function drawHeartV2(ctx, imgs, W, H, rose, isDark) {
  if (isDark) {
    fillBg(ctx, W, H, [[0,'#200610'],[1,'#1a0a10']]);
  } else {
    fillBg(ctx, W, H, [[0,'#fff0f3'],[1,'#fce8ec']]);
  }

  // Background heart outline besar
  ctx.save();
  ctx.beginPath();
  drawHeartPath(ctx, W/2, H/2 - 40, 400);
  const hGrd = ctx.createRadialGradient(W/2, H/2, 80, W/2, H/2, 420);
  hGrd.addColorStop(0, rose + '20');
  hGrd.addColorStop(1, rose + '08');
  ctx.fillStyle = hGrd;
  ctx.fill();
  ctx.strokeStyle = rose + '40';
  ctx.lineWidth   = 2.5;
  ctx.stroke();
  ctx.restore();

  const heartSlots = [
    [0.50, 0.22],
    [0.28, 0.32], [0.72, 0.32],
    [0.15, 0.46], [0.50, 0.42], [0.85, 0.46],
    [0.27, 0.60], [0.73, 0.60],
    [0.50, 0.74],
  ];

  const n    = Math.min(imgs.length, heartSlots.length);
  const size = n <= 3 ? 240 : n <= 5 ? 200 : 170;

  imgs.slice(0, n).forEach((img, i) => {
    const [fx, fy] = heartSlots[i];
    drawPhoto(ctx, img,
      fx * W - size / 2,
      fy * H - size / 2,
      size, size, 50 /* full circle */, true
    );

    // Ring merah tipis
    ctx.save();
    ctx.strokeStyle = rose;
    ctx.lineWidth   = 3;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.arc(fx * W, fy * H, size / 2 + 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  });

  // Bintang-bintang kecil
  [[100,80],[W-120,100],[80,H-100],[W-80,H-120],[W/2,50]].forEach(([x,y]) => {
    drawSparkle(ctx, x, y, 16, rose);
  });



  drawCaption(ctx, scrapCaption, W, H, rose);
}

function drawHeartPath(ctx, cx, cy, r) {
  ctx.moveTo(cx, cy + r * 0.3);
  ctx.bezierCurveTo(cx, cy - r * 0.3, cx - r, cy - r * 0.3, cx - r, cy + r * 0.3);
  ctx.bezierCurveTo(cx - r, cy + r * 0.9, cx, cy + r * 1.4, cx, cy + r * 1.6);
  ctx.bezierCurveTo(cx, cy + r * 1.4, cx + r, cy + r * 0.9, cx + r, cy + r * 0.3);
  ctx.bezierCurveTo(cx + r, cy - r * 0.3, cx, cy - r * 0.3, cx, cy + r * 0.3);
}

/* ══════════════════════════════════════════════════════
   TEMPLATE 5 — FILM STRIP V2 (Horizontal + lebih mewah)
══════════════════════════════════════════════════════ */
async function drawStripV2(ctx, imgs, W, H, rose, isDark) {
  // Background hitam film
  ctx.fillStyle = '#0d0007';
  ctx.fillRect(0, 0, W, H);

  // Noise texture
  ctx.save();
  ctx.globalAlpha = 0.04;
  for (let i = 0; i < 6000; i++) {
    const px = Math.random() * W;
    const py = Math.random() * H;
    ctx.fillStyle = Math.random() > 0.5 ? '#fff' : '#000';
    ctx.fillRect(px, py, 1.2, 1.2);
  }
  ctx.restore();

  const n = Math.min(imgs.length, 9);

  // Sprocket holes kiri & kanan
  const holeR  = 12;
  const holeCt = Math.ceil(H / 38);
  [18, W - 18].forEach(hx => {
    for (let i = 0; i < holeCt; i++) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(hx, 20 + i * 38, holeR, 0, Math.PI * 2);
      ctx.fillStyle = '#1a0010';
      ctx.fill();
      ctx.strokeStyle = '#3d1030';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }
  });

  // Garis emas tipis kiri-kanan
  [40, W - 40].forEach(lx => {
    ctx.save();
    ctx.strokeStyle = rose + '66';
    ctx.lineWidth   = 1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(lx, 0);
    ctx.lineTo(lx, H);
    ctx.stroke();
    ctx.restore();
  });

  // Foto berjejer vertikal
  const fPad = 44;
  const fW   = W - fPad * 2;
  const fH   = (H - 48 - (n - 1) * 12) / n;

  imgs.slice(0, n).forEach((img, i) => {
    const fy = 24 + i * (fH + 12);
    drawPhoto(ctx, img, fPad, fy, fW, fH, 6, false);

    // Caption rose di kanan bawah tiap frame
    const p   = scrapSelected[i];
    const cap = p ? (p.caption || p.name.replace(/\.[^.]+$/, '')).slice(0, 28) : '';
    if (cap) {
      ctx.save();
      ctx.font      = `italic 14px "Cormorant Garamond", serif`;
      ctx.fillStyle = rose + 'cc';
      ctx.textAlign = 'right';
      ctx.fillText(cap, fPad + fW - 8, fy + fH - 8);
      ctx.restore();
    }

    // Frame number
    ctx.save();
    ctx.font      = '11px "DM Sans", monospace';
    ctx.fillStyle = rose + '88';
    ctx.textAlign = 'left';
    ctx.fillText(`${String(i + 1).padStart(2, '0')}`, fPad + 6, fy + 16);
    ctx.restore();
  });

  drawCaption(ctx, scrapCaption || '', W, H, rose);
}

/* ══════════════════════════════════════════════════════
   TEMPLATE 6 — WASHI TAPE (Journal aesthetic)
══════════════════════════════════════════════════════ */
async function drawWashi(ctx, imgs, W, H, rose, isDark) {
  if (isDark) {
    ctx.fillStyle = '#1a1510';
    ctx.fillRect(0, 0, W, H);
  } else {
    // Kertas aged
    fillBg(ctx, W, H, [[0,'#fdf6e3'],[1,'#f5ead0']]);

    // Grid lines samar
    ctx.save();
    ctx.strokeStyle = 'rgba(100,60,40,0.08)';
    ctx.lineWidth   = 1;
    for (let gx = 0; gx < W; gx += 36) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
    }
    for (let gy = 0; gy < H; gy += 36) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
    }
    ctx.restore();
  }

  // Warna-warna washi tape
  const washiColors = [
    rose + 'bb',
    '#7ec8e3bb',
    '#ffd580bb',
    '#9ad4a4bb',
    '#daa0e0bb',
    '#ff9999bb',
  ];

  const n    = Math.min(imgs.length, 9);
  const size = n <= 3 ? 280 : n <= 6 ? 240 : 200;

  // Posisi acak tapi teratur
  const offsets = [
    [50, 60], [W*0.55, 40], [30, H*0.46], [W*0.52, H*0.44],
    [W*0.2, H*0.7], [W*0.62, H*0.66],
    [40, H*0.78], [W*0.42, H*0.76], [W*0.7, H*0.78]
  ];
  const imgAngles = [-4, 3, -6, 5, -3, 7, -5, 4, -2];

  imgs.slice(0, n).forEach((img, i) => {
    const [ox, oy] = offsets[i] || [W/2, H/2];
    const angle    = imgAngles[i % imgAngles.length];
    const rad      = (angle * Math.PI) / 180;
    const wColor   = washiColors[i % washiColors.length];

    ctx.save();
    ctx.translate(ox + size / 2, oy + size / 2);
    ctx.rotate(rad);

    // Bayangan kertas
    ctx.shadowColor  = 'rgba(0,0,0,0.2)';
    ctx.shadowBlur   = 20;
    ctx.shadowOffsetY = 8;

    // White paper border (bukan polaroid, tapi kertas)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-size / 2 - 8, -size / 2 - 8, size + 16, size + 16);
    ctx.shadowColor = 'transparent';

    drawPhoto(ctx, img, -size / 2, -size / 2, size, size, 4);

    // Washi tape strip di atas
    ctx.fillStyle = wColor;
    ctx.fillRect(-size * 0.3, -size / 2 - 14, size * 0.6, 22);
    // Tepi tape bergerigi
    for (let ti = -size * 0.3; ti < size * 0.3; ti += 8) {
      ctx.beginPath();
      ctx.arc(ti + size / 2, -size / 2 - 14, 3, 0, Math.PI * 2);
      ctx.fillStyle = isDark ? '#1a1510' : '#fdf6e3';
      ctx.fill();
    }

    ctx.restore();
  });

  // Judul / quote di tengah atas
  const title = scrapCaption.trim() || '~ our moments ~';
  ctx.save();
  ctx.font      = `italic 36px "Cormorant Garamond", serif`;
  ctx.fillStyle = isDark ? rose + 'cc' : '#8b4a3a';
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0,0,0,0.15)';
  ctx.shadowBlur  = 4;
  ctx.fillText(title.slice(0, 30), W / 2, 36);
  ctx.restore();

  // Dekorasi bintang
  [[W * 0.1, H * 0.85], [W * 0.88, H * 0.2], [W * 0.8, H * 0.82]].forEach(([x, y]) => {
    drawSparkle(ctx, x, y, 12, rose);
  });

}

/* ══════════════════════════════════════════════════════
   TEMPLATE 7 — VINTAGE (Sepia + tilt + frame ukiran)
══════════════════════════════════════════════════════ */
async function drawVintage(ctx, imgs, W, H, rose, isDark) {
  // Latar kertas tua
  fillBg(ctx, W, H, [[0,'#e8d5b0'],[0.5,'#dfc89a'],[1,'#c9aa7a']]);

  // Noise bintik-bintik
  ctx.save();
  ctx.globalAlpha = 0.12;
  for (let i = 0; i < 8000; i++) {
    const px = Math.random() * W;
    const py = Math.random() * H;
    const gr = Math.random() * 60 + 40;
    ctx.fillStyle = `rgb(${gr},${gr - 10},${gr - 20})`;
    ctx.fillRect(px, py, 1, 1);
  }
  ctx.restore();

  // Border ukiran ganda
  const bw = 22;
  ctx.save();
  ctx.strokeStyle = '#8B5E3C';
  ctx.lineWidth   = 3.5;
  ctx.strokeRect(bw, bw, W - bw * 2, H - bw * 2);
  ctx.lineWidth   = 1.2;
  ctx.setLineDash([8, 4]);
  ctx.strokeRect(bw + 10, bw + 10, W - (bw + 10) * 2, H - (bw + 10) * 2);
  ctx.restore();

  // Corner ornamen
  [[bw, bw],[W-bw, bw],[bw, H-bw],[W-bw, H-bw]].forEach(([cx2, cy2]) => {
    ctx.save();
    ctx.font      = '28px serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8B5E3C';
    ctx.globalAlpha = 0.7;
    ctx.fillText('✦', cx2, cy2 + 9);
    ctx.restore();
  });

  const n     = Math.min(imgs.length, 9);
  const size  = n <= 2 ? 340 : n <= 4 ? 280 : n <= 6 ? 240 : 200;
  const angles = [-5, 4, -7, 6, -3, 8, -4, 5, -6];

  const cols  = n <= 2 ? n : n <= 4 ? 2 : n <= 6 ? 3 : 3;
  const rows  = Math.ceil(n / cols);
  const totalW = cols * size + (cols - 1) * 20;
  const totalH = rows * size + (rows - 1) * 20;
  const sx     = (W - totalW) / 2;
  const sy     = (H - totalH) / 2;

  imgs.slice(0, n).forEach((img, i) => {
    const col  = i % cols;
    const row  = Math.floor(i / cols);
    const ix   = sx + col * (size + 20) + size / 2;
    const iy   = sy + row * (size + 20) + size / 2;
    const angle = angles[i % angles.length];
    const rad   = (angle * Math.PI) / 180;

    ctx.save();
    ctx.translate(ix, iy);
    ctx.rotate(rad);

    // Bayangan
    ctx.shadowColor  = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur   = 20;
    ctx.shadowOffsetY = 8;

    // White border foto
    ctx.fillStyle = '#f0e8d0';
    ctx.fillRect(-size / 2 - 6, -size / 2 - 6, size + 12, size + 12);
    ctx.shadowColor = 'transparent';

    // Foto dengan sepia filter manual
    drawPhoto(ctx, img, -size/2, -size/2, size, size, 4);

    // Sepia overlay
    ctx.globalAlpha  = 0.25;
    ctx.fillStyle    = '#8B5E3C';
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillRect(-size/2, -size/2, size, size);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    ctx.restore();
  });

  // Judul / caption vintage
  const vtitle = scrapCaption.trim() || 'Kenangan Indah';
  ctx.save();
  ctx.font      = `italic bold 44px "Cormorant Garamond", serif`;
  ctx.fillStyle = '#4a2c0a';
  ctx.textAlign = 'center';
  ctx.globalAlpha = 0.85;
  ctx.fillText(vtitle.slice(0, 24), W/2, H - bw - 20);
  ctx.restore();

}

/* ══════════════════════════════════════════════════════
   TEMPLATE 8 — BLOOM (Bunga & circle collage)
══════════════════════════════════════════════════════ */
async function drawBloom(ctx, imgs, W, H, rose, isDark) {
  if (isDark) {
    fillBg(ctx, W, H, [[0,'#100818'],[1,'#1e0a1e']]);
  } else {
    fillBg(ctx, W, H, [[0,'#fef0f8'],[0.5,'#f5d6f0'],[1,'#e8c8f0']]);
  }

  // Lingkaran besar latar
  ctx.save();
  ctx.globalAlpha = 0.06;
  const bgR = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, W*0.7);
  bgR.addColorStop(0, rose);
  bgR.addColorStop(1, 'transparent');
  ctx.fillStyle = bgR;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  const n = Math.min(imgs.length, 9);

  // Foto lingkaran — satu di tengah, sisanya melingkar
  const centerSize = n === 1 ? 560 : 360;
  const ringSize   = n <= 3 ? 260 : n <= 6 ? 220 : 190;
  const ringRadius = n <= 4 ? 310 : 330;

  // Foto tengah
  ctx.save();
  ctx.beginPath();
  ctx.arc(W/2, H/2, centerSize / 2, 0, Math.PI * 2);
  ctx.shadowColor  = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur   = 30;
  ctx.shadowOffsetY = 10;
  ctx.clip();
  ctx.shadowColor = 'transparent';
  const s0 = Math.max(centerSize / imgs[0].width, centerSize / imgs[0].height);
  ctx.drawImage(imgs[0], W/2 - imgs[0].width*s0/2, H/2 - imgs[0].height*s0/2,
                         imgs[0].width*s0, imgs[0].height*s0);
  ctx.restore();

  // Ring tengah
  ctx.save();
  ctx.strokeStyle = rose;
  ctx.lineWidth   = 4;
  ctx.shadowColor = rose + '80';
  ctx.shadowBlur  = 12;
  ctx.beginPath();
  ctx.arc(W/2, H/2, centerSize/2 + 4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Foto melingkar
  const ringImgs = imgs.slice(1, n);
  ringImgs.forEach((img, i) => {
    const angle = (i / Math.max(ringImgs.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const cx2   = W/2 + Math.cos(angle) * ringRadius;
    const cy2   = H/2 + Math.sin(angle) * ringRadius;
    const rs    = ringSize;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx2, cy2, rs / 2, 0, Math.PI * 2);
    ctx.shadowColor  = 'rgba(0,0,0,0.2)';
    ctx.shadowBlur   = 18;
    ctx.shadowOffsetY = 6;
    ctx.clip();
    ctx.shadowColor = 'transparent';
    const si = Math.max(rs / img.width, rs / img.height);
    ctx.drawImage(img, cx2 - img.width*si/2, cy2 - img.height*si/2,
                       img.width*si, img.height*si);
    ctx.restore();

    // Ring kecil
    ctx.save();
    ctx.strokeStyle = rose + 'aa';
    ctx.lineWidth   = 2.5;
    ctx.beginPath();
    ctx.arc(cx2, cy2, rs/2 + 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Garis tipis ke tengah
    ctx.save();
    ctx.strokeStyle = rose + '30';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.moveTo(W/2 + Math.cos(angle) * (centerSize/2 + 4), H/2 + Math.sin(angle) * (centerSize/2 + 4));
    ctx.lineTo(cx2 - Math.cos(angle) * (rs/2 + 3), cy2 - Math.sin(angle) * (rs/2 + 3));
    ctx.stroke();
    ctx.restore();
  });

  // Bunga dekorasi
  drawFlowerDeco(ctx, 50, 50, 24, rose);
  drawFlowerDeco(ctx, W-50, H-50, 24, rose);
  drawSparkle(ctx, W-80, 80, 18, rose);
  drawSparkle(ctx, 80, H-80, 14, rose);


  drawCaption(ctx, scrapCaption, W, H, rose);
}

/* ── Download ── */
async function downloadScrapbook() {
  const canvas = document.getElementById('scrap-canvas');
  const ctx    = canvas.getContext('2d');

  // Gambar semua stiker ke canvas sebelum download
  for (const sk of placedStickers) {
    if (typeof sk.value === 'object' && sk.value.type === 'custom') {
      try {
        const img  = await loadImg(sk.value.src);
        const size = 120;
        ctx.save();
        ctx.drawImage(img, sk.x - size / 2, sk.y - size / 2, size, size);
        ctx.restore();
      } catch(e) { /* skip jika gagal load */ }
    } else {
      drawSticker(ctx, sk.value, sk.x, sk.y, 80);
    }
  }

  const link   = document.createElement('a');
  link.download = `lovegallery-kolase-${Date.now()}.png`;
  link.href     = canvas.toDataURL('image/png');
  link.click();
  toast('📥 Kolase berhasil diunduh!');

  // Re-render bersih setelah download
  if (placedStickers.length) setTimeout(() => renderScrapbook(), 300);
}
/* ══════════════════════════════════════════════════════
   CLOUD SYNC — Supabase Integration
══════════════════════════════════════════════════════ */

async function initCloudSync() {
  try {
    await sbEnsureAuth();
    cloudSyncEnabled = true;

    // Cek apakah foto lokal punya src base64 atau tidak
    const missingLocalSrc = photos.some(p => !p.src && p.cloudUrl);
    const needsCloudRestore = photos.length === 0 || missingLocalSrc;

    if (needsCloudRestore) {
      const cloudPhotos = await sbLoadPhotos();
      if (cloudPhotos && cloudPhotos.length > 0) {
        console.log('[Cloud] Restore foto:', cloudPhotos.length);
        // Merge: pertahankan src lokal jika ada, pakai cloudUrl dari cloud
        if (photos.length > 0 && missingLocalSrc) {
          cloudPhotos.forEach(cp => {
            const local = photos.find(p => String(p.id) === String(cp.id));
            if (local) {
              local.cloudUrl = cp.cloudUrl || local.cloudUrl;
            } else {
              photos.push(cp);
            }
          });
        } else {
          photos = cloudPhotos;
        }
        await dbSavePhotos(photos);

        try {
          const cf = await sbLoadFolders();
          if (cf) { folderPhotos = cf; await dbSaveFolders(folderPhotos); }
        } catch(e2) {}

        try {
          const ct = await sbLoadTags();
          if (ct?.length) { allTags = ct; await dbSaveTags(allTags); }
        } catch(e2) {}

        try {
          const cs = await sbLoadSettings();
          if (cs) {
            const localPin = settings.pin;
            settings = Object.assign({}, DEFAULT_SETTINGS, cs, { pin: localPin });
            await dbSaveConfig('settings', settings);
            applyTheme(settings.theme, settings.themeLight);
            applySettingsToUI();
          }
        } catch(e2) {}

        // ── Restore musik dari cloud (background, non-blocking) ──
        try {
          const cm = await sbLoadMusicMeta();
          if (cm?.length) {
            const existingIds = new Set(musicTracks.map(t => String(t.id)));
            const toRestore = cm.filter(t => t.cloudUrl && !existingIds.has(String(t.id)));
            if (toRestore.length) {
              console.log('[Cloud] Restore musik:', toRestore.length, 'lagu');
              (async () => {
                let restored = 0;
                for (const t of toRestore) {
                  try {
                    const res  = await fetch(t.cloudUrl);
                    const blob = await res.blob();
                    const url  = URL.createObjectURL(blob);
                    await dbSaveMusic({ id: t.id, name: t.name, blob, duration: t.duration, type: blob.type }).catch(() => {});
                    musicTracks.push({ id: t.id, name: t.name, url, duration: t.duration });
                    restored++;
                    renderMiniPlaylist();
                    updateMusicCount();
                  } catch(e3) {
                    console.warn('[Cloud] Gagal restore lagu:', t.name, e3.message);
                  }
                }
                if (restored) toast(`🎵 ${restored} lagu berhasil dipulihkan dari cloud!`);
              })();
            }
          }
        } catch(e2) { console.warn('[Cloud] Restore musik gagal:', e2); }

        // ── Fetch cloudUrl ke src lokal agar foto tampil di grid ──
        // Jalankan di background, render dulu pakai cloudUrl
        render();
        updateStats();
        updateFolderCounts();
        if (photos.length === 0) toast('☁️ Data berhasil dipulihkan dari cloud!');

        // Background fetch: konversi cloudUrl ke base64 src lokal
        _fetchCloudSrcs();
      }
    }

    showCloudBadge('✅ Cloud aktif');
    console.log('[Supabase] Cloud sync aktif ✅');
  } catch(e) {
    console.warn('[Cloud] Tidak tersambung:', e.message);
    showCloudBadge('📴 Offline');
  }
}

function showCloudBadge(text) {
  let badge = document.getElementById('cloud-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'cloud-badge';
    badge.style.cssText = `
      font-size:11px;padding:3px 8px;border-radius:20px;
      background:var(--rose-pale);color:var(--rose);
      border:1px solid var(--border);cursor:default;
      display:flex;align-items:center;gap:4px;white-space:nowrap;
    `;
    const offlineBadge = document.getElementById('offline-badge');
    if (offlineBadge?.parentNode) offlineBadge.parentNode.insertBefore(badge, offlineBadge.nextSibling);
  }
  badge.textContent = text;
}

/* ── Fetch cloudUrl → base64 src lokal (background, non-blocking) ── */
async function _fetchCloudSrcs() {
  const needFetch = photos.filter(p => !p.src && p.cloudUrl);
  if (!needFetch.length) return;
  console.log(`[Cloud] Fetching ${needFetch.length} foto dari cloud ke lokal...`);
  showCloudBadge(`☁️ Memuat ${needFetch.length} foto...`);
  let done = 0;
  for (const p of needFetch) {
    try {
      const res  = await fetch(p.cloudUrl);
      const blob = await res.blob();
      const b64  = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
      p.src = b64;
      // Simpan ke IndexedDB secara berkala
      done++;
      if (done % 5 === 0 || done === needFetch.length) {
        await dbSavePhotos(photos).catch(() => {});
        render(); // refresh grid dengan foto yang sudah ada srcnya
      }
    } catch(e) {
      console.warn('[Cloud] Gagal fetch foto:', p.id, e.message);
    }
  }
  await dbSavePhotos(photos).catch(() => {});
  render();
  showCloudBadge('✅ Cloud aktif');
  toast(`✅ ${done} foto berhasil dimuat dari cloud!`);
  console.log('[Cloud] Fetch selesai ✅');
}

async function cloudSync() {
  if (!cloudSyncEnabled) return;
  try {
    showCloudBadge('☁️ Menyimpan...');
    await sbFullSync({ photos, settings, tags: allTags, folderPhotos, music: musicTracks });
    showCloudBadge('✅ Tersimpan');
    setTimeout(() => showCloudBadge('☁️ Cloud aktif'), 3000);
  } catch(e) {
    console.warn('[Cloud] Sync gagal:', e.message);
    showCloudBadge('⚠️ Gagal sync');
  }
}

async function manualCloudSync() {
  if (!cloudSyncEnabled) {
    toast('⚠️ Cloud belum aktif. Tunggu sebentar atau refresh halaman.');
    return;
  }
  const info = document.getElementById('cloud-sync-info');
  if (info) info.textContent = `⏳ Mengupload ${photos.length} foto & ${musicTracks.length} lagu...`;
  try {
    showCloudBadge('☁️ Mengupload...');
    await sbFullSync({ photos, settings, tags: allTags, folderPhotos, music: musicTracks });
    toast(`✅ ${photos.length} foto & ${musicTracks.length} lagu berhasil di-upload ke cloud!`);
    if (info) info.textContent = `Terakhir sync: ${new Date().toLocaleTimeString('id')}`;
    showCloudBadge('✅ Tersimpan');
    setTimeout(() => showCloudBadge('☁️ Cloud aktif'), 3000);
  } catch(e) {
    toast('❌ Sync gagal: ' + e.message);
    console.error('[Cloud] Sync error:', e);
    if (info) info.textContent = 'Gagal — cek console untuk detail.';
    showCloudBadge('⚠️ Gagal sync');
  }
}

async function manualCloudRestore() {
  if (!cloudSyncEnabled) {
    toast('⚠️ Cloud belum aktif. Tunggu sebentar atau refresh halaman.');
    return;
  }
  if (!confirm('Download semua data dari cloud? Data lokal akan ditimpa.')) return;
  try {
    showCloudBadge('☁️ Mendownload...');
    toast('⏳ Mengambil data dari cloud...');
    const data = await sbFullRestore();
    if (data.photos?.length)  {
      photos = data.photos;
      await dbSavePhotos(photos);
    }
    if (data.settings) {
      const localPin = settings.pin;
      settings = Object.assign({}, DEFAULT_SETTINGS, data.settings, { pin: localPin });
      await dbSaveConfig('settings', settings);
      applyTheme(settings.theme, settings.themeLight);
      applySettingsToUI();
    }
    if (data.tags?.length)    { allTags = data.tags; await dbSaveTags(allTags); }
    if (data.folderPhotos)    { folderPhotos = data.folderPhotos; await dbSaveFolders(folderPhotos); }
    // Restore musik dari cloud
    if (data.music?.length) {
      // Hanya restore metadata (nama, id, durasi) — blob/url diisi ulang dari cloudUrl jika ada
      const restored = [];
      for (const t of data.music) {
        if (!t.cloudUrl) continue;
        try {
          const res  = await fetch(t.cloudUrl);
          const blob = await res.blob();
          const url  = URL.createObjectURL(blob);
          await dbSaveMusic({ id: t.id, name: t.name, blob, duration: t.duration, type: blob.type }).catch(() => {});
          restored.push({ id: t.id, name: t.name, url, duration: t.duration });
        } catch(e) {
          console.warn('[Cloud] Gagal restore lagu:', t.name, e.message);
        }
      }
      if (restored.length) {
        musicTracks = restored;
        renderMiniPlaylist();
        updateMusicCount();
        toast(`🎵 ${restored.length} lagu berhasil dipulihkan dari cloud!`);
      }
    }
    render();
    updateStats();
    updateFolderCounts();
    showCloudBadge('✅ Cloud aktif');
    toast(`☁️ Restore berhasil! ${photos.length} foto dimuat.`);
  } catch(e) {
    toast('❌ Restore gagal: ' + e.message);
    console.error('[Cloud] Restore error:', e); 
    showCloudBadge('⚠️ Gagal');
  }
}