/************************************************************
 * INGAT — Otak cadangan pribadi
 * Bagian Apps Script: gudang data (Google Sheet), penjaga pintu
 * (PIN & tanda tangan Telegram), dan bot pengingat Telegram.
 * Tampilan (Mini App & halaman Kelola) ada di GitHub Pages.
 ************************************************************/

// ====== PENGATURAN — isi 5 baris ini ======
const TOKEN = 'ISI_TOKEN_BOT_DARI_BOTFATHER';
const PIN = 'ISI_PIN_RAHASIA';                 // minimal 6 angka/huruf, untuk halaman Kelola
const WEBAPP_URL = 'ISI_URL_APPS_SCRIPT_BERAKHIRAN_/exec';
const MINIAPP_URL = 'https://USERNAME.github.io/ingat/';   // alamat GitHub Pages-mu, diakhiri garis miring
const JAM_PENGINGAT = 20;                      // jam pengingat harian (20 = jam 8 malam)

// ====== KONSTANTA ======
const KELOLA_URL = MINIAPP_URL + 'kelola.html';
const INTERVAL = [1, 3, 7, 14, 30, 60, 120];   // jarak ulang (hari) tiap naik level
const API = 'https://api.telegram.org/bot' + TOKEN + '/';
const PROPS = PropertiesService.getScriptProperties();
const SKEMA = {
  Orang: ['ID', 'Jenis', 'Nama', 'Panggilan', 'JK', 'Ayah', 'Ibu', 'Pasangan', 'Konteks', 'Jembatan', 'Catatan', 'Foto', 'Level', 'JatuhTempo', 'Benar', 'Salah', 'Dibuat'],
  Fakta: ['ID', 'Kategori', 'Pertanyaan', 'Jawaban', 'Penjelasan', 'Level', 'JatuhTempo', 'Benar', 'Salah', 'Dibuat'],
  Tips: ['ID', 'Kategori', 'Judul', 'Isi'],
  Skenario: ['ID', 'Situasi', 'PilihanA', 'PilihanB', 'PilihanC', 'Kunci', 'Penjelasan'],
  Riwayat: ['Tanggal', 'Dijawab', 'Benar']
};
const SHEET_BEBAS = ['Fakta', 'Tips', 'Skenario'];   // sheet yang boleh diubah lewat Kelola secara umum
let _CACHE = {};
let _IDX = null;

// ====== LANGKAH 1: jalankan setup ======
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(SKEMA).forEach(function (n) {
    let sh = ss.getSheetByName(n);
    if (!sh) sh = ss.insertSheet(n);
    if (sh.getLastRow() === 0) {
      sh.appendRow(SKEMA[n]);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, SKEMA[n].length).setFontWeight('bold');
    }
  });
  const s1 = ss.getSheetByName('Sheet1');
  if (s1 && s1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s1);
  isiAwal('Tips', TIPS_AWAL);
  isiAwal('Skenario', SKENARIO_AWAL);
  isiAwal('Fakta', FAKTA_AWAL);

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'kirimPengingat') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('kirimPengingat').timeBased().everyDays(1).atHour(JAM_PENGINGAT).create();
  Logger.log('✅ Setup selesai. Sekarang lakukan Deploy (Terapkan) sebagai Aplikasi web.');
}

// ====== LANGKAH 2: setelah deploy & isi WEBAPP_URL + MINIAPP_URL ======
function pasangTelegram() {
  const hasil = [];
  hasil.push(tg('setWebhook', { url: WEBAPP_URL, drop_pending_updates: true, allowed_updates: ['message'] }).getContentText());
  hasil.push(tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Latihan', web_app: { url: MINIAPP_URL } } }).getContentText());
  hasil.push(tg('setMyCommands', {
    commands: [
      { command: 'start', description: 'Buka menu latihan' },
      { command: 'kelola', description: 'Tambah atau ubah data' },
      { command: 'bantuan', description: 'Cara pakai' }
    ]
  }).getContentText());
  Logger.log(hasil.join('\n'));
}

function cekWebhook() {
  Logger.log(UrlFetchApp.fetch(API + 'getWebhookInfo').getContentText());
}

// ====== PINTU MASUK ======
function doGet() {
  return ContentService.createTextOutput('Ingat aktif. Buka lewat bot Telegram atau halaman Kelola.');
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (x) { return keJson({ ok: false, err: 'Format permintaan salah.' }); }
  if (body.update_id !== undefined) {
    terimaTelegram(body);
    return ContentService.createTextOutput('ok');
  }
  return keJson(terimaApi(body));
}

function keJson(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ====== API UNTUK HALAMAN ======
const AKSI = {
  // Mini App (dijaga tanda tangan Telegram)
  boot: function () { return paketLengkap(true); },
  jawab: function (d) { return jawab(d); },
  // Kelola (dijaga PIN)
  k_boot: function () { return paketLengkap(true); },
  k_simpanOrang: function (d) { const id = simpanOrang(d.item || {}); return { id: id, orang: daftarOrang(false), saya: PROPS.getProperty('SAYA_ID') || '' }; },
  k_hapusOrang: function (d) { hapusOrang(String(d.id)); return { orang: daftarOrang(false), saya: PROPS.getProperty('SAYA_ID') || '' }; },
  k_simpan: function (d) { cekSheet(d.sheet); const id = simpanUmum(d.sheet, d.item || {}); return { id: id, items: daftarUmum(d.sheet) }; },
  k_hapus: function (d) { cekSheet(d.sheet); hapusBaris(d.sheet, String(d.id)); return { items: daftarUmum(d.sheet) }; },
  k_saya: function (d) {
    const id = String(d.id || '');
    if (id && !cariObj('Orang', id)) throw new Error('Orang tidak ditemukan.');
    if (id) PROPS.setProperty('SAYA_ID', id); else PROPS.deleteProperty('SAYA_ID');
    return { orang: daftarOrang(false), saya: id };
  }
};

function terimaApi(body) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const a = String(body.action || '');
    if (!AKSI[a]) return { ok: false, err: 'Aksi tidak dikenal.' };
    if (a.indexOf('k_') === 0) {
      const salah = cekPin(body.pin);
      if (salah) return { ok: false, err: salah, auth: true };
    } else if (!cekInitData(body.initData)) {
      return { ok: false, err: 'Buka aplikasi ini lewat tombol Latihan di bot Telegram-mu.', auth: true };
    }
    const hasil = AKSI[a](body.data || {});
    return Object.assign({ ok: true }, hasil);
  } catch (err) {
    return { ok: false, err: String(err && err.message ? err.message : err) };
  } finally {
    try { lock.releaseLock(); } catch (x) { }
  }
}

