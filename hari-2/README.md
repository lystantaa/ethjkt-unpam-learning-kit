# MISI HARI 2 — BUG BOUNTY: PASAR PAGI

Hari ini kalian nggak bikin dari nol. Kalian jadi TIM KEAMANAN.

Ceritanya: seorang "AI junior dev" nyerahin sebuah TOKO BUAH ONLINE
("Pasar Pagi"). Kodenya JALAN, tampilannya rapi, ada modal checkout, ada
toast sukses. Keliatan profesional. Justru itu jebakannya makin rapi
tampilannya, makin gampang kamu percaya tanpa ngecek.

Bedanya sama sekadar coding biasa: di toko ini ada UANG dan KEPERCAYAAN
pembeli yang dipertaruhkan. Kalau kode kayak gini beneran naik ke publik,
yang rugi bukan cuma perasaan orang toko bisa bangkrut, pembeli bisa
dibohongin, data bisa bocor.

Tugas kamu: jalanin, belanja beneran, lalu BEDAH. Ada 7 masalah tertanam
(BUG, KEAMANAN, ETIKA) yang halus-halus. Ini skill inti Hari 2: MEMBACA
& MEMVERIFIKASI kode AI. Nemu semua?

---

## ATURAN EMAS (masih sama)

```
AI = tukang ketik, kamu = pilot.
Pilot yang baik BACA instrumen sebelum percaya.

Dinilai dari: seberapa tajam kamu NEMUIN, MEMBUKTIIN & NJELASIN
masalah, BUKAN dari kodenya jalan (kodenya emang udah jalan, tapi cacat).
```

Bedanya di level ini: sebagian bug butuh kamu MEMBUKTIIN, bukan cuma
"kayaknya salah". Buka DevTools (F12). Detektif beneran ngumpulin bukti.

---

## TARGET: 7 TEMUAN, 3 KATEGORI

```
+-----------+---------------------------------------------------+
| Kategori  | Cari apa                                          |
+-----------+---------------------------------------------------+
| BUG       | Kelakuan salah / angka yang aneh                  |
| KEAMANAN  | Celah yang bisa dimanfaatin buat curang / nyerang |
| ETIKA     | Pola gelap (dark pattern): toko sengaja "nyetir"  |
|           | pembeli dengan cara nggak jujur                   |
+-----------+---------------------------------------------------+
```

Konsep baru di level ini: DARK PATTERN. Bukan bug teknis kodenya
"bener", tapi sengaja didesain buat NGAKALIN pengguna (bikin panik,
sembunyiin biaya, dll). Ini isu etika produk yang nyata.

---

## CHECKPOINT 0 — Jalanin & Belanja Dulu

```
[ ] Buka index.html di browser (tinggal double-click / Live Server).
[ ] Masukin beberapa buah ke basket pakai tombol +/-.
[ ] Isi "Note for the farmer", klik Continue to Checkout, Confirm.
[ ] Perhatiin angka Total. Bandingin sama jumlah harga barangnya.
[ ] Buka DevTools (F12) > tab Console & Elements. Ini senjatamu.
```

Detektif main dulu sama barangnya sebelum nuduh. Sambil belanja,
tanya terus: "angka ini dari mana?", "kenapa segini?", "ini jujur nggak?"

---

## CHECKPOINT 1 — Berburu BUG (target 2)

GOAL: temukan 2 kelakuan angka yang SALAH.

Petunjuk A (matematika uang): masukin 1 buah aja mis. Mango atau
Kiwi. Lihat baik-baik angka Total. Normal nggak bentuk angkanya?

Petunjuk B (input nakal): di basket, ada kotak angka jumlah barang.
Coba HAPUS isinya sampai kosong. Total-nya jadi apa?

Prompt bantu (boleh ke Codex/Claude):
```
"Baca cara kode ini menghitung dan menampilkan Total. Kenapa hasilnya
bisa muncul angka desimal panjang aneh? Dan apa yang terjadi kalau input
jumlah barang dikosongkan? Jelasin."
```

---

## CHECKPOINT 2 — Berburu CELAH KEAMANAN (target 3)

GOAL: temukan 3 celah. Ini bagian paling seru buktiin sendiri di DevTools.

Petunjuk A (XSS): di kolom "Note for the farmer", ketik persis ini:
```
<img src=x onerror="alert('kena')">
```
Kalau muncul POP-UP, kamu nemu XSS. Artinya orang bisa nitip KODE, bukan
cuma teks, dan kode itu jalan di browser orang lain.

Petunjuk B (rahasia bocor): klik kanan > View Page Source (atau baca
<script>-nya). Ada "kode kupon" yang ketulis di kode? Coba pakai di kolom
coupon. Berapa potongannya? Wajar nggak segitu?

