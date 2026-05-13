/* ═══════════════════════════════════════════════════
   LOVE GALLERY — supabase.js
   Cloud sync via Supabase Storage + Auth
   Bucket: lovegallery (sudah dibuat di dashboard)
═══════════════════════════════════════════════════ */

const SUPABASE_URL = 'https://kwafswyrxejfckpdpgbq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_RMHNH8bsvwnt7MeV1x9Vmg_5Wch6RhM';
const BUCKET       = 'love-gallery';   // nama bucket kamu di Supabase Storage

/* ── Init Supabase client (via CDN UMD) ───────────── */
// Pastikan index.html sudah load script CDN sebelum file ini:
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ═══════════════════════════════════════════════════
   AUTH — Anonymous / Email OTP
   Galeri ini pakai anonymous auth agar tidak perlu
   daftar email. Session tersimpan di localStorage.
═══════════════════════════════════════════════════ */

let _currentUser = null;

/**
 * Pastikan user sudah punya session.
 * Pakai Anonymous Sign-In — user otomatis dapat user_id unik.
 */
async function sbEnsureAuth() {
  if (_currentUser) return _currentUser;

  // Cek session yang sudah ada
  const { data: { session } } = await _supabase.auth.getSession();
  if (session?.user) {
    _currentUser = session.user;
    return _currentUser;
  }

  // Buat anonymous session baru
  const { data, error } = await _supabase.auth.signInAnonymously();
  if (error) throw new Error('Auth gagal: ' + error.message);
  _currentUser = data.user;
  return _currentUser;
}

/**
 * Ambil user_id (dipakai sebagai prefix path di storage).
 * Path format: {user_id}/photos/{filename}
 */
async function sbUserId() {
  const user = await sbEnsureAuth();
  return user.id;
}

/* ═══════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════ */

/** Base64 data URL → Blob */
function dataUrlToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime  = header.match(/:(.*?);/)[1];
  const bin   = atob(b64);
  const arr   = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/** Ekstensi dari mime type */
function mimeToExt(mime) {
  const map = { 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif' };
  return map[mime] || 'jpg';
}

/** Buat nama file unik */
function uniqueFilename(prefix = 'photo') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
}

/* ═══════════════════════════════════════════════════
   STORAGE — FOTO
   Upload satu foto (base64 data URL) ke Supabase Storage.
   Return: public URL foto.
═══════════════════════════════════════════════════ */

/**
 * Upload foto ke Supabase Storage.
 * @param {string} dataUrl  - base64 data URL (dari canvas / FileReader)
 * @param {string} filename - (opsional) nama file tanpa ekstensi
 * @returns {Promise<string>} public URL
 */
async function sbUploadPhoto(dataUrl, filename = null) {
  const uid  = await sbUserId();
  const blob = dataUrlToBlob(dataUrl);
  const ext  = mimeToExt(blob.type);
  const name = filename || uniqueFilename('photo');
  const path = `${uid}/photos/${name}.${ext}`;

  const { error } = await _supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: blob.type, upsert: true });

  if (error) throw new Error('Upload foto gagal: ' + error.message);

  // Ambil public URL
  const { data } = _supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Hapus foto dari Supabase Storage berdasarkan public URL atau path.
 * @param {string} urlOrPath - public URL atau path relatif di bucket
 */
async function sbDeletePhoto(urlOrPath) {
  const uid  = await sbUserId();
  let   path = urlOrPath;

  // Jika diberikan full URL, ekstrak path-nya
  if (urlOrPath.startsWith('http')) {
    const marker = `/object/public/${BUCKET}/`;
    const idx    = urlOrPath.indexOf(marker);
    if (idx !== -1) path = urlOrPath.slice(idx + marker.length);
  }

  const { error } = await _supabase.storage.from(BUCKET).remove([path]);
  if (error) console.warn('Delete foto gagal:', error.message);
}

/* ═══════════════════════════════════════════════════
   STORAGE — METADATA (JSON)
   Metadata (foto list, settings, tags) disimpan
   sebagai JSON file di Storage bucket.
   Path: {user_id}/meta/{filename}.json
═══════════════════════════════════════════════════ */

async function sbSaveMeta(name, data) {
  const uid  = await sbUserId();
  const path = `${uid}/meta/${name}.json`;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });

  const { error } = await _supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: 'application/json', upsert: true });

  if (error) throw new Error(`Simpan meta "${name}" gagal: ` + error.message);
}

async function sbLoadMeta(name) {
  const uid  = await sbUserId();
  const path = `${uid}/meta/${name}.json`;

  const { data, error } = await _supabase.storage.from(BUCKET).download(path);
  if (error) {
    // File belum ada — kembalikan null
    if (error.message?.includes('not found') || error.statusCode === 404) return null;
    throw new Error(`Load meta "${name}" gagal: ` + error.message);
  }
  const text = await data.text();
  return JSON.parse(text);
}

/* ═══════════════════════════════════════════════════
   HIGH-LEVEL API — Foto
═══════════════════════════════════════════════════ */