function cekPin(pin) {
  if (!PIN || PIN.indexOf('ISI_') === 0) return 'PIN belum diatur di Code.gs.';
  const cache = CacheService.getScriptCache();
  const gagal = Number(cache.get('pin_gagal') || 0);
  if (gagal >= 10) return 'Terlalu sering salah PIN. Coba lagi 1 jam lagi.';
  if (String(pin || '') !== PIN) {
    cache.put('pin_gagal', String(gagal + 1), 3600);
    return 'PIN salah.';
  }
  return null;
}

// Memastikan permintaan benar-benar dari Telegram milik pemilik
function cekInitData(initData) {
  if (!initData) return false;
  const pasang = {};
  let hash = '';
  String(initData).split('&').forEach(function (p) {
    const i = p.indexOf('=');
    if (i < 0) return;
    const k = decodeURIComponent(p.slice(0, i));
    const v = decodeURIComponent(p.slice(i + 1));
    if (k === 'hash') hash = v; else pasang[k] = v;
  });
  const teks = Object.keys(pasang).sort().map(function (k) { return k + '=' + pasang[k]; }).join('\n');
  const kunci = Utilities.computeHmacSha256Signature(TOKEN, 'WebAppData');
  const tanda = Utilities.computeHmacSha256Signature(Utilities.newBlob(teks).getBytes(), kunci);
  const hex = tanda.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  if (!hash || hex !== hash) return false;
  if (Date.now() / 1000 - Number(pasang.auth_date || 0) > 86400 * 2) return false;
  let user = {};
  try { user = JSON.parse(pasang.user || '{}'); } catch (x) { }
  const pemilik = PROPS.getProperty('OWNER_ID');
  return !!pemilik && String(user.id) === pemilik;
}

function cekSheet(n) {
  if (SHEET_BEBAS.indexOf(n) < 0) throw new Error('Sheet tidak dikenal.');
}

// ====== PAKET DATA ======
function paketLengkap(denganFoto) {
  return {
    saya: PROPS.getProperty('SAYA_ID') || '',
    orang: daftarOrang(denganFoto),
    fakta: daftarUmum('Fakta'),
    tips: daftarUmum('Tips'),
    skenario: daftarUmum('Skenario'),
    stat: statistik(),
    sekarang: new Date().toISOString()
  };
}

function daftarOrang(denganFoto) {
  const list = baca('Orang');
  _IDX = {};
  list.forEach(function (o) { _IDX[o.ID] = o; });
  const saya = PROPS.getProperty('SAYA_ID');
  const adaSaya = saya && _IDX[saya];
  const akarSaya = adaSaya ? leluhur(saya) : null;
  return list.map(function (o) {
    const x = bersih(o, 'Orang');
    x.adaFoto = !!o.Foto;
    if (!denganFoto) delete x.Foto;
    x.hub = (adaSaya && o.Jenis !== 'kenalan') ? hubungan(saya, o.ID, akarSaya) : '';
    return x;
  });
}

function daftarUmum(n) {
  return baca(n).map(function (o) { return bersih(o, n); });
}

// ====== SIMPAN & HAPUS ======
function simpanOrang(o) {
  const nama = String(o.Nama || '').trim();
  if (!nama) throw new Error('Nama wajib diisi.');
  const list = baca('Orang');
  const idx = {};
  list.forEach(function (x) { idx[x.ID] = x; });
  const id0 = String(o.ID || '');
  const lama = id0 ? idx[id0] : null;
  if (id0 && !lama) throw new Error('Data ini sudah tidak ada. Muat ulang halaman.');

  const ayah = String(o.Ayah || ''), ibu = String(o.Ibu || '');
  [ayah, ibu].forEach(function (p) {
    if (p && !idx[p]) throw new Error('Orang tua yang dipilih tidak ditemukan.');
    if (p && p === id0) throw new Error('Orang tua tidak boleh dirinya sendiri.');
  });
  if (ayah && ibu && ayah === ibu) throw new Error('Ayah dan ibu tidak boleh orang yang sama.');
  if (id0 && (turunanDari(id0, idx).indexOf(ayah) >= 0 || turunanDari(id0, idx).indexOf(ibu) >= 0)) {
    throw new Error('Tidak bisa: orang tua yang dipilih adalah keturunannya sendiri.');
  }
  const foto = String(o.Foto || '');
  if (foto && foto.indexOf('data:image/') !== 0) throw new Error('Format foto tidak dikenal.');
  if (foto.length > 49000) throw new Error('Foto terlalu besar, pilih foto lain.');

  const pasBaru = idsDari(o.Pasangan).filter(function (p) { return p !== id0 && idx[p]; });
  const rec = {
    ID: id0,
    Jenis: o.Jenis === 'kenalan' ? 'kenalan' : 'keluarga',
    Nama: nama,
    Panggilan: String(o.Panggilan || '').trim(),
    JK: o.JK === 'L' || o.JK === 'P' ? o.JK : '',
    Ayah: ayah, Ibu: ibu,
    Pasangan: pasBaru.join(','),
    Konteks: String(o.Konteks || '').trim(),
    Jembatan: String(o.Jembatan || '').trim(),
    Catatan: String(o.Catatan || '').trim(),
    Foto: foto,
    Level: lama ? lama.Level : 0,
    JatuhTempo: lama ? lama.JatuhTempo : tglPlus(0),
    Benar: lama ? lama.Benar : 0,
    Salah: lama ? lama.Salah : 0,
    Dibuat: lama ? lama.Dibuat : new Date()
  };
  const id = tulis('Orang', rec);

  // samakan data pasangan di dua sisi
  const pasLama = lama ? idsDari(lama.Pasangan) : [];
  pasBaru.forEach(function (p) {
    if (pasLama.indexOf(p) >= 0) return;
    const ps = idsDari(idx[p].Pasangan);
    if (ps.indexOf(id) < 0) { ps.push(id); setSel('Orang', idx[p], 'Pasangan', ps.join(',')); }
  });
  // anak yang baru tercatat satu orang tuanya dilengkapi dengan pasangannya
  if (pasBaru.length === 1) {
    const p = idx[pasBaru[0]];
    list.forEach(function (c) {
      if (c.Ayah === id && !c.Ibu && p.JK === 'P') setSel('Orang', c, 'Ibu', p.ID);
      else if (c.Ibu === id && !c.Ayah && p.JK === 'L') setSel('Orang', c, 'Ayah', p.ID);
      else if (c.Ayah === p.ID && !c.Ibu && rec.JK === 'P' && c.ID !== id) setSel('Orang', c, 'Ibu', id);
      else if (c.Ibu === p.ID && !c.Ayah && rec.JK === 'L' && c.ID !== id) setSel('Orang', c, 'Ayah', id);
    });
  }
  pasLama.forEach(function (p) {
    if (pasBaru.indexOf(p) >= 0 || !idx[p]) return;
    setSel('Orang', idx[p], 'Pasangan', idsDari(idx[p].Pasangan).filter(function (x) { return x !== id; }).join(','));
  });
  _CACHE = {};
  return id;
}

