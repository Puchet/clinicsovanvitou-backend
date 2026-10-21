'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env file */ }
const { initDb, close, query, queryOne, queryAll, tx, RES, CLINIC, dataDir } = require('./db');
const { hashPw, checkPw, sign, verify, initAuth } = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = process.env.PUBLIC_DIR || (fs.existsSync(path.resolve(__dirname, '../frontend')) ? path.resolve(__dirname, '../frontend') : path.join(__dirname, 'public'));
const UPLOADS = path.join(dataDir, 'uploads');
const IMG = ['photo', 'logo', 'qr', 'banner', 'image'];
const KINDS = ['vitals', 'medical', 'mdhistory', 'beu', 'schedule', 'payment', 'treatment', 'consultation', 'operation', 'investigation', 'lab', 'echo', 'xray', 'homecare', 'prescription', 'medlist', 'documents', 'mrd', 'schedulenote', 'cnf', 'allergy', 'vaccination', 'referral', 'diagnosis_history', 'laborder', 'imagingorder'];
const USES = [['medicines', 'photo'], ['doctors', 'photo'], ['patients', 'photo'], ['clinic', 'logo'], ['clinic', 'qr'], ['clinic', 'banner'], ['records', 'image']];
const PHOTO_RE = /^[a-f0-9]{32}\.(jpg|png|webp)$/;
const CORS = process.env.CORS_ORIGIN || '';
const tzh = Number.isFinite(Number(process.env.TZ_OFFSET_HOURS)) ? Number(process.env.TZ_OFFSET_HOURS) : 7;
const TZ = `${tzh >= 0 ? '+' : ''}${tzh} hours`;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new HttpError(400, m);

