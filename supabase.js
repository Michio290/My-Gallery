/* ═══════════════════════════════════════════════════
   LOVE GALLERY — supabase.js  v3
   
   ✅ FIXED: Identitas = PIN hash (sama di semua perangkat)
   ✅ FIXED: Tidak pakai anonymous session
   ✅ FIXED: PIN hash disimpan ke cloud untuk sync antar HP
═══════════════════════════════════════════════════ */

const SUPABASE_URL = 'https://kwafswyrxejfckpdpgbq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_RMHNH8bsvwnt7MeV1x9Vmg_5Wch6RhM';
const BUCKET       = 'love-gallery';

const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ═══════════════════════════════════════════════════
   USER IDENTITY — dari PIN hash
   
   PIN hash (SHA-256) = 64 karakter hex
   uid = 16 karakter pertama → folder unik di Supabase
   Sama di semua perangkat selama PIN sama.
═══════════════════════════════════════════════════ */

let _uid = null;

/**
 * Dipanggil dari script.js setelah PIN tersedia.
 * @param {string} pinHash - SHA-256 hex (64 char)
 */
function sbSetUserFromPin(pinHash) {
  _uid = 'u_' + pinHash.slice(0, 16);
  console.log('[Supabase] UID set:', _uid);
}

function sbUserId() {
  if (!_uid) throw new Error('[Supabase] UID belum diset. Panggil sbSetUserFromPin() dulu.');
  return _uid;
}

/** Dummy auth check — dulu pakai anonymous session */
async function sbEnsureAuth() {
  if (!_uid) throw new Error('[Supabase] Panggil sbSetUserFromPin() sebelum sync.');
  return { id: _uid };
}

/* ═══════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════ */

function dataUrlToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const bin  = atob(b64);
  const arr  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function mimeToExt(mime) {
  return ({ 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif' })[mime] || 'jpg';
}

function uniqueFilename(prefix = 'photo') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
}

/* ═══════════════════════════════════════════════════
   STORAGE — METADATA JSON
   Path: {uid}/meta/{name}.json
═══════════════════════════════════════════════════ */

async function sbSaveMeta(name, data) {
  const path = `${sbUserId()}/meta/${name}.json`;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const { error } = await _supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: 'application/json', upsert: true });
  if (error) throw new Error(`Simpan meta "${name}" gagal: ${error.message}`);
}

async function sbLoadMeta(name) {
  const path = `${sbUserId()}/meta/${name}.json`;
  const { data, error } = await _supabase.storage.from(BUCKET).download(path);
  if (error) {
    if (error.message?.includes('not found') || error.statusCode === 404) return null;
    throw new Error(`Load meta "${name}" gagal: ${error.message}`);
  }
  return JSON.parse(await data.text());
}

/* ═══════════════════════════════════════════════════
   STORAGE — FOTO
   Path: {uid}/photos/{id}.{ext}
═══════════════════════════════════════════════════ */

async function sbUploadPhoto(dataUrl, filename = null) {
  const blob = dataUrlToBlob(dataUrl);
  const ext  = mimeToExt(blob.type);
  const name = filename || uniqueFilename('photo');
  const path = `${sbUserId()}/photos/${name}.${ext}`;
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
    const idx = urlOrPath.indexOf(marker);
    if (idx !== -1) path = urlOrPath.slice(idx + marker.length);
  }
  const { error } = await _supabase.storage.from(BUCKET).remove([path]);
  if (error) console.warn('Delete foto gagal:', error.message);
}

/* ═══════════════════════════════════════════════════
   HIGH-LEVEL — Foto
═══════════════════════════════════════════════════ */

async function sbSyncPhotos(photosArr, onProgress = null) {
  const result = [];
  for (let i = 0; i < photosArr.length; i++) {
    const p = { ...photosArr[i] };
    // Upload base64 → dapat cloudUrl permanen
    if (!p.cloudUrl && p.src && p.src.startsWith('data:')) {
      try {
        p.cloudUrl = await sbUploadPhoto(p.src, p.id);
        console.log(`[Supabase] Upload foto ${i+1}/${photosArr.length} OK`);
      } catch(e) {
        console.warn(`[Supabase] Upload foto gagal:`, e.message);
      }
    }
    const { src: _, ...meta } = p;
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
   HIGH-LEVEL — Settings (dengan PIN hash)
═══════════════════════════════════════════════════ */

async function sbSaveSettings(settings) {
  // PIN hash aman disimpan ke cloud — bukan PIN aslinya
  await sbSaveMeta('settings', settings);
}
async function sbLoadSettings() { return sbLoadMeta('settings'); }

async function sbSaveTags(tags) { await sbSaveMeta('tags', tags); }
async function sbLoadTags()     { return sbLoadMeta('tags') || []; }

async function sbSaveFolders(folders) {
  const clean = {};
  for (const [key, arr] of Object.entries(folders))
    clean[key] = arr.map(({ src: _, ...p }) => p);
  await sbSaveMeta('folders', clean);
}
async function sbLoadFolders() { return sbLoadMeta('folders') || { game: [], her: [] }; }

/* ═══════════════════════════════════════════════════
   SYNC STATUS
═══════════════════════════════════════════════════ */

let _syncStatus = 'idle';
function sbGetSyncStatus() { return _syncStatus; }
function _setSyncStatus(s) {
  _syncStatus = s;
  document.dispatchEvent(new CustomEvent('sb-sync', { detail: s }));
}

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
      sbLoadPhotos(), sbLoadSettings(), sbLoadTags(), sbLoadFolders(),
    ]);
    _setSyncStatus('done');
    return { photos, settings, tags, folderPhotos: folders };
  } catch(e) {
    _setSyncStatus('error');
    throw e;
  }
}

/* ═══════════════════════════════════════════════════
   MUSIC
═══════════════════════════════════════════════════ */

async function sbUploadMusic(track) {
  const path = `${sbUserId()}/music/${track.id || uniqueFilename('music')}.mp3`;
  const blob = track.blob instanceof Blob ? track.blob : dataUrlToBlob(track.blob);
  const { error } = await _supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: 'audio/mpeg', upsert: true });
  if (error) throw new Error('Upload musik gagal: ' + error.message);
  const { data } = _supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

async function sbSyncMusicMeta(tracks) {
  await sbSaveMeta('music', tracks.map(({ blob: _, ...t }) => t));
}
async function sbLoadMusicMeta() { return sbLoadMeta('music') || []; }