function turunanDari(id, idx) {
  const hasil = [], antre = [id];
  while (antre.length) {
    const cur = antre.shift();
    Object.keys(idx).forEach(function (k) {
      const c = idx[k];
      if ((c.Ayah === cur || c.Ibu === cur) && hasil.indexOf(c.ID) < 0) { hasil.push(c.ID); antre.push(c.ID); }
    });
  }
  return hasil;
}

function hapusOrang(id) {
  const list = baca('Orang');
  const o = list.filter(function (x) { return x.ID === id; })[0];
  if (!o) throw new Error('Data sudah tidak ada.');
  list.forEach(function (x) {
    if (x.ID === id) return;
    if (x.Ayah === id) setSel('Orang', x, 'Ayah', '');
    if (x.Ibu === id) setSel('Orang', x, 'Ibu', '');
    const ps = idsDari(x.Pasangan);
    if (ps.indexOf(id) >= 0) setSel('Orang', x, 'Pasangan', ps.filter(function (p) { return p !== id; }).join(','));
  });
  sheet('Orang').deleteRow(o._row);
  _CACHE = {};
  if (PROPS.getProperty('SAYA_ID') === id) PROPS.deleteProperty('SAYA_ID');
}

function simpanUmum(n, item) {
  const kol = SKEMA[n];
  const id0 = String(item.ID || '');
  const lama = id0 ? cariObj(n, id0) : null;
  if (id0 && !lama) throw new Error('Data ini sudah tidak ada. Muat ulang halaman.');
  const rec = {};
  kol.forEach(function (k) { rec[k] = lama ? lama[k] : ''; });
  ['Kategori', 'Pertanyaan', 'Jawaban', 'Penjelasan', 'Judul', 'Isi', 'Situasi', 'PilihanA', 'PilihanB', 'PilihanC', 'Kunci']
    .forEach(function (k) { if (kol.indexOf(k) >= 0 && item[k] !== undefined) rec[k] = String(item[k]).trim(); });
  if (n === 'Fakta' && (!rec.Pertanyaan || !rec.Jawaban)) throw new Error('Pertanyaan dan jawaban wajib diisi.');
  if (n === 'Tips' && !rec.Isi) throw new Error('Isi tips wajib diisi.');
  if (n === 'Skenario') {
    if (!rec.Situasi || !rec.PilihanA || !rec.PilihanB || !rec.PilihanC) throw new Error('Situasi dan ketiga pilihan wajib diisi.');
    if (['A', 'B', 'C'].indexOf(rec.Kunci) < 0) throw new Error('Pilih jawaban terbaik: A, B, atau C.');
  }
  if (n === 'Fakta' && !lama) { rec.Level = 0; rec.JatuhTempo = tglPlus(0); rec.Benar = 0; rec.Salah = 0; rec.Dibuat = new Date(); }
  rec.ID = id0;
  return tulis(n, rec);
}

// ====== LATIHAN ======
function jawab(d) {
  const n = d.jenis === 'fakta' ? 'Fakta' : 'Orang';
  const o = cariObj(n, String(d.id));
  if (!o) throw new Error('Kartu ini sudah dihapus.');
  const benar = !!d.benar;
  const lv = Number(o.Level) || 0;
  const baru = benar ? Math.min(lv + 1, INTERVAL.length) : 0;
  const hari = baru === 0 ? 1 : INTERVAL[Math.min(baru - 1, INTERVAL.length - 1)];
  const due = tglPlus(hari);
  setSel(n, o, 'Level', baru);
  setSel(n, o, 'JatuhTempo', due);
  setSel(n, o, benar ? 'Benar' : 'Salah', (Number(o[benar ? 'Benar' : 'Salah']) || 0) + 1);
  catatRiwayat(benar);
  _CACHE = {};
  return { Level: baru, JatuhTempo: due.toISOString(), hari: hari, stat: statistik() };
}

function catatRiwayat(benar) {
  const sh = sheet('Riwayat');
  const hariIni = tglTeks(new Date());
  const v = sh.getDataRange().getValues();
  for (let i = v.length - 1; i >= 1; i--) {
    if (tglTeks(v[i][0]) === hariIni) {
      sh.getRange(i + 1, 2, 1, 2).setValues([[(Number(v[i][1]) || 0) + 1, (Number(v[i][2]) || 0) + (benar ? 1 : 0)]]);
      return;
    }
  }
  sh.appendRow(["'" + hariIni, 1, benar ? 1 : 0]);
}

