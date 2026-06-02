/* ═══════════════════════════════════════════════════
   LOVE GALLERY — supabase.js  v3.1
   ✅ Identitas = PIN hash (sama di semua perangkat)
   ✅ Tidak pakai anonymous session
   ✅ Fix: musik sekarang tersync ke device lain
═══════════════════════════════════════════════════ */

const SUPABASE_URL = 'https://kwafswyrxejfckpdpgbq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_RMHNH8bsvwnt7MeV1x9Vmg_5Wch6RhM';
const BUCKET       = 'love-gallery';

const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ── User identity dari PIN hash ── */
let _uid = null;

function sbSetUserFromPin(pinHash) {
  _uid = 'u_' + pinHash.slice(0, 16);
  console.log('[Supabase] UID:', _uid);
}

function sbUserId() {
  if (!_uid) throw new Error('[Supabase] Panggil sbSetUserFromPin() dulu!');
  return _uid;
}

async function sbEnsureAuth() {
  if (!_uid) throw new Error('[Supabase] UID belum diset.');
  return { id: _uid };
}

/* ── Helpers ── */
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

/* ── FIX: Resolve sumber audio ke Blob ──────────────────────────────────
   musicTracks di memory hanya menyimpan ObjectURL (blob:http://...)
   bukan Blob asli. Fungsi ini mengubah semua format sumber ke Blob nyata.
────────────────────────────────────────────────────────────────────────── */
async function _resolveAudioBlob(track) {
  // Sudah berupa Blob — langsung pakai
  if (track.blob instanceof Blob) return track.blob;

  // ObjectURL (blob:http://...) — fetch dulu jadi Blob
  if (track.url && track.url.startsWith('blob:')) {
    const res = await fetch(track.url);
    return res.blob();
  }

  // Data URL (data:audio/...) — konversi ke Blob
  if (track.blob && typeof track.blob === 'string' && track.blob.startsWith('data:')) {
    return dataUrlToBlob(track.blob);
  }

  throw new Error(`Track "${track.name}" tidak punya sumber audio yang bisa diupload.`);
}

/* ── Storage: Meta JSON ── */
async function sbSaveMeta(name, data) {
  const path = `${sbUserId()}/meta/${name}.json`;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const { error } = await _supabase.storage
    .from(BUCKET).upload(path, blob, { contentType: 'application/json', upsert: true });
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

/* ── Storage: Foto ── */
async function sbUploadPhoto(dataUrl, filename = null) {
  const blob = dataUrlToBlob(dataUrl);
  const ext  = mimeToExt(blob.type);
  const name = filename || uniqueFilename('photo');
  const path = `${sbUserId()}/photos/${name}.${ext}`;
  const { error } = await _supabase.storage
    .from(BUCKET).upload(path, blob, { contentType: blob.type, upsert: true });
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

/* ── High-level: Foto ── */
async function sbSyncPhotos(photosArr, onProgress = null) {
  const result = [];
  for (let i = 0; i < photosArr.length; i++) {
    const p = { ...photosArr[i] };
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

/* ── High-level: Settings/Tags/Folders ── */
async function sbSaveSettings(settings) {
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

/* ── Sync status ── */
let _syncStatus = 'idle';
function sbGetSyncStatus() { return _syncStatus; }
function _setSyncStatus(s) {
  _syncStatus = s;
  document.dispatchEvent(new CustomEvent('sb-sync', { detail: s }));
}

/* ── Music ── */

/* FIX v3.1:
   Sebelumnya hanya mendukung track.blob (Blob).
   Sekarang mendukung semua format:
     - track.blob  → Blob asli (dari IndexedDB)
     - track.url   → ObjectURL (blob:http://...) dari memory musicTracks
     - track.blob  → Data URL string
*/
async function sbUploadMusic(track) {
  const path = `${sbUserId()}/music/${track.id || uniqueFilename('music')}.mp3`;

  let blob;
  try {
    blob = await _resolveAudioBlob(track);
  } catch(e) {
    throw new Error('Upload musik gagal (tidak ada sumber): ' + e.message);
  }

  const { error } = await _supabase.storage
    .from(BUCKET).upload(path, blob, { contentType: blob.type || 'audio/mpeg', upsert: true });
  if (error) throw new Error('Upload musik gagal: ' + error.message);
  const { data } = _supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

async function sbSyncMusicMeta(tracks) {
  await sbSaveMeta('music', tracks.map(({ blob: _, ...t }) => t));
}

/* FIX v3.1:
   Sebelumnya hanya mengecek track.blob untuk upload.
   musicTracks di script.js hanya punya track.url (ObjectURL),
   sehingga kondisi `!track.cloudUrl && track.blob` selalu false
   → musik tidak pernah diupload ke cloud.

   Sekarang: cek track.blob ATAU track.url agar ObjectURL juga diproses.
*/
async function sbSyncMusic(tracks) {
  const result = [];
  for (const t of tracks) {
    const track = { ...t };

    // Upload jika belum ada cloudUrl DAN ada sumber audio (blob atau ObjectURL)
    const hasSumber = track.blob || (track.url && track.url.startsWith('blob:'));
    if (!track.cloudUrl && hasSumber) {
      try {
        track.cloudUrl = await sbUploadMusic(track);
        console.log('[Supabase] Upload musik OK:', track.name);
      } catch(e) {
        console.warn('[Supabase] Upload musik gagal:', track.name, e.message);
      }
    }

    // Simpan metadata saja (tanpa blob/url lokal)
    const { blob: _, url: __, ...meta } = track;
    result.push(meta);
  }
  await sbSaveMeta('music', result);
  return result;
}

async function sbLoadMusicMeta() { return sbLoadMeta('music') || []; }

async function sbFullSync({ photos, settings, tags, folderPhotos, music, onProgress } = {}) {
  _setSyncStatus('syncing');
  try {
    await sbEnsureAuth();
    const jobs = [];
    if (photos)       jobs.push(sbSyncPhotos(photos, onProgress));
    if (settings)     jobs.push(sbSaveSettings(settings));
    if (tags)         jobs.push(sbSaveTags(tags));
    if (folderPhotos) jobs.push(sbSaveFolders(folderPhotos));
    // Musik dijalankan sendiri (sequential) karena fetch ObjectURL
    // tidak bisa dijalankan paralel dengan Promise.all yang mungkin banyak
    const musicPromise = music ? sbSyncMusic(music) : Promise.resolve();
    await Promise.all([...jobs, musicPromise]);
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
    const [photos, settings, tags, folders, music] = await Promise.all([
      sbLoadPhotos(), sbLoadSettings(), sbLoadTags(), sbLoadFolders(),
      sbLoadMusicMeta(),
    ]);
    _setSyncStatus('done');
    return { photos, settings, tags, folderPhotos: folders, music };
  } catch(e) {
    _setSyncStatus('error');
    throw e;
  }
}