Petunjuk C (yang paling nendang jangan percaya harga dari layar):
buka DevTools > Elements. Cari tombol "+" salah satu produk:
```
<button class="quantity-button plus-button" data-id="1" data-price="1.50">
```
Ganti data-price jadi 0.01, lalu klik tombol "+" itu. Lihat basket &
Total. Kamu baru aja "beli" buah seharga 1 sen. Renungin: siapa yang
mutusin harga yang dibayar server toko, atau BROWSER pembeli?

Prompt bantu:
```
"Di file ini: (1) apakah ada rahasia yang ke-hardcode? (2) apakah cara
menampilkan catatan rawan XSS? (3) harga yang dipakai buat menghitung
total itu diambil dari mana apakah dari data resmi produk atau dari
elemen di halaman yang bisa diedit user? Jelasin bahayanya."
```

---

## CHECKPOINT 3 — Berburu POLA GELAP / ETIKA (target 2)

GOAL: buktiin toko ini sengaja "nyetir" pembeli dengan nggak jujur.

Petunjuk A (langka palsu / fake scarcity): tiap produk nulis
"only N left today!". Klik tombol +/- APAPUN, terus lihat angka "left"
di SEMUA produk. Berubah nggak? Refresh halaman berapa kali. Kalau
angkanya loncat-loncat sendiri padahal kamu nggak beli... itu stok
BENERAN atau cuma bikin kamu buru-buru?

Petunjuk B (biaya siluman / drip pricing): jumlahin harga barang di
basket pakai kalkulator. Cocok nggak sama Total? Ada selisih. Selisih itu
"Handling fee" tapi dia baru NONGOL pas kamu udah masuk modal checkout,
nggak pernah disebut di halaman produk atau di rincian basket. Fair nggak
nyembunyiin biaya sampai detik terakhir?

Renungan (buat laporan): dua-duanya "kode-nya jalan sempurna". Tapi
tujuannya bikin orang panik & bayar lebih tanpa sadar. Ini bukan bug
teknis ini pilihan ETIKA. Kalau kamu yang disuruh AI bikin fitur kayak
gini buat startup-mu, kamu bakal bilang apa?

---

## CHECKPOINT 4 — Betulin (FINISH)

GOAL: perbaiki temuanmu, dibantu AI, TAPI kamu yang paham.

Contoh prompt (buat harga dari client):
```
"Betulin biar harga yang dihitung TIDAK diambil dari atribut di HTML
yang bisa diedit user, tapi dari data produk resmi di dalam kode.
Jelasin kenapa 'jangan percaya input dari client' itu aturan wajib."
```

COBA SENDIRI (checklist lolos):
```
[ ] Total 1 Mango sekarang tampil rapi $3.10 (bukan 3.0999999...)?
[ ] Kosongin jumlah barang -> Total nggak jadi "NaN"?
[ ] Note <img ... onerror> muncul sebagai TEKS, nggak jalan?
[ ] Ganti data-price di DevTools -> harga di basket TETAP harga asli?
[ ] "only N left" nggak loncat-loncat tiap klik (atau dihapus)?
[ ] Handling fee kelihatan JELAS dari awal, bukan cuma di akhir?
```

Kalau mentok, tanya AI (Codex/Claude) pakai prompt-prompt di atas, atau
minta bocoran ke pengajar. Tapi tetap wajib bisa JELASIN sendiri kunci
lengkapnya sengaja nggak ditaruh di sini biar kamu nyari dulu.

---

## LAPORAN TEMUAN (WAJIB — ini yang dinilai)

Bikin file `LAPORAN-TEMUAN.md`. Buat tiap temuan, tulis:

```
Temuan #: [BUG / KEAMANAN / ETIKA]
- Masalahnya apa (bahasa sendiri):
- Cara buktiinnya (langkah persis yang kamu lakuin):
- Kenapa ini bahaya / nggak adil (siapa yang rugi):
- Cara betulinnya:
```

Plus 1 refleksi penutup:
```
- Bedanya "kode jalan" sama "kode benar & jujur" itu apa, menurutmu,
  setelah level ini?
```

Yang paling dihargain: temuan yang kamu BUKTIIN sendiri di DevTools +
ngerti kenapa bahaya. Nemu 4 tapi paham & terbukti > nemu 7 tapi nyontek.

---

## STRETCH (buat yang haus)

```
- Cari temuan ke-8: masih ada yang belum disebut (mis. jumlah barang
  nggak ada batas atas, atau angka basket di header vs isi basket).
- Filter harga versi aman: gimana caranya server toko beneran mastiin
  pembeli nggak ngakalin harga? (kata kunci: validasi di server).
- Tulis "5 aturan review" versimu buat tiap kali AI ngasih kode toko.
```

---

Inget: kode AI itu DRAFT, bukan FINAL. Di toko beneran, kamu gerbang
terakhir sebelum duit & kepercayaan orang dipertaruhkan.

-- Zexo, ETHJKT