// ---------- helpers ----------
async function readJson(req, max = 1e6) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new HttpError(413, 'Request too large');
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw bad('Invalid JSON'); }
}
async function readRaw(req, max, message = 'Picture is too large (max 2 MB)') {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new HttpError(413, message);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
// delete a picture file once no record uses it any more
async function dropFile(name) {
  if (!name || !PHOTO_RE.test(name)) return;
  for (const [t, c] of USES) {
    const used = await queryOne(`SELECT 1 FROM "${t}" WHERE "${c}"=$1 LIMIT 1`, [name]);
    if (used) return;
  }
  fs.rm(path.join(UPLOADS, name), { force: true }, () => {});
}
function send(res, status, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(data);
}
function clean(name, body, partial, spec = RES[name]) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Body must be a JSON object');
  const out = {};
  for (const [c, t] of Object.entries(spec.cols)) {
    const req = t.endsWith('!'), kind = t[0];
    if (!(c in body)) { if (req && !partial) throw bad(`${c} is required`); continue; }
    let v = body[c];
    if (kind === 's' || kind === 'x' || kind === 'j') {
      if (kind === 'j' && typeof v === 'object' && v !== null && !Array.isArray(v)) v = JSON.stringify(v);
      else if (typeof v !== 'string') v = v == null ? '' : String(v);
      v = v.trim();
      const max = kind === 'j' ? 60000 : kind === 'x' ? 10000 : 255;
      if (v.length > max) throw bad(`${c} is too long (max ${max})`);
      if (req && !v) throw bad(`${c} cannot be empty`);
      if (IMG.includes(c) && v && !PHOTO_RE.test(v)) throw bad(`${c} is not a valid picture filename`);
      if (kind === 'j') {
        if (!v) v = '{}';
        try { const o = JSON.parse(v); if (!o || typeof o !== 'object' || Array.isArray(o)) throw 1; } catch { throw bad(`${c} must be valid JSON object`); }
      }
      out[c] = v;
    } else if (kind === 'i') {
      if (v === '' || v == null) v = 0;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 2e9) throw bad(`${c} must be a positive integer`);
      out[c] = n;
    } else if (kind === 'b') {
      out[c] = v ? 1 : 0;
    }
  }
  if (!name) {
    if ('currency' in out && !['KHR', 'USD'].includes(out.currency)) throw bad('currency must be KHR or USD');
    if ('rate' in out && (out.rate < 100 || out.rate > 100000)) throw bad('rate is not valid');
  }
  if (name === 'patients') {
    if ('type' in out && !['OPD', 'IPD'].includes(out.type)) throw bad('type must be OPD or IPD');
    if ('age' in out && out.age > 150) throw bad('age is not valid');
    if ('age_unit' in out && !['', 'Y', 'M', 'D'].includes(out.age_unit)) throw bad('age_unit must be Y, M or D');
  }
  if (name === 'medicines') {
    for (const key of ['expiration_date', 'notification_date']) {
      if (key in out && out[key]) {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(out[key]) ? new Date(out[key] + 'T00:00:00Z') : null;
        if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== out[key]) throw bad(`${key} must be a valid date`);
      }
    }
    if ('units' in out) {
      let units;
      try { units = JSON.parse(out.units || '[]'); } catch { throw bad('units must be a valid list'); }
      if (!Array.isArray(units) || units.length > 20) throw bad('units must contain up to 20 sales units');
      units = units.map((unit) => {
        if (!unit || typeof unit !== 'object' || Array.isArray(unit)) throw bad('Each sales unit must be an object');
        const unitName = String(unit.name || '').trim(), price = Number(unit.price), qty = Number(unit.qty);
        if (!unitName || unitName.length > 60) throw bad('Sales unit name is required (max 60 characters)');
        if (!Number.isInteger(price) || price < 0 || price > 2e9) throw bad('Sales unit price must be a whole number');
        if (!Number.isInteger(qty) || qty < 1 || qty > 2e9) throw bad('Sales unit quantity must be a positive whole number');
        return { name: unitName, price, qty };
      });
      out.units = JSON.stringify(units);
    }
  }
  if (name === 'records') {
    if ('kind' in out && !KINDS.includes(out.kind)) throw bad('kind is not valid');
    if ('color' in out && out.color && !/^#[0-9a-fA-F]{6}$/.test(out.color)) throw bad('color is not valid');
  }
  return out;
}
async function importServices(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw bad('rows must contain 1–1000 services');
  const services = rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !('price' in row)) throw bad('Each service must include a name and price');
    return clean('services', row, false);
  });
  await tx(async (client) => {
    for (const service of services) {
      await client.query('INSERT INTO services(name,price,description) VALUES($1,$2,$3)', [
        service.name, service.price ?? 0, service.description ?? '',
      ]);
    }
  });
  return services.length;
}
async function importMedicines(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw bad('rows must contain 1–1,000 medicines');
  const money = (value, label) => {
    if (value == null || value === '') return 0;
    const normalized = typeof value === 'string' ? value.trim().replace(/(?:KHR|៛|RIEL)/gi, '').replace(/[,\s$]/g, '') : value;
    const amount = Number(normalized);
    if (!Number.isInteger(amount) || amount < 0 || amount > 2e9) throw bad(`${label} must be a whole KHR amount between 0 and 2,000,000,000`);
    return amount;
  };
  const dateValue = (value) => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2958465) return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
    return value;
  };
  const medicines = rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw bad('Each medicine must be an object');
    try {
      let units, firstUnit;
      if (row.units) {
        try { units = JSON.parse(row.units); } catch { throw bad('units must be a valid list'); }
        if (!Array.isArray(units)) throw bad('units must be a valid list');
        units = units.map((unit) => ({ ...unit, price: money(unit.price, 'Sales unit price') }));
        firstUnit = units[0];
      }
      const price = row.price == null || row.price === '' ? firstUnit?.price ?? 0 : money(row.price, 'Price');
      return clean('medicines', {
        stock: 0, ...row, price,
        units: units ? JSON.stringify(units) : row.units,
        expiration_date: dateValue(row.expiration_date),
        notification_date: dateValue(row.notification_date),
      }, false);
    } catch (error) {
      if (error instanceof HttpError) throw bad(`Row ${row.rowNumber || '?'}: ${error.message}`);
      throw error;
    }
  });
  await tx(async (client) => {
    for (const medicine of medicines) {
      await client.query(`INSERT INTO medicines(name,composition,price,stock,photo,units,expiration_date,notification_date)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [
        medicine.name, medicine.composition ?? '', medicine.price ?? 0, medicine.stock ?? 0,
        medicine.photo ?? '', medicine.units ?? '', medicine.expiration_date ?? '', medicine.notification_date ?? '',
      ]);
    }
  });
  return medicines.length;
}

const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const userCount = async () => Number((await queryOne('SELECT COUNT(*)::int n FROM users'))?.n || 0);

// Simple in-memory brute-force guard: 10 failed logins / 15 min per ip+email
const fails = new Map();
function throttle(key) {
  const f = fails.get(key);
  if (f && f.reset > Date.now() && f.n >= 10) throw new HttpError(429, 'Too many attempts. Try again later.');
}
function fail(key) {
  const f = fails.get(key);
  if (!f || f.reset < Date.now()) fails.set(key, { n: 1, reset: Date.now() + 15 * 60e3 }); else f.n++;
}
const DUMMY = '00000000000000000000000000000000:' + '00'.repeat(64);

// ---------- API ----------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
  const [a, b, c, d] = parts, m = req.method;
  const ip = req.socket.remoteAddress;

  if (a === 'health') return send(res, 200, { ok: true });
  if (a === 'auth' && b === 'status' && m === 'GET') return send(res, 200, { needsSetup: (await userCount()) === 0 });

  if (a === 'auth' && (b === 'setup' || b === 'login') && m === 'POST') {
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase(), password = String(body.password || '');
    if (b === 'setup') {
      if ((await userCount()) > 0) throw new HttpError(403, 'Setup already completed');
      if (!isEmail(email)) throw bad('Enter a valid email');
      if (password.length < 8) throw bad('Password must be at least 8 characters');
      await query('INSERT INTO users(email,name,role,pass) VALUES($1,$2,$3,$4)',
        [email, String(body.name || email.split('@')[0]).slice(0, 100), 'admin', await hashPw(password)]);
      return send(res, 201, { ok: true });
    }
    const key = ip + '|' + email;
    throttle(key);
    const u = await queryOne('SELECT * FROM users WHERE email=$1', [email]);
    const ok = await checkPw(password, u ? u.pass : DUMMY);
    if (!u || !ok) { fail(key); throw new HttpError(401, 'Wrong email or password'); }
    fails.delete(key);
    return send(res, 200, { token: sign({ uid: u.id }), user: { id: u.id, email: u.email, name: u.name, role: u.role } });
  }

  // everything below needs a valid token
  const tok = verify((req.headers.authorization || '').replace(/^Bearer /, ''));
  const user = tok && (await queryOne('SELECT id,email,name,role FROM users WHERE id=$1', [tok.uid]));
  if (!user) throw new HttpError(401, 'Sign in required');
  const admin = () => { if (user.role !== 'admin') throw new HttpError(403, 'Admin only'); };

  if (a === 'auth' && b === 'me' && m === 'GET') return send(res, 200, user);

  if (a === 'auth' && b === 'password' && m === 'POST') {
    const body = await readJson(req), key = 'pw|' + user.id;
    throttle(key);
    const u = await queryOne('SELECT pass FROM users WHERE id=$1', [user.id]);
    if (!(await checkPw(String(body.current || ''), u.pass))) { fail(key); throw new HttpError(403, 'Current password is wrong'); }
    if (String(body.password || '').length < 8) throw bad('Password must be at least 8 characters');
    await query('UPDATE users SET pass=$1 WHERE id=$2', [await hashPw(String(body.password)), user.id]);
    fails.delete(key);
    return send(res, 200, { ok: true });
  }

  if (a === 'medicines' && c === 'code' && ['qr', 'barcode'].includes(d) && m === 'GET') {
    const id = Number(b);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(404, 'Not found');
    const medicine = await queryOne('SELECT id,name,composition FROM medicines WHERE id=$1', [id]);
    if (!medicine) throw new HttpError(404, 'Medicine not found');
    const svg = d === 'qr'
      ? await QRCode.toString(JSON.stringify({ id: medicine.id, name: medicine.name, composition: medicine.composition }), { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 256 })
      : bwipjs.toSVG({ bcid: 'code128', text: String(medicine.id), scale: 3, height: 15, includetext: true, textxalign: 'center' });
    return send(res, 200, { svg });
  }

  if (a === 'export' && b === 'xlsx' && m === 'POST') {
    const body = await readJson(req, 10e6);
    if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 5000) throw bad('rows must contain 1–5,000 records');
    const columns = Object.keys(body.rows[0]);
    if (!columns.length || columns.length > 100 || columns.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw bad('Invalid export columns');
    if (body.rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) throw bad('Each export row must be an object');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Export');
    sheet.columns = columns.map((key) => ({ header: key, key }));
    for (const row of body.rows) {
      sheet.addRow(Object.fromEntries(columns.map((key) => {
        let value = row[key];
        if (typeof value === 'string' && /^[=+\-@\t\r]/.test(value)) value = "'" + value;
        return [key, value ?? ''];
      })));
    }
    const data = Buffer.from(await workbook.xlsx.writeBuffer());
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="export.xlsx"',
      'Cache-Control': 'no-store',
      'Content-Length': data.length,
    });
    return res.end(data);
  }

  if (a === 'clinic' && !b) {
    const row = () => queryOne('SELECT * FROM clinic WHERE id=1');
    if (m === 'GET') return send(res, 200, await row());
    if (m === 'PUT') {
      admin();
      const d = clean(null, await readJson(req), true, CLINIC), cols = Object.keys(d);
      if (!cols.length) throw bad('Nothing to update');
      const old = await row();
      await query(`UPDATE clinic SET ${cols.map((x, i) => `"${x}"=$${i + 1}`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=1`, cols.map((x) => d[x]));
      for (const k of ['logo', 'qr', 'banner']) if (k in d && old[k] !== d[k]) await dropFile(old[k]);
      return send(res, 200, await row());
    }
  }

  if (a === 'users') {
    admin();
    if (!b && m === 'GET') return send(res, 200, await queryAll('SELECT id,email,name,role,created_at FROM users ORDER BY id'));
    if (!b && m === 'POST') {
      const body = await readJson(req), email = String(body.email || '').trim().toLowerCase();
      if (!isEmail(email)) throw bad('Enter a valid email');
      if (String(body.password || '').length < 8) throw bad('Password must be at least 8 characters');
      if (!['admin', 'staff'].includes(body.role || 'staff')) throw bad('role must be admin or staff');
      if (await queryOne('SELECT 1 FROM users WHERE email=$1', [email])) throw new HttpError(409, 'Email already in use');
      const r = await queryOne('INSERT INTO users(email,name,role,pass) VALUES($1,$2,$3,$4) RETURNING id',
        [email, String(body.name || email.split('@')[0]).slice(0, 100), body.role || 'staff', await hashPw(String(body.password))]);
      return send(res, 201, { id: r.id, email });
    }
    if (b && m === 'DELETE') {
      if (Number(b) === user.id) throw bad('You cannot delete your own account');
      const r = await query('DELETE FROM users WHERE id=$1', [Number(b)]);
      if (!r.rowCount) throw new HttpError(404, 'Not found');
      return send(res, 200, { ok: true });
    }
  }

  if (a === 'sales' && !b && m === 'POST') {
    const body = await readJson(req);
    if (!['Cash', 'Bank'].includes(body.method)) throw bad('method must be Cash or Bank');
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) throw bad('items must be a list of 1–100 lines');
    const want = new Map();
    for (const it of body.items) {
      const id = Number(it && it.medicine_id), qty = Number(it && it.qty);
      if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > 10000) throw bad('Invalid item');
      want.set(id, (want.get(id) || 0) + qty);
    }
    const sale = await tx(async (client) => {
      let total = 0; const lines = [];
      for (const [id, qty] of want) {
        const medRes = await client.query('SELECT name,price FROM medicines WHERE id=$1', [id]);
        const med = medRes.rows[0];
        if (!med) throw new HttpError(404, 'Medicine not found');
        const r = await client.query('UPDATE medicines SET stock=stock+$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND stock>=$3', [-qty, id, qty]);
        if (!r.rowCount) throw new HttpError(409, `Not enough stock for ${med.name}`);
        total += med.price * qty; lines.push({ medicine_id: id, name: med.name, qty, price: med.price });
      }
      const s = await client.query('INSERT INTO sales(total,method,user_id) VALUES($1,$2,$3) RETURNING id', [total, body.method, user.id]);
      const sid = s.rows[0].id;
      for (const l of lines) await client.query('INSERT INTO sale_items(sale_id,medicine_id,name,qty,price) VALUES($1,$2,$3,$4,$5)', [sid, l.medicine_id, l.name, l.qty, l.price]);
      return { id: sid, total, method: body.method, items: lines };
    });
    return send(res, 201, sale);
  }
  if (a === 'sales' && !b && m === 'GET') {
    return send(res, 200, await queryAll('SELECT * FROM sales ORDER BY id DESC LIMIT 200'));
  }

  if (a === 'reports' && b === 'daily' && m === 'GET') {
    const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days')) || 30));
    const rows = await queryAll(`SELECT TO_CHAR(created_at + ($1 || ' hours')::interval, 'YYYY-MM-DD') AS "day",COUNT(*)::int AS n,COALESCE(SUM(total),0)::int AS amt FROM sales
      WHERE created_at >= (NOW() - ($2 || ' days')::interval) GROUP BY TO_CHAR(created_at + ($1 || ' hours')::interval, 'YYYY-MM-DD') ORDER BY 1 DESC`, [String(tzh), String(days)]);
    return send(res, 200, rows);
  }
  if (a === 'dashboard' && m === 'GET') {
    const pCount = (await queryOne('SELECT COUNT(*)::int n FROM patients'))?.n || 0;
    const apptCount = (await queryOne("SELECT COUNT(*)::int n FROM appointments WHERE date = TO_CHAR(NOW() + ($1 || ' hours')::interval, 'YYYY-MM-DD')", [String(tzh)]))?.n || 0;
    const revToday = (await queryOne("SELECT COALESCE(SUM(total),0)::int n FROM sales WHERE TO_CHAR(created_at + ($1 || ' hours')::interval, 'YYYY-MM-DD') = TO_CHAR(NOW() + ($1 || ' hours')::interval, 'YYYY-MM-DD')", [String(tzh)]))?.n || 0;
    const ipdCount = (await queryOne('SELECT COUNT(*)::int n FROM ipd WHERE "out"=0'))?.n || 0;
    return send(res, 200, {
      patients: pCount,
      appointmentsToday: apptCount,
      revenueToday: revToday,
      ipdCurrent: ipdCount,
    });
  }

  if (a === 'uploads' && !b && m === 'POST') {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type];
    if (!ext) throw new HttpError(415, 'Use a JPG, PNG or WebP picture');
    const buf = await readRaw(req, 2e6);
    const magic = ext === 'jpg' ? buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
      : ext === 'png' ? buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
    if (!magic) throw bad('File is not a valid picture');
    const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
    fs.mkdirSync(UPLOADS, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS, name), buf);
    return send(res, 201, { photo: name });
  }

  if (a === 'services' && b === 'import' && m === 'POST') {
    const body = await readJson(req);
    return send(res, 201, { imported: await importServices(body.rows) });
  }

  if (a === 'services' && b === 'import-xlsx' && m === 'POST') {
    const buffer = await readRaw(req, 1e6, 'Excel workbook is too large (max 1 MB)');
    let workbook;
    try { workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer); }
    catch { throw bad('Invalid Excel workbook'); }
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount < 2) throw bad('Excel workbook must include a header and at least one service');
    if (sheet.rowCount > 1001) throw bad('Excel workbook can contain up to 1,000 services');
    const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const headers = sheet.getRow(1).values.slice(1).map(normalize);
    const find = (...names) => headers.findIndex((header) => names.includes(header));
    const nameIndex = find('name', 'servicename', 'service'), priceIndex = find('price', 'pricekhr', 'amount'), descriptionIndex = find('description', 'details');
    if (nameIndex < 0 || priceIndex < 0) throw bad('Excel workbook needs name and price columns');
    const rows = [];
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
      const values = sheet.getRow(rowNumber).values.slice(1);
      if (!values.some((value) => value != null && String(value).trim())) continue;
      rows.push({
        name: values[nameIndex] ?? '',
        price: values[priceIndex] ?? '',
        description: descriptionIndex < 0 ? '' : values[descriptionIndex] ?? '',
      });
    }
    return send(res, 201, { imported: await importServices(rows) });
  }

  if (a === 'medicines' && b === 'import-xlsx' && m === 'POST') {
    const buffer = await readRaw(req, 1e6, 'Excel workbook is too large (max 1 MB)');
    let workbook;
    try { workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer); }
    catch { throw bad('Invalid Excel workbook'); }
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount < 2) throw bad('Excel workbook must include a header and at least one medicine');
    if (sheet.rowCount > 1001) throw bad('Excel workbook can contain up to 1,000 medicines');
    const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const headers = sheet.getRow(1).values.slice(1).map(normalize);
    const find = (...names) => headers.findIndex((header) => names.includes(header));
    const columns = {
      name: find('name', 'drugname', 'medicine', 'medicinename'),
      composition: find('composition', 'strength'),
      price: find('price', 'pricekhr', 'unitprice'),
      stock: find('stock', 'instock', 'quantity', 'qty'),
      units: find('units', 'salesunits'),
      expiration_date: find('expirationdate', 'expirydate', 'expiry'),
      notification_date: find('notificationdate', 'notifydate', 'reminderdate'),
    };
    if (columns.name < 0) throw bad('Excel workbook needs a medicine name column');
    const rows = [];
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
      const values = sheet.getRow(rowNumber).values.slice(1);
      if (!values.some((value) => value != null && String(value).trim())) continue;
      const row = { rowNumber };
      for (const [key, index] of Object.entries(columns)) {
        if (index < 0 || values[index] == null) continue;
        row[key] = key == 'units' && typeof values[index] != 'string' ? JSON.stringify(values[index]) : values[index];
      }
      rows.push(row);
    }
    return send(res, 201, { imported: await importMedicines(rows) });
  }

  // generic CRUD: /api/<resource>[/<id>]
  if (Object.hasOwn(RES, a)) {
    const R = RES[a], names = Object.keys(R.cols);
    const id = b === undefined ? null : Number(b);
    if (b !== undefined && (!Number.isInteger(id) || c !== undefined)) throw new HttpError(404, 'Not found');
    const withUser = (o) => { if (a === 'chat') o.user_id = user.id; if (a === 'records') o.created_by = user.id; return o; };
    const validateResource = async (d, creating) => {
      if (a === 'doctors' && d.code) {
        const duplicate = await queryOne('SELECT id FROM doctors WHERE code=$1 AND id<>$2', [d.code, id || 0]);
        if (duplicate) throw new HttpError(409, 'Staff ID already exists');
      }
      if (a === 'payslips') {
        const doctorId = d.doctor_id;
        if (creating && !doctorId) throw bad('doctor_id is required');
        if (doctorId && !(await queryOne('SELECT 1 FROM doctors WHERE id=$1', [doctorId]))) throw bad('Doctor not found');
        if ('period_month' in d && (d.period_month < 1 || d.period_month > 12)) throw bad('period_month must be between 1 and 12');
        if ('period_year' in d && (d.period_year < 2000 || d.period_year > 2100)) throw bad('period_year is not valid');
        const existing = id ? await queryOne('SELECT doctor_id,period_month,period_year,date_start,date_end,basic_cents,position_allowance_cents,overtime_cents,benefits_cents,deduction_cents FROM payslips WHERE id=$1', [id]) : null;
        const doctor = doctorId || (existing && existing.doctor_id), month = d.period_month || (existing && existing.period_month), year = d.period_year || (existing && existing.period_year);
        if (month && year && ('date_start' in d || 'date_end' in d || creating)) {
          const start = d.date_start || (existing && existing.date_start), end = d.date_end || (existing && existing.date_end);
          const prefix = `${year}-${String(month).padStart(2, '0')}-`;
          if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end || !start.startsWith(prefix) || !end.startsWith(prefix)) throw bad('Payslip date range must be within the selected month');
        }
        if (doctor && month && year) {
          const duplicate = await queryOne('SELECT id FROM payslips WHERE doctor_id=$1 AND period_month=$2 AND period_year=$3 AND id<>$4', [doctor, month, year, id || 0]);
          if (duplicate) throw bad('A payslip already exists for this month');
        }
        if (creating || existing) {
          const amount = (key) => key in d ? d[key] : existing[key];
          if (amount('deduction_cents') > amount('basic_cents') + amount('position_allowance_cents') + amount('overtime_cents') + amount('benefits_cents')) throw bad('deduction_cents cannot exceed total earnings');
        }
      }
    };
    const needPatient = async (d, must) => {
      if (a !== 'records') return;
      if (must && !d.patient_id) throw bad('patient_id is required');
      if ('patient_id' in d && !(await queryOne('SELECT 1 FROM patients WHERE id=$1', [d.patient_id]))) throw bad('Patient not found');
    };

    if (id === null && m === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
      const limit = Math.min(5000, Math.max(1, parseInt(url.searchParams.get('limit')) || 1000));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset')) || 0);
      const conds = [], params = [];
      let pIdx = 1;
      if (q) {
        conds.push('(' + R.search.map((c) => `"${c}" ILIKE $${pIdx++}`).join(' OR ') + ')');
        const escaped = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
        R.search.forEach(() => params.push(escaped));
      }
      for (const [key, val] of url.searchParams) {
        if (!names.includes(key) || ['data', 'notes', 'complaints', 'history'].includes(key)) continue;
        conds.push(`"${key}"=$${pIdx++}`);
        params.push(R.cols[key][0] === 'i' || R.cols[key][0] === 'b' ? Number(val) : val);
      }
      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const totalRow = await queryOne(`SELECT COUNT(*)::int n FROM "${a}" ${where}`, params);
      const total = totalRow ? totalRow.n : 0;
      const rows = await queryAll(`SELECT * FROM "${a}" ${where} ORDER BY ${R.order} LIMIT $${pIdx++} OFFSET $${pIdx++}`, [...params, limit, offset]);
      return send(res, 200, rows, { 'X-Total-Count': String(total) });
    }
    if (id === null && m === 'POST') {
      const d = withUser(clean(a, await readJson(req), false));
      await validateResource(d, true);
      await needPatient(d, true);
      const cols = Object.keys(d);
      const params = cols.map((x) => d[x]);
      const sql = `INSERT INTO "${a}"(${cols.map((x) => `"${x}"`).join(',')}) VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`;
      const created = await queryOne(sql, params);
      return send(res, 201, created);
    }
    if (id !== null && m === 'GET') {
      const row = await queryOne(`SELECT * FROM "${a}" WHERE id=$1`, [id]);
      if (!row) throw new HttpError(404, 'Not found');
      return send(res, 200, row);
    }
    if (id !== null && m === 'PUT') {
      const d = withUser(clean(a, await readJson(req), true));
      await validateResource(d, false);
      await needPatient(d, false);
      if (a === 'chat') admin();
      const cols = Object.keys(d).filter((x) => names.includes(x));
      if (!cols.length) throw bad('Nothing to update');
      const imgs = names.filter((n) => IMG.includes(n));
      const old = imgs.length ? await queryOne(`SELECT ${imgs.map((q) => `"${q}"`).join(',')} FROM "${a}" WHERE id=$1`, [id]) : null;
      const params = [...cols.map((x) => d[x]), id];
      const sql = `UPDATE "${a}" SET ${cols.map((x, i) => `"${x}"=$${i + 1}`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=$${cols.length + 1} RETURNING *`;
      const updated = await queryOne(sql, params);
      if (!updated) throw new HttpError(404, 'Not found');
      if (old) for (const k of imgs) if (k in d && old[k] !== d[k]) await dropFile(old[k]);
      return send(res, 200, updated);
    }
    if (id !== null && m === 'DELETE') {
      if (a === 'doctors' && await queryOne('SELECT 1 FROM payslips WHERE doctor_id=$1 LIMIT 1', [id])) throw new HttpError(409, 'Delete the doctor’s payslips before deleting the doctor');
      if (a === 'records') {
        const row = await queryOne('SELECT created_by FROM records WHERE id=$1', [id]);
        if (row && user.role !== 'admin' && row.created_by !== user.id) throw new HttpError(403, 'Only the author or an admin can delete this record');
      } else admin();
      const imgs = names.filter((n) => IMG.includes(n));
      const old = imgs.length ? await queryOne(`SELECT ${imgs.map((q) => `"${q}"`).join(',')} FROM "${a}" WHERE id=$1`, [id]) : null;
      const recImgs = a === 'patients' ? (await queryAll("SELECT image FROM records WHERE patient_id=$1 AND image<>''", [id])).map((x) => x.image) : [];
      if (a === 'patients') await query('DELETE FROM records WHERE patient_id=$1', [id]);
      const r = await query(`DELETE FROM "${a}" WHERE id=$1`, [id]);
      if (!r.rowCount) throw new HttpError(404, 'Not found');
      if (old) for (const k of imgs) await dropFile(old[k]);
      for (const img of recImgs) await dropFile(img);
      return send(res, 200, { ok: true });
    }
    throw new HttpError(405, 'Method not allowed');
  }
  throw new HttpError(404, 'Not found');
}

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function serve(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel; try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end(); }
  const file = path.resolve(PUBLIC, '.' + (rel.endsWith('/') ? rel + 'index.html' : rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ['.html', '.js', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=3600' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

function serveUpload(res, name) {
  if (!PHOTO_RE.test(name)) { res.writeHead(404); return res.end(); }
  fs.readFile(path.join(UPLOADS, name), (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    const type = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[name.split('.')[1]];
    if (CORS) res.setHeader('Access-Control-Allow-Origin', CORS);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' *; frame-ancestors 'none'");
  if (CORS) {
    res.setHeader('Access-Control-Allow-Origin', CORS);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (url.pathname.startsWith('/uploads/') && req.method === 'GET') serveUpload(res, url.pathname.slice(9));
    else serve(req, res, url.pathname);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message }, e.status === 413 ? { Connection: 'close' } : {});
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

if (require.main === module) {
  initDb().then(async () => {
    await initAuth();
    server.listen(PORT, HOST, () => console.log(`Sovanvitou running at http://${HOST}:${PORT}`));
    const stop = () => server.close(async () => { await close(); process.exit(0); });
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  }).catch((err) => {
    if (err.code === '28P01') {
      console.error('\n❌ [PostgreSQL Error]: Password authentication failed for user "' + (process.env.PGUSER || 'postgres') + '".');
      console.error('👉 សូមបើក file "backend/.env" រួចកែប្រែ PGPASSWORD ឱ្យត្រូវនឹង Password របស់ PostgreSQL របស់អ្នក៖');
      console.error('   PGPASSWORD=your_actual_password\n');
    } else if (err.code === '3D000') {
      console.error('\n❌ [PostgreSQL Error]: Database "' + (process.env.PGDATABASE || 'sovanvitou') + '" does not exist.');
      console.error('👉 សូមបង្កើត Database ក្នុង PostgreSQL ដោយប្រើ command: CREATE DATABASE sovanvitou;\n');
    } else if (err.code === 'ECONNREFUSED') {
      console.error('\n❌ [PostgreSQL Error]: Could not connect to PostgreSQL server at ' + (process.env.PGHOST || '127.0.0.1') + ':' + (process.env.PGPORT || 5432) + '.');
      console.error('👉 សូមពិនិត្យមើលថាតើ PostgreSQL Service កំពុងដំណើរការដែរឬទេ។\n');
    } else {
      console.error('Failed to initialize database:', err);
    }
    process.exit(1);
  });
}
module.exports = { server };