function statistik() {
  const peta = {};
  sheet('Riwayat').getDataRange().getValues().slice(1).forEach(function (r) {
    const t = tglTeks(r[0]);
    if (t) peta[t] = { d: Number(r[1]) || 0, b: Number(r[2]) || 0 };
  });
  const hari = function (mundur) { const x = new Date(); x.setDate(x.getDate() - mundur); return tglTeks(x); };
  let streak = 0, mulai = (peta[hari(0)] && peta[hari(0)].d) ? 0 : 1;
  for (let i = mulai; i < 3650; i++) {
    const r = peta[hari(i)];
    if (r && r.d > 0) streak++; else break;
  }
  const minggu = [];
  for (let i = 6; i >= 0; i--) {
    const t = hari(i);
    minggu.push({ t: t, d: peta[t] ? peta[t].d : 0, b: peta[t] ? peta[t].b : 0 });
  }
  const sekarang = new Date();
  const orang = baca('Orang'), fakta = baca('Fakta');
  const jatuh = function (x) { return !x.JatuhTempo || new Date(x.JatuhTempo) <= sekarang; };
  const saya = PROPS.getProperty('SAYA_ID');
  const punyaAnak = {};
  orang.forEach(function (o) { if (o.Ayah) punyaAnak[o.Ayah] = 1; if (o.Ibu) punyaAnak[o.Ibu] = 1; });
  const bisaDiuji = function (o) { return o.ID !== saya && (o.Foto || o.Ayah || o.Ibu || o.Pasangan || o.Konteks || punyaAnak[o.ID]); };
  return {
    streak: streak,
    hariIni: peta[hari(0)] || { d: 0, b: 0 },
    minggu: minggu,
    jumlahOrang: orang.length,
    keluarga: orang.filter(function (o) { return o.Jenis !== 'kenalan'; }).length,
    kenalan: orang.filter(function (o) { return o.Jenis === 'kenalan'; }).length,
    jumlahFakta: fakta.length,
    menunggu: orang.filter(function (o) { return bisaDiuji(o) && jatuh(o); }).length + fakta.filter(jatuh).length
  };
}

// ====== HUBUNGAN KEKERABATAN ======
function leluhur(id) {
  const jarak = {}, antre = [id];
  jarak[id] = 0;
  while (antre.length) {
    const cur = antre.shift();
    const o = _IDX[cur];
    if (!o) continue;
    [o.Ayah, o.Ibu].forEach(function (p) {
      if (p && _IDX[p] && jarak[p] === undefined) { jarak[p] = jarak[cur] + 1; antre.push(p); }
    });
  }
  return jarak;
}

function darah(aId, bId, akarA) {
  const A = akarA || leluhur(aId), B = leluhur(bId);
  let best = null;
  Object.keys(A).forEach(function (k) {
    if (B[k] === undefined) return;
    const s = A[k] + B[k];
    if (!best || s < best.s) best = { ca: k, up: A[k], down: B[k], s: s };
  });
  return best;
}

function namaDarah(r, g, aId, bId) {
  const u = r.up, dn = r.down;
  const LP = function (l, p, n) { return g === 'L' ? l : (g === 'P' ? p : n); };
  if (u === 0 && dn === 0) return 'diri sendiri';
  if (u === 0) return dn === 1 ? 'anak' : dn === 2 ? 'cucu' : dn === 3 ? 'cicit (kumpi)' : 'keturunan generasi ke-' + dn;
  if (dn === 0) return u === 1 ? LP('ayah', 'ibu', 'orang tua') : u === 2 ? LP('kakek (pekak)', 'nenek (dadong)', 'kakek/nenek') :
    u === 3 ? 'buyut (kumpi)' : 'leluhur ' + u + ' generasi di atas';
  if (u === 1 && dn === 1) {
    const A = _IDX[aId], B = _IDX[bId];
    if (A.Ayah && A.Ibu && B.Ayah && B.Ibu) return (A.Ayah === B.Ayah && A.Ibu === B.Ibu) ? 'saudara kandung' : 'saudara tiri';
    return 'saudara';
  }
  if (u === 1 && dn === 2) return 'keponakan';
  if (u === 1 && dn === 3) return 'cucu keponakan';
  if (u === 1) return 'keturunan saudara';
  if (u === 2 && dn === 1) return LP('paman', 'bibi', 'paman/bibi');
  if (u === 3 && dn === 1) return LP('kakek', 'nenek', 'kakek/nenek') + ' (saudara kakek/nenek)';
  if (dn === 1) return LP('kakek', 'nenek', 'leluhur') + ' jauh';
  if (u === dn) return u === 2 ? 'sepupu (misan)' : u === 3 ? 'sepupu dua kali (mindon)' : 'sepupu ' + (u - 1) + ' kali';
  if (u === 2 && dn === 3) return 'anak sepupu';
  if (u === 3 && dn === 2) return LP('paman', 'bibi', 'paman/bibi') + ' jauh (sepupu orang tua)';
  return 'kerabat jauh';
}

function hubungan(aId, bId, akarA) {
  if (aId === bId) return 'kamu';
  const A = _IDX[aId], B = _IDX[bId];
  if (!A || !B) return '';
  const g = B.JK;
  const LP = function (l, p, n) { return g === 'L' ? l : (g === 'P' ? p : n); };
  if (idsDari(A.Pasangan).indexOf(bId) >= 0) return LP('suami', 'istri', 'pasangan');

  let r = darah(aId, bId, akarA);
  if (r) return namaDarah(r, g, aId, bId);

  const spB = pasanganDari(B);
  for (let i = 0; i < spB.length; i++) {
    const s = spB[i];
    r = darah(aId, s.ID, akarA);
    if (!r) continue;
    if (r.up === 0 && r.down === 1) return 'menantu';
    if (r.up === 0 && r.down === 2) return 'cucu menantu';
    if (r.up === 1 && r.down === 1) return 'ipar';
    if (r.up === 1 && r.down === 0) return LP('ayah tiri', 'ibu tiri', 'orang tua tiri');
    if (r.up === 2 && r.down === 1) return LP('paman', 'bibi', 'paman/bibi');
    return 'pasangan dari ' + namaDarah(r, s.JK, aId, s.ID) + 'mu';
  }
  const spA = pasanganDari(A);
  for (let i = 0; i < spA.length; i++) {
    const s = spA[i];
    r = darah(s.ID, bId);
    if (!r) continue;
    if (r.up === 1 && r.down === 0) return LP('ayah mertua', 'ibu mertua', 'mertua');
    if (r.up === 0 && r.down === 1) return 'anak tiri';
    if (r.up === 1 && r.down === 1) return 'ipar';
    return namaDarah(r, g, s.ID, bId) + ' dari pasanganmu';
  }
  for (let i = 0; i < spA.length; i++) {
    for (let j = 0; j < spB.length; j++) {
      if (darah(spA[i].ID, spB[j].ID)) return 'kerabat lewat pernikahan';
    }
  }
  return '';
}