/**
 * Simpan semua foto ke cloud.
 * Foto yang sudah punya cloudUrl di-skip upload-nya.
 * @param {Array} photosArr - array foto dari state lokal
 * @param {Function} onProgress - (current, total) callback opsional
 */
async function sbSyncPhotos(photosArr, onProgress = null) {
  await sbEnsureAuth();
  const result = [];

  for (let i = 0; i < photosArr.length; i++) {
    const p = { ...photosArr[i] };

    // Jika sudah ada cloudUrl, skip upload binary
    if (!p.cloudUrl && p.src && p.src.startsWith('data:')) {
      try {
        p.cloudUrl = await sbUploadPhoto(p.src, p.id);
        console.log(`[Supabase] Upload foto ${i+1}/${photosArr.length}: OK`);
      } catch(e) {
        console.warn(`[Supabase] Upload foto ${p.id} gagal:`, e.message);
      }
    }

    // Simpan tanpa base64 src (hemat bandwidth)
    const { src: _omitSrc, ...meta } = p;
    result.push({ ...meta, hasSrc: !!p.src });
    if (onProgress) onProgress(i + 1, photosArr.length);
  }

  // Simpan metadata (tanpa base64)
  await sbSaveMeta('photos', result);
  return result;
}

/**
 * Load daftar foto dari cloud.
 * cloudUrl diisi dari Supabase; src kosong (load on-demand).
 */
async function sbLoadPhotos() {
  const meta = await sbLoadMeta('photos');
  return (meta || []).sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

/* ═══════════════════════════════════════════════════
   HIGH-LEVEL API — Settings, Tags, Folders
═══════════════════════════════════════════════════ */

async function sbSaveSettings(settings) {
  // PIN hash (bukan PIN asli) aman disimpan ke cloud untuk sinkronisasi antar perangkat
  await sbSaveMeta('settings', settings);
}
async function sbLoadSettings() { return sbLoadMeta('settings'); }

async function sbSaveTags(tags)    { await sbSaveMeta('tags', tags); }
async function sbLoadTags()        { return sbLoadMeta('tags') || []; }

async function sbSaveFolders(folders) {
  // Strip base64 src sebelum simpan ke cloud
  const clean = {};
  for (const [key, arr] of Object.entries(folders)) {
    clean[key] = arr.map(({ src: _, ...p }) => p);
  }
  await sbSaveMeta('folders', clean);
}
async function sbLoadFolders() { return sbLoadMeta('folders') || { game: [], her: [] }; }

/* ═══════════════════════════════════════════════════
   SYNC STATUS — helper UI
═══════════════════════════════════════════════════ */

let _syncStatus = 'idle'; // 'idle' | 'syncing' | 'done' | 'error'

function sbGetSyncStatus()          { return _syncStatus; }
function _setSyncStatus(s)          { _syncStatus = s; document.dispatchEvent(new CustomEvent('sb-sync', { detail: s })); }

/**
 * Full sync: upload semua data lokal ke Supabase.
 * Panggil ini setelah user login atau saat buka settings.
 */
async function sbFullSync({ photos, settings, tags, folderPhotos, onProgress } = {}) {
  _setSyncStatus('syncing');
  try {
    await sbEnsureAuth();
    const jobs = [];
    if (photos)       jobs.push(sbSyncPhotos(photos, onProgress));
    if (settings)     jobs.push(sbSaveSettings(settings));
    if (tags)         jobs.push(sbSaveTags(tags));
    if (folderPhotos) jobs.push(sbSaveFolders(folderPhotos));
    await Promise.all(jobs);
    _setSyncStatus('done');
    console.log('[Supabase] Full sync selesai ✅');
  } catch(e) {
    _setSyncStatus('error');
    console.error('[Supabase] Sync gagal:', e);
    throw e;
  }
}

/**
 * Full restore: load semua data dari Supabase ke lokal.
 * Gunakan saat pertama kali login di perangkat baru.
 */
async function sbFullRestore() {
  _setSyncStatus('syncing');
  try {
    await sbEnsureAuth();
    const [photos, settings, tags, folders] = await Promise.all([
      sbLoadPhotos(),
      sbLoadSettings(),
      sbLoadTags(),
      sbLoadFolders(),
    ]);
    _setSyncStatus('done');
    return { photos, settings, tags, folderPhotos: folders };
  } catch(e) {
    _setSyncStatus('error');
    throw e;
  }
}

/* ═══════════════════════════════════════════════════
   MUSIC — Upload / Load
   Musik lebih besar; hanya upload kalau user request.
═══════════════════════════════════════════════════ */

async function sbUploadMusic(track) {
  const uid  = await sbUserId();
  const path = `${uid}/music/${track.id || uniqueFilename('music')}.mp3`;
  const blob = track.blob instanceof Blob ? track.blob : dataUrlToBlob(track.blob);

  const { error } = await _supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: 'audio/mpeg', upsert: true });

  if (error) throw new Error('Upload musik gagal: ' + error.message);

  const { data } = _supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

async function sbSyncMusicMeta(tracks) {
  const meta = tracks.map(({ blob: _, ...t }) => t);
  await sbSaveMeta('music', meta);
}
async function sbLoadMusicMeta() { return sbLoadMeta('music') || []; }