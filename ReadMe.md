# 📦 PATCH v2 — 8 Perbaikan Love Gallery

## Cara Pasang (2 langkah saja)

---

### 1. `PATCH_style.css` → masuk ke `style.css`
Buka `style.css`, scroll ke baris paling bawah.
Copy semua isi `PATCH_style.css` dan **paste di bagian akhir**.

---

### 2. `PATCH_script.js` → masuk ke `script.js`
Buka `script.js`, scroll ke baris paling bawah.
Copy semua isi `PATCH_script.js` dan **paste di bagian akhir**.

---

## ✅ Yang Diperbaiki

### 1. 📱 Tab filter tidak meluber di mobile
Tab sekarang bisa di-scroll horizontal di HP kecil — tidak ada lagi yang terpotong.

### 2. 🔝 Navbar lebih rapi di mobile
Di layar kecil (<480px), tombol slideshow disembunyikan, spacing diperkecil. Semua tombol penting tetap ada.

### 3. 📁 Empty state folder lebih menarik
Folder kosong sekarang tampil animasi, teks yang lebih hangat, dan tombol langsung tambah foto.

### 4. 🗑 Konfirmasi hapus pakai modal kustom
Semua hapus foto (dari grid, lightbox, select mode, folder) sekarang pakai popup modal cantik — tidak pakai browser `confirm()` yang jelek.

### 5. 🎞️ Scrapbook preview otomatis
Layout & foto dipilih → canvas langsung di-render otomatis, ada spinner loading, dan hint teks.

### 6. 💑 Anniversary bar disembunyikan jika belum diset
Bar tidak tampil kalau tanggal anniversary belum diisi. Tampil otomatis setelah diset.

### 7. 🌙 Dark mode lebih konsisten + fix emoji bulan jadi pisang
Banyak elemen yang sebelumnya tetap putih di dark mode sekarang sudah ikut gelap. Emoji 🌙 yang jadi 🍌 di Android sudah diganti jadi 📅.

### 8. 📤 Loading indicator saat upload foto
Saat upload foto (terutama banyak sekaligus), muncul overlay loading dengan progress bar dan teks "Memproses X dari Y foto".