function pasanganDari(o) {
  return idsDari(o.Pasangan).map(function (id) { return _IDX[id]; }).filter(Boolean);
}

// ====== BOT TELEGRAM ======
function terimaTelegram(upd) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const cache = CacheService.getScriptCache();
    const k = 'upd_' + upd.update_id;
    if (cache.get(k)) return;
    cache.put(k, '1', 21600);

    const m = upd.message;
    if (!m || !m.from || m.chat.type !== 'private') return;
    const uid = String(m.from.id);
    let pemilik = PROPS.getProperty('OWNER_ID');
    if (!pemilik) {
      PROPS.setProperty('OWNER_ID', uid);
      PROPS.setProperty('CHAT_ID', String(m.chat.id));
      pemilik = uid;
    }
    if (uid !== pemilik) {
      tg('sendMessage', { chat_id: m.chat.id, text: 'Maaf, ini aplikasi pribadi.' });
      return;
    }
    const teks = String(m.text || '').trim();
    if (!teks || /^\/(start|latihan|menu)\b/i.test(teks)) return sapa();
    if (/^\/kelola\b/i.test(teks)) {
      return kirim('Tambah, ubah, atau hapus data di halaman Kelola. Simpan juga alamat ini di browser HP-mu.',
        [[{ text: '🗂 Buka Kelola', url: KELOLA_URL }]]);
    }
    if (/^\/(bantuan|help)\b/i.test(teks)) return bantuan();
    if (teks.charAt(0) === '/') return kirim('Perintah tidak dikenal. Ketik /bantuan.');
    cariCepat(teks);
  } catch (err) {
    console.error(err);
  } finally {
    try { lock.releaseLock(); } catch (x) { }
  }
}

function tombolUtama() {
  return [[{ text: '🃏 Mulai latihan', web_app: { url: MINIAPP_URL } }], [{ text: '🗂 Kelola data', url: KELOLA_URL }]];
}

function sapa() {
  const s = statistik();
  let t = '🙏 <b>Om Swastiastu</b>\n\n';
  if (s.jumlahOrang + s.jumlahFakta === 0) {
    t += 'Otak cadanganmu masih kosong. Buka <b>Kelola data</b>, tambahkan dirimu, keluarga, dan kenalan. Setelah itu kembali ke sini untuk latihan.';
  } else {
    t += '🔥 Beruntun: <b>' + s.streak + ' hari</b>\n🃏 Menunggu dilatih: <b>' + s.menunggu + ' kartu</b>\n' +
      '👪 ' + s.keluarga + ' keluarga · 🤝 ' + s.kenalan + ' kenalan · 📚 ' + s.jumlahFakta + ' fakta\n\n' +
      'Ketik nama seseorang untuk melihat kartunya dengan cepat.';
  }
  kirim(t, tombolUtama());
}

function bantuan() {
  kirim('📖 <b>Cara pakai</b>\n\n' +
    '• Tombol <b>Latihan</b> (kiri bawah) membuka aplikasi: latihan kartu, daftar orang, pohon keluarga, dan latihan ngobrol.\n' +
    '• /kelola untuk menambah atau mengubah data dan foto.\n' +
    '• Ketik nama, misalnya <code>Darma</code>, untuk melihat kartu orang itu.\n' +
    '• Setiap jam ' + JAM_PENGINGAT + '.00 aku mengingatkan kalau ada kartu yang menunggu.', tombolUtama());
}

function cariCepat(teks) {
  const q = norm(teks);
  const semua = daftarOrang(true);
  const hasil = semua.filter(function (o) {
    return norm(o.Nama).indexOf(q) >= 0 || norm(o.Panggilan).indexOf(q) >= 0;
  });
  if (!hasil.length) return kirim('Belum ada orang bernama "' + esc(teks) + '". Tambahkan lewat /kelola.');
  const idx = {};
  semua.forEach(function (o) { idx[o.ID] = o; });
  hasil.slice(0, 3).forEach(function (o) {
    let c = '<b>' + esc(o.Nama) + '</b>' + (o.Panggilan ? ' (' + esc(o.Panggilan) + ')' : '');
    if (o.hub) c += '\n🔗 ' + esc(o.hub) + ' bagimu';
    const ortu = [idx[o.Ayah], idx[o.Ibu]].filter(Boolean).map(function (x) { return x.Nama; });
    if (ortu.length) c += '\n👪 Anak dari ' + esc(ortu.join(' & '));
    const ps = idsDari(o.Pasangan).map(function (id) { return idx[id]; }).filter(Boolean).map(function (x) { return x.Nama; });
    if (ps.length) c += '\n💍 ' + esc(ps.join(', '));
    if (o.Konteks) c += '\n📍 ' + esc(o.Konteks);
    if (o.Jembatan) c += '\n🔗 Jembatan: ' + esc(o.Jembatan);
    const cat = String(o.Catatan || '').split('\n').filter(String);
    if (cat.length) c += '\n📝 ' + esc(cat[cat.length - 1]);
    if (c.length > 1000) c = c.slice(0, 990) + '…';
    if (o.Foto) kirimFoto(o.Foto, c); else kirim(c);
  });
  if (hasil.length > 3) kirim('…dan ' + (hasil.length - 3) + ' orang lain. Ketik nama lebih lengkap.');
}

function kirimPengingat() {
  if (!PROPS.getProperty('CHAT_ID')) return;
  const s = statistik();
  if (s.hariIni.d > 0 || s.menunggu === 0) return;
  const t = s.streak > 0
    ? '🔥 Beruntun <b>' + s.streak + ' hari</b>. Jangan putus malam ini.\n🃏 Ada <b>' + s.menunggu + ' kartu</b> menunggu, cukup 3 menit.'
    : '🃏 Ada <b>' + s.menunggu + ' kartu</b> menunggu. Latihan 3 menit malam ini?';
  kirim(t, [[{ text: '🃏 Mulai latihan', web_app: { url: MINIAPP_URL } }]]);
}

