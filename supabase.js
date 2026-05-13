/* ═══════════════════════════════════════════════════
   LOVE GALLERY — supabase.js  v2
   Cloud sync via Supabase Storage (tanpa Auth)
   
   ✅ Identitas user = PIN hash (sama di semua perangkat)
   ✅ Tidak pakai anonymous session (yang berbeda tiap HP)
   ✅ Data tersimpan di path: {pinHash[:16]}/...
═══════════════════════════════════════════════════ */

const SUPABASE_URL = 'https://kwafswyrxejfckpdpgbq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_RMHNH8bsvwnt7MeV1x9Vmg_5Wch6RhM';
const BUCKET       = 'love-gallery';

/* ── Init Supabase client (via CDN UMD) ───────────── */
const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ═══════════════════════════════════════════════════
   IDENTITAS USER — Berbasis PIN Hash
   
   Ganti anonymous auth dengan ID tetap yang di-derive
   dari PIN hash. Hasilnya sama di semua perangkat
   selama PIN-nya sama.
   
   Path format: {uid16}/photos/{filename}
   uid16 = 16 karakter pertama dari SHA-256(PIN)
═══════════════════════════════════════════════════ */

let _cachedUid = null;

/**
 * Set user ID dari PIN hash — dipanggil setelah PIN tersedia.
 * @param {string} pinHash - SHA-256 hex dari PIN (64 karakter)
 */
function sbSetUserFromPin(pinHash) {
  _cachedUid = pinHash.slice(0, 16);
  console.log('[Supabase] User ID set dari PIN hash:', _cachedUid);
}

function sbUserId() {
  if (!_cachedUid) throw new Error('sbSetUserFromPin() belum dipanggil.');
  return _cachedUid;
}

async function sbEnsureAuth() {
  if (!_cachedUid) throw new Error('PIN belum di-set. Panggil sbSetUserFromPin() dulu.');
  return { id: _cachedUid };
}

/* ═══════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════ */

function dataUrlToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime  = header.match(/:(.*?);/)[1];
  const bin   = atob(b64);
  const arr   = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function mimeToExt(mime) {
  const map = { 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif' };
  return map[mime] || 'jpg';
}

function uniqueFilename(prefix = 'photo') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
}

/* ═══════════════════════════════════════════════════
   STORAGE — FOTO
═══════════════════════════════════════════════════ */

async function sbUploadPhoto(dataUrl, filename = null) {
  const uid  = sbUserId();
  const blob = dataUrlToBlob(dataUrl);
  const ext  = mimeToExt(blob.type);
  const name = filename || uniqueFilename('photo');
  const path = `${uid}/photos/${name}.${ext}`;

  const { error } = await _supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: blob.type, upsert: true });

  if (error) throw new Error('Upload foto gagal: ' + error.message);

  const { data } = _supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

async function sbDeletePhoto(urlOrPath) {
  let path = urlOrPath;
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
═══════════════════════════════════════════════════ */

async function sbSaveMeta(name, data) {
  const uid  = sbUserId();
  const path = `${uid}/meta/${name}.json`;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });

  const { error } = await _supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: 'application/json', upsert: true });

  if (error) throw new Error(`Simpan meta "${name}" gagal: ` + error.message);
}

async function sbLoadMeta(name) {
  const uid  = sbUserId();
  const path = `${uid}/meta/${name}.json`;

  const { data, error } = await _supabase.storage.from(BUCKET).download(path);
  if (error) {
    if (error.message?.includes('not found') || error.statusCode === 404) return null;
    throw new Error(`Load meta "${name}" gagal: ` + error.message);
  }
  const text = await data.text();
  return JSON.parse(text);
}

/* ═══════════════════════════════════════════════════
   HIGH-LEVEL API — Foto
═══════════════════════════════════════════════════ */

async function sbSyncPhotos(photosArr, onProgress = null) {
  const result = [];

  for (let i = 0; i < photosArr.length; i++) {
    const p = { ...photosArr[i] };

    if (!p.cloudUrl && p.src && p.src.startsWith('data:')) {
      try {
        p.cloudUrl = await sbUploadPhoto(p.src, p.id);
        console.log(`[Supabase] Upload foto ${i+1}/${photosArr.length}: OK`);
      } catch(e) {
        console.warn(`[Supabase] Upload foto ${p.id} gagal:`, e.message);
      }
    }

    const { src: _omitSrc, ...meta } = p;
    result.push({ ...meta, hasSrc: !!p.src });
    if (onProgress) onProgress(i + 1, photosArr.length);
  }

  await sbSaveMeta('photos', result);
  return result;
}

async function sbLoadPhotos() {
  const meta = await sbLoadMeta('photos');
  return (meta || []).sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

/* ═══════════════════════════════════════════════════
   HIGH-LEVEL API — Settings, Tags, Folders
═══════════════════════════════════════════════════ */

async function sbSaveSettings(settings) {
  // PIN hash (bukan PIN asli) aman disimpan untuk restore antar perangkat
  await sbSaveMeta('settings', settings);
}
async function sbLoadSettings() { return sbLoadMeta('settings'); }

async function sbSaveTags(tags)    { await sbSaveMeta('tags', tags); }
async function sbLoadTags()        { return sbLoadMeta('tags') || []; }

async function sbSaveFolders(folders) {
  const clean = {};
  for (const [key, arr] of Object.entries(folders)) {
    clean[key] = arr.map(({ src: _, ...p }) => p);
  }
  await sbSaveMeta('folders', clean);
}
async function sbLoadFolders() { return sbLoadMeta('folders') || { game: [], her: [] }; }

/* ═══════════════════════════════════════════════════
   SYNC STATUS
═══════════════════════════════════════════════════ */

let _syncStatus = 'idle';

function sbGetSyncStatus()  { return _syncStatus; }
function _setSyncStatus(s)  { _syncStatus = s; document.dispatchEvent(new CustomEvent('sb-sync', { detail: s })); }

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
═══════════════════════════════════════════════════ */

async function sbUploadMusic(track) {
  const uid  = sbUserId();
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