function tg(method, payload) {
  return UrlFetchApp.fetch(API + method, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
}

function kirim(teks, tombol) {
  const p = { chat_id: PROPS.getProperty('CHAT_ID'), text: teks, parse_mode: 'HTML', disable_web_page_preview: true };
  if (tombol) p.reply_markup = { inline_keyboard: tombol };
  return tg('sendMessage', p);
}

function kirimFoto(dataUrl, caption) {
  const bagian = String(dataUrl).split(',');
  const blob = Utilities.newBlob(Utilities.base64Decode(bagian[1]), 'image/jpeg', 'foto.jpg');
  return UrlFetchApp.fetch(API + 'sendPhoto', {
    method: 'post', muteHttpExceptions: true,
    payload: { chat_id: PROPS.getProperty('CHAT_ID'), photo: blob, caption: caption, parse_mode: 'HTML' }
  });
}

// ====== LAPISAN DATA SHEET ======
function sheet(n) { return SpreadsheetApp.getActive().getSheetByName(n); }

function baca(n) {
  if (_CACHE[n]) return _CACHE[n];
  const kol = SKEMA[n];
  const sh = sheet(n);
  const v = sh.getDataRange().getValues();
  v.shift();
  const pakaiId = kol[0] === 'ID';
  let maxId = 0;
  if (pakaiId) v.forEach(function (r) { maxId = Math.max(maxId, Number(r[0]) || 0); });
  const hasil = [];
  v.forEach(function (r, i) {
    if (r.join('').trim() === '') return;
    if (pakaiId && String(r[0]).trim() === '') {     // baris yang ditambah manual di Sheet
      r[0] = ++maxId;
      sh.getRange(i + 2, 1).setValue(r[0]);
    }
    const o = { _row: i + 2 };
    kol.forEach(function (k, j) { o[k] = r[j]; });
    ['ID', 'Ayah', 'Ibu', 'Pasangan'].forEach(function (k) { if (k in o) o[k] = String(o[k] === '' || o[k] == null ? '' : o[k]).trim(); });
    if ('JK' in o) o.JK = String(o.JK || '').trim().toUpperCase();
    if ('Jenis' in o) o.Jenis = String(o.Jenis || '').trim().toLowerCase() === 'kenalan' ? 'kenalan' : 'keluarga';
    hasil.push(o);
  });
  _CACHE[n] = hasil;
  return hasil;
}

function bersih(o, n) {
  const x = {};
  SKEMA[n].forEach(function (k) {
    let v = o[k];
    if (v instanceof Date) v = isNaN(v) ? '' : v.toISOString();
    else if (v == null) v = '';
    x[k] = v;
  });
  return x;
}

function cariObj(n, id) {
  return baca(n).filter(function (o) { return o.ID === String(id); })[0] || null;
}

function tulis(n, rec) {
  const sh = sheet(n), kol = SKEMA[n];
  let id = String(rec.ID || '');
  if (!id) {
    id = String(baca(n).reduce(function (m, o) { return Math.max(m, Number(o.ID) || 0); }, 0) + 1);
    rec.ID = id;
    sh.appendRow(kol.map(function (k) { return nilaiSel(rec[k]); }));
  } else {
    const o = cariObj(n, id);
    if (!o) throw new Error('Data tidak ditemukan.');
    sh.getRange(o._row, 1, 1, kol.length).setValues([kol.map(function (k) { return nilaiSel(rec[k]); })]);
  }
  _CACHE = {};
  return id;
}

function setSel(n, o, kolom, nilai) {
  sheet(n).getRange(o._row, SKEMA[n].indexOf(kolom) + 1).setValue(nilaiSel(nilai));
  o[kolom] = nilai;
}

function hapusBaris(n, id) {
  const o = cariObj(n, id);
  if (!o) throw new Error('Data sudah tidak ada.');
  sheet(n).deleteRow(o._row);
  _CACHE = {};
}

// teks yang diawali = + - @ disimpan apa adanya, bukan sebagai rumus
function nilaiSel(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function isiAwal(n, data) {
  const sh = sheet(n);
  if (sh.getLastRow() >= 2) return;
  const kol = SKEMA[n];
  const rows = data.map(function (r, i) {
    const lengkap = [i + 1].concat(r);
    while (lengkap.length < kol.length) lengkap.push('');
    if (n === 'Fakta') { lengkap[5] = 0; lengkap[6] = tglPlus(0); lengkap[7] = 0; lengkap[8] = 0; lengkap[9] = new Date(); }
    return lengkap;
  });
  sh.getRange(2, 1, rows.length, kol.length).setValues(rows);
}

// ====== UTIL ======
function idsDari(s) {
  if (Array.isArray(s)) return s.map(String).filter(Boolean);
  return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
}

function tglPlus(hari) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + hari);
  return d;
}

function tglTeks(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v).replace(/^'/, '').slice(0, 10);
}

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ====== ISI AWAL ======
const TIPS_AWAL = [
  ['Pembuka', 'Mulai dari situasi bersama', 'Komentari hal yang sedang kalian alami bersama: cuaca, antrean, acara, makanan. Contoh: "Ramai juga ya hari ini, biasanya begini terus?" Aman, karena tidak menyinggung hal pribadi.'],
  ['Pembuka', 'Sebut namamu duluan', 'Ulurkan tangan dan sebut nama: "Saya Agus, dari Lapas." Orang cenderung membalas dengan namanya. Langsung ulangi: "Oh, Pak Wayan, senang kenal."'],
  ['Nama', 'Ulangi nama tiga kali', 'Saat kenalan, ucapkan namanya di awal, di tengah obrolan, dan saat pamit. Tiga kali pengulangan memberi otak tiga kesempatan menyimpan.'],
  ['Nama', 'Buat jembatan ingatan', 'Kaitkan nama dengan gambar yang lucu atau aneh. "Pak Darma → bayangkan dia memakai jubah hakim." Makin konyol gambarnya, makin nempel.'],
  ['Nama', 'Tanyakan arti nama', '"Namanya unik, ada artinya?" Pertanyaan ini membuka obrolan sekaligus membantumu mengingat.'],
  ['Nama', 'Catat secepatnya', 'Dalam 5 menit setelah berpisah, tambahkan orang itu di Kelola. Ingatan baru paling cepat hilang di jam-jam pertama.'],
  ['Obrolan', 'Pertanyaan terbuka', 'Ganti pertanyaan ya/tidak dengan "gimana", "kenapa", "ceritain dong". "Sudah lama kerja di sini?" menjadi "Gimana awalnya bisa kerja di sini?"'],
  ['Obrolan', 'Teknik FORD', 'Kalau kehabisan topik, ingat FORD: Family (keluarga), Occupation (pekerjaan), Recreation (hobi), Dreams (rencana). Hampir semua orang senang ditanya empat hal ini.'],
  ['Obrolan', 'Tangkap kata kunci', 'Dengarkan satu kata menarik dari jawabannya, lalu gali. "Akhir pekan saya ke Amed." Balas: "Amed! Snorkeling atau cuma santai?"'],
  ['Obrolan', 'Tanya, cerita, tanya', 'Setelah bertanya dan mendengar, ceritakan sedikit pengalamanmu yang mirip, lalu kembalikan dengan pertanyaan. Obrolan jadi dua arah, bukan wawancara.'],
  ['Obrolan', 'Beri kail di jawabanmu', 'Saat ditanya, jawab plus satu detail: "Iya, asli Karangasem. Kebetulan lagi belajar berkebun juga." Detail itu memberi lawan bicara bahan untuk bertanya.'],
  ['Obrolan', 'Reaksi kecil itu penting', 'Anggukan, "oh ya?", "terus?", atau mengulang kata terakhirnya menunjukkan kamu menyimak. Orang menilai teman ngobrol dari cara ia mendengar.'],
  ['Obrolan', 'Pujian yang spesifik', 'Puji pilihan atau usahanya, bukan hal umum. "Rapi banget presentasinya tadi, datanya jelas" lebih berkesan daripada "bagus".'],
  ['Obrolan', 'Jeda itu wajar', 'Diam 2–3 detik bukan tanda obrolan gagal. Tarik napas, lalu pakai FORD atau komentari situasi.'],
  ['Topik', 'Topik aman', 'Pekerjaan, hobi, makanan, tempat liburan, berita ringan lokal, olahraga, dan keluarga (kalau dia yang memulai).'],
  ['Topik', 'Hindari di awal', 'Gaji, politik, agama, berat badan, status pernikahan, dan gosip tentang orang lain. Tunggu sampai cukup dekat, atau biarkan dia yang memulai.'],
  ['Topik', 'Cari kesamaan', 'Kesamaan kecil (asal daerah, hobi, tempat makan favorit) cepat membangun kedekatan. Begitu ketemu, gali di situ.'],
  ['Topik', 'Baca lawan bicara', 'Jawaban pendek, mata ke HP, badan menghadap pintu: dia sedang sibuk, tutup dengan sopan. Jawaban panjang dan balik bertanya: lanjutkan.'],
  ['Topik', 'Siapkan 3 cerita pendek', 'Punya stok 3 cerita ringan berdurasi 1 menit: kejadian lucu di kerja, pengalaman jalan-jalan, hal baru yang kamu pelajari.'],
  ['Pengetahuan', 'Satu hal baru tiap hari', 'Satu fakta atau berita menarik per hari bisa jadi bahan obrolan. Simpan di Kelola bagian Fakta supaya ikut latihan.'],
  ['Penutup', 'Tutup dengan hangat', 'Sebut namanya dan singgung isi obrolan: "Senang ngobrol, Pak Wayan. Semoga lancar acara anaknya." Kesan terakhir paling diingat.'],
  ['Penutup', 'Pamit yang sopan', '"Saya ke sana dulu ya, Pak, tapi senang sekali tadi ngobrol soal kebun." Alasan singkat ditambah apresiasi.'],
  ['Tindak lanjut', 'Tanyakan kelanjutan', 'Di pertemuan berikutnya, tanyakan kelanjutan hal yang dia ceritakan. Cek kartunya sebelum ketemu. Ini yang membuat orang merasa diperhatikan.'],
  ['Kelompok', 'Masuk obrolan kelompok', 'Berdiri dekat, dengarkan dulu, tunggu jeda, lalu tambahkan sesuatu yang berkaitan dengan topik mereka, bukan membawa topik baru.'],
  ['Kelompok', 'Libatkan yang diam', 'Ajak orang yang belum bicara: "Kalau Bu Komang gimana, pernah ke sana?" Kamu akan diingat sebagai orang yang hangat.']
];

const SKENARIO_AWAL = [
  ['Kamu duduk di samping tamu dari Kanwil sambil menunggu rapat dimulai.',
    'Diam saja sambil main HP sampai rapat mulai.',
    '"Selamat pagi, Pak. Saya Agus dari Lapas Karangasem. Tadi berangkat dari Denpasar? Lancar jalannya?"',
    '"Bapak jabatannya apa di Kanwil?"', 'B',
    'Memperkenalkan diri dulu, lalu bertanya hal ringan yang pasti dialami tamu. Menanyakan jabatan di awal terasa seperti menilai status.'],
  ['Di acara keluarga, kamu bertemu kerabat jauh. Wajahnya ingat, namanya lupa.',
    'Menghindarinya sepanjang acara supaya tidak ketahuan lupa.',
    'Memanggilnya "Bli" terus supaya aman.',
    '"Eh, apa kabar! Lama nggak ketemu. Maaf, aku ingat wajahnya tapi lupa nama, siapa ya?"', 'C',
    'Jujur dengan ramah lebih baik daripada menghindar. Trik lain: kenalkan dia ke orang di sebelahmu, biasanya dia menyebut namanya sendiri.'],
  ['Pegawai baru bergabung di kantormu. Kalian bertemu di ruang makan.',
    '"Selamat datang ya. Saya Agus. Sudah dapat tempat tinggal di Karangasem, atau masih bolak-balik?"',
    '"Dari mana? Kenapa dipindah ke sini?"',
    'Tidak menyapa, nanti juga kenal sendiri.', 'A',
    'Menyambut, menyebut nama, dan menanyakan hal praktis yang sedang dipikirkan pendatang baru. "Kenapa dipindah" bisa terasa menyelidik.'],
  ['Kamu antre di bank. Orang di depanmu menghela napas karena antrean lama.',
    '"Ibu kerja di mana?"',
    '"Panjang ya, Bu. Biasanya jam segini memang ramai?"',
    '"Bank ini memang pelayanannya jelek."', 'B',
    'Menanggapi perasaan yang sedang dia tunjukkan dan situasi bersama, tanpa mengeluh. Kalau jawabannya pendek, cukup sampai di situ.'],
  ['Obrolan dengan rekan kerja berhenti dan terasa canggung setelah membahas cuaca.',
    'Diam dan menunggu dia bicara duluan.',
    '"Gaji di tempat Bli sekarang berapa?"',
    '"Ngomong-ngomong, akhir pekan kemarin ke mana, Bli?"', 'C',
    'Pindah ke huruf R di FORD (Recreation). Gaji termasuk topik sensitif di awal.'],
  ['Rekan bercerita bahwa anaknya baru masuk SMP.',
    '"Wah, sudah SMP! Gimana dia, semangat atau masih adaptasi?"',
    'Langsung bercerita panjang tentang anakmu sendiri.',
    '"Oh."', 'A',
    'Menangkap kata kunci lalu menggali perasaan dan pengalamannya, bukan langsung pindah ke cerita kita sendiri.'],
  ['Kamu bertemu kenalan yang dulu bercerita sedang membangun rumah.',
    '"Halo Pak, sehat?" lalu langsung pergi.',
    '"Rumah sekarang mahal ya bangunnya."',
    '"Pak, gimana rumahnya? Sudah sampai atap belum?"', 'C',
    'Menanyakan kelanjutan cerita lama adalah cara tercepat membuat orang merasa diperhatikan. Cek kartunya sebelum bertemu.'],
  ['Kamu ingin mengakhiri obrolan dengan tamu karena harus kembali bertugas.',
    'Langsung pergi saat dia masih bicara.',
    '"Senang sekali ngobrol, Pak Ketut. Saya pamit dulu, harus balik ke ruangan. Semoga lancar acaranya besok."',
    '"Sudah ya, Pak."', 'B',
    'Ada nama, alasan singkat, dan harapan baik terkait isi obrolan. Pamit terasa hangat, tidak terkesan kabur.'],
  ['Di acara banjar, kamu ingin bergabung dengan kelompok yang sedang membahas harga cabai.',
    '"Eh, sudah nonton bola semalam?"',
    'Mendekat, dengarkan sebentar, lalu: "Di pasar kemarin juga naik, Pak. Katanya karena hujan terus ya?"',
    'Berdiri di dekat mereka tanpa bicara sampai acara selesai.', 'B',
    'Masuk dengan menambahkan sesuatu pada topik yang sedang berjalan, bukan membawa topik baru.'],
  ['Lawan bicaramu hanya menjawab singkat: "Iya", "Lumayan".',
    'Terus bertanya lebih banyak supaya obrolan hidup.',
    '"Kok diam saja, Pak?"',
    '"Kelihatannya lagi sibuk ya, Pak. Nanti kita sambung lagi."', 'C',
    'Membaca tanda dan memberi jalan keluar justru meninggalkan kesan baik. Tidak semua orang siap ngobrol setiap saat.'],
  ['Seseorang memujimu: "Tanamannya subur, Bli."',
    '"Ah, biasa saja, jelek kok."',
    '"Terima kasih, Pak! Masih belajar, ini lagi coba seledri. Bapak suka berkebun juga?"',
    '"Terima kasih." lalu diam.', 'B',
    'Terima pujian (jangan ditolak), beri sedikit cerita sebagai kail, lalu kembalikan dengan pertanyaan.'],
  ['Kamu diperkenalkan ke tiga orang sekaligus.',
    'Mengangguk dan tersenyum saja.',
    '"Maaf, saya pasti lupa nama-nama ini."',
    '"Pak Gede, Bu Sari, Pak Nyoman, senang kenal semua." Lalu bertanya ke salah satunya sambil menyebut namanya.', 'C',
    'Mengulang semua nama saat dikenalkan memaksa otak menyimpannya. Setelah itu langsung catat di Kelola.']
];

const FAKTA_AWAL = [
  ['Geografi', 'Gunung tertinggi di Pulau Bali?', 'Gunung Agung', 'Terletak di Kabupaten Karangasem dan dianggap gunung suci oleh umat Hindu Bali.'],
  ['Geografi', 'Ibu kota Provinsi Kalimantan Utara?', 'Tanjung Selor', 'Kalimantan Utara adalah provinsi termuda di Pulau Kalimantan, berdiri tahun 2012.'],
  ['Geografi', 'Danau terbesar di Indonesia?', 'Danau Toba', 'Danau vulkanik di Sumatera Utara, dengan Pulau Samosir di tengahnya.'],
  ['Geografi', 'Selat yang memisahkan Pulau Bali dan Pulau Lombok?', 'Selat Lombok', 'Selat ini dilalui Garis Wallace, batas penyebaran fauna Asia dan Australia.'],
  ['Sejarah', 'Tahun berapa Sumpah Pemuda diikrarkan?', '1928', 'Diikrarkan pada 28 Oktober 1928 dalam Kongres Pemuda II di Batavia.'],
  ['Sejarah', 'Pahlawan nasional dari Bali yang gugur dalam Puputan Margarana?', 'I Gusti Ngurah Rai', 'Puputan Margarana terjadi pada 20 November 1946 di Tabanan. Bandara Bali memakai namanya.'],
  ['Sains', 'Planet terbesar di tata surya?', 'Jupiter', 'Jupiter adalah planet gas raksasa, kelima dari Matahari.'],
  ['Sains', 'Gas yang paling banyak di atmosfer Bumi?', 'Nitrogen', 'Sekitar 78% udara adalah nitrogen, oksigen sekitar 21%.'],
  ['Sains', 'Berapa jumlah tulang pada orang dewasa?', '206', 'Bayi lahir dengan lebih banyak tulang, sebagian menyatu seiring pertumbuhan.'],
  ['Budaya', 'Pura terbesar di Bali yang ada di lereng Gunung Agung?', 'Pura Besakih', 'Disebut juga Pura Agung Besakih, di Kabupaten Karangasem.'],
  ['Budaya', 'Apa makna Tri Hita Karana?', 'Tiga penyebab kebahagiaan: hubungan harmonis dengan Tuhan, sesama manusia, dan alam', 'Dalam bahasa Bali disebut parahyangan, pawongan, dan palemahan.'],
  ['Budaya', 'Sistem pengairan sawah tradisional Bali yang diakui UNESCO?', 'Subak', 'Lanskap budaya subak masuk Warisan Dunia UNESCO pada 2012.']
];
