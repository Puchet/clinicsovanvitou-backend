'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');
const { createWorker } = require('tesseract.js');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env file */ }
const { initDb, close, query, queryOne, queryAll, tx, RES, CLINIC, dataDir } = require('./db');
const { hashPw, checkPw, sign, verify, initAuth } = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = process.env.PUBLIC_DIR || (fs.existsSync(path.resolve(__dirname, '../frontend')) ? path.resolve(__dirname, '../frontend') : path.join(__dirname, 'public'));
const UPLOADS = path.join(dataDir, 'uploads');
const IMG = ['photo', 'logo', 'qr', 'banner', 'footer_banner', 'image'];
const KINDS = ['vitals', 'medical', 'mdhistory', 'beu', 'schedule', 'payment', 'treatment', 'consultation', 'operation', 'investigation', 'lab', 'echo', 'xray', 'homecare', 'prescription', 'medlist', 'documents', 'mrd', 'schedulenote', 'cnf', 'allergy', 'vaccination', 'referral', 'diagnosis_history', 'laborder', 'imagingorder'];
const USES = [['medicines', 'photo'], ['doctors', 'photo'], ['patients', 'photo'], ['clinic', 'logo'], ['clinic', 'qr'], ['clinic', 'banner'], ['clinic', 'footer_banner'], ['records', 'image']];
const PHOTO_RE = /^[a-f0-9]{32}\.(jpg|png|webp)$/;
const CORS = process.env.CORS_ORIGIN || '';
const tzh = Number.isFinite(Number(process.env.TZ_OFFSET_HOURS)) ? Number(process.env.TZ_OFFSET_HOURS) : 7;
const TZ = `${tzh >= 0 ? '+' : ''}${tzh} hours`;
let ocrWorkerPromise = null;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const isISODate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

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
const medicineCodeSvg = (medicine, kind) => kind === 'qr'
  ? QRCode.toString(JSON.stringify({ id: medicine.id, name: medicine.name, composition: medicine.composition }), { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 256 })
  : bwipjs.toSVG({ bcid: 'code128', text: String(medicine.id), scale: 3, height: 15, includetext: true, textxalign: 'center' });
const patientPortalTokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const escapeXml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
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
      const max = kind === 'j' ? 60000 : kind === 'x' ? (name === 'echo' && c === 'sections' ? 500000 : name === 'files' && c === 'content' ? 100000 : 10000) : 255;
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
    if ('print_template' in out) {
      let template;
      try { template = JSON.parse(out.print_template); } catch { throw bad('print_template must be a valid template object'); }
      if (!template || typeof template !== 'object' || Array.isArray(template)) throw bad('print_template must be a valid template object');
      const allowed = ['paperSize', 'orientation', 'marginMm', 'fontFamily', 'fontSizePt', 'elements'];
      if (Object.keys(template).some((key) => !allowed.includes(key))) throw bad('print_template contains an unsupported setting');
      const paperSize = template.paperSize ?? 'form', orientation = template.orientation ?? 'auto';
      const marginMm = template.marginMm == null || template.marginMm === '' ? null : Number(template.marginMm);
      const fontFamily = template.fontFamily ?? 'system', fontSizePt = template.fontSizePt == null || template.fontSizePt === '' ? null : Number(template.fontSizePt);
      if (!['form', 'A4', 'A5', 'Letter'].includes(paperSize)) throw bad('print_template paper size is not valid');
      if (!['auto', 'portrait', 'landscape'].includes(orientation)) throw bad('print_template orientation is not valid');
      if (marginMm !== null && ![5, 8, 10, 12, 15, 20].includes(marginMm)) throw bad('print_template margin is not valid');
      if (!['system', 'inter', 'arial', 'khmer'].includes(fontFamily)) throw bad('print_template font is not valid');
      if (fontSizePt !== null && ![8, 9, 10, 11, 12, 14, 16, 18].includes(fontSizePt)) throw bad('print_template font size is not valid');
      const validColumns = ['item', 'description', 'qty', 'each', 'vat', 'total'];
      const elements = template.elements ?? [];
      if (!Array.isArray(elements) || elements.length > 40) throw bad('print_template must contain up to 40 items');
      const ids = new Set();
      const safeElements = elements.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw bad('Each print template item must be an object');
        const itemKeys = ['id', 'type', 'zone', 'field', 'text', 'x', 'y', 'width', 'height', 'fontSize', 'bold', 'align', 'color', 'background', 'border', 'columns', 'condition'];
        if (Object.keys(item).some((key) => !itemKeys.includes(key))) throw bad('Print template item contains an unsupported setting');
        const { id, type, zone = 'header' } = item;
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ids.has(id)) throw bad('Print template item ID is not valid');
        ids.add(id);
        if (!['label', 'field', 'line', 'vline', 'image', 'table', 'summary', 'tax'].includes(type)) throw bad('Print template item type is not valid');
        if (!['header', 'footer'].includes(zone)) throw bad('Print template item section is not valid');
        const field = item.field ?? (type === 'image' ? 'clinicLogo' : 'customText');
        if (!['customText', 'clinicName', 'documentTitle', 'currentDate', 'clinicAddress', 'clinicPhone', 'clinicLogo'].includes(field)) throw bad('Print template item field is not valid');
        const text = String(item.text ?? '');
        if (text.length > 255) throw bad('Print template item text is too long');
        const position = (key, minimum, fallback) => {
          const value = Number(item[key] ?? fallback);
          if (!Number.isInteger(value) || value < minimum || value > 100) throw bad(`Print template item ${key} is not valid`);
          return value;
        };
        const x = position('x', 0, 0), y = position('y', 0, 0);
        const width = position('width', 5, 30), height = position('height', 5, 20);
        if (x + width > 100 || y + height > 100) throw bad('Print template item must fit inside its section');
        const fontSize = Number(item.fontSize ?? 10);
        if (![8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48].includes(fontSize)) throw bad('Print template item font size is not valid');
        const color = item.color ?? '#111827', background = item.background ?? 'transparent';
        if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw bad('Print template item color is not valid');
        if (typeof background !== 'string' || (background !== 'transparent' && !/^#[0-9a-f]{6}$/i.test(background))) throw bad('Print template item fill is not valid');
        const align = item.align ?? 'left';
        if (!['left', 'center', 'right'].includes(align)) throw bad('Print template item alignment is not valid');
        const condition = item.condition ?? 'always';
        if (!['always', 'hasLogo', 'hasClinicAddress'].includes(condition)) throw bad('Print template item condition is not valid');
        if (item.bold != null && typeof item.bold !== 'boolean') throw bad('Print template item bold setting is not valid');
        if (item.border != null && typeof item.border !== 'boolean') throw bad('Print template item border setting is not valid');
        const columns = item.columns ?? [];
        if (!Array.isArray(columns) || columns.length > validColumns.length || columns.some((column) => !validColumns.includes(column)) || new Set(columns).size !== columns.length) throw bad('Print template item columns are not valid');
        return { id, type, zone, field, text, x, y, width, height, fontSize, bold: item.bold === true, align, color, background, border: item.border !== false, columns, condition };
      });
      out.print_template = JSON.stringify({ paperSize, orientation, marginMm, fontFamily, fontSizePt, elements: safeElements });
    }
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
  if (name === 'appointments') {
    if ('type' in out && !['', 'Follow Up'].includes(out.type)) throw bad('type is not valid');
    if ('reminder_status' in out && !['', 'Pending', 'Sent'].includes(out.reminder_status)) throw bad('reminder_status is not valid');
    if ('reminder_date' in out && out.reminder_date && !isISODate(out.reminder_date)) throw bad('reminder_date must be a valid date');
    if (out.type === 'Follow Up' && out.date && !isISODate(out.date)) throw bad('date must be a valid date');
  }
  if (name === 'records') {
    if ('kind' in out && !KINDS.includes(out.kind)) throw bad('kind is not valid');
    if ('color' in out && out.color && !/^#[0-9a-fA-F]{6}$/.test(out.color)) throw bad('color is not valid');
  }
  if (name === 'files' && 'content' in out) {
    const sanitized = clean('echo', {
      name: 'Sample file template',
      sections: JSON.stringify([{ title: '', content: out.content, fields: [] }]),
      fields: '[]',
    }, false);
    out.content = JSON.parse(sanitized.sections)[0].content.replace(/<img\b(?=[^>]*\bsrc="https?:\/\/)[^>]*>/gi, '');
  }
  if (name === 'expenses' && 'date' in out && out.date) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(out.date) ? new Date(out.date + 'T00:00:00Z') : null;
    if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== out.date) throw bad('date must be a valid date');
  }
  if (name === 'expenses' && 'unit_price' in out && 'quantity' in out) {
    if (out.quantity < 1) throw bad('quantity must be at least 1');
    const total = out.unit_price * out.quantity;
    if (!Number.isSafeInteger(total) || total > 2e9) throw bad('expense total must be a whole KHR amount up to 2,000,000,000');
    if ('amount' in out && out.amount !== total) throw bad('amount must equal unit_price multiplied by quantity');
  }
  if (name === 'echo') {
    for (const key of ['sections', 'fields']) {
      if (!(key in out)) continue;
      let values;
      try { values = JSON.parse(out[key] || '[]'); } catch { throw bad(`${key} must be a valid list`); }
      if (!Array.isArray(values) || values.length > (key === 'sections' ? 50 : 100)) throw bad(`${key} must contain a valid number of entries`);
      if (key === 'fields') {
        values = values.map((value) => {
          const field = String(value ?? '').trim();
          if (!field || field.length > 100) throw bad('Each additional field must have a name up to 100 characters');
          return field;
        });
      } else {
        values = values.map((section) => {
          if (!section || typeof section !== 'object' || Array.isArray(section)) throw bad('Each section must be an object');
          const title = String(section.title ?? '').trim(), content = String(section.content ?? '');
          if (title.length > 255 || content.length > 100000) throw bad('Section title or content is too long');
          const fields = section.fields == null ? [] : section.fields;
          if (!Array.isArray(fields) || fields.length > 100) throw bad('Each section can contain up to 100 additional fields');
          const safeFields = fields.map((value) => {
            const field = String(value ?? '').trim();
            if (!field || field.length > 100) throw bad('Each additional field must have a name up to 100 characters');
            return field;
          });
          const safeContent = content
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<(script|style|iframe|object|embed|svg|math|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
            .replace(/<(script|style|iframe|object|embed|svg|math|template)\b[^>]*\/?>/gi, '')
            .replace(/<\/?(?!p\b|div\b|span\b|strong\b|b\b|em\b|i\b|u\b|ol\b|ul\b|li\b|table\b|thead\b|tbody\b|tr\b|th\b|td\b|h[1-6]\b|blockquote\b|br\b|a\b|img\b|font\b)[a-z][^>]*>/gi, '')
            .replace(/<(p|div|span|strong|b|em|i|u|ol|ul|li|table|thead|tbody|tr|th|td|h[1-6]|blockquote|a|img|font)\b([^>]*)>/gi, (_, tag, attributes) => {
              if (tag.toLowerCase() === 'font') {
                const colorMatch = /\bcolor\s*=\s*(["']?)(#[0-9a-f]{6})\1/i.exec(attributes);
                return colorMatch ? `<span style="color:${colorMatch[2].toLowerCase()}">` : '<span>';
              }
              if (tag.toLowerCase() === 'a') {
                const hrefMatch = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(attributes);
                if (!hrefMatch) return '<a>';
                try {
                  const url = new URL(hrefMatch[2].replace(/&amp;/g, '&'));
                  return ['http:', 'https:'].includes(url.protocol) ? `<a href="${escapeXml(url.href)}" target="_blank" rel="noopener noreferrer">` : '<a>';
                } catch { return '<a>'; }
              }
              if (tag.toLowerCase() === 'img') {
                const srcMatch = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(attributes);
                if (!srcMatch) return '';
                const source = srcMatch[2].replace(/&amp;/g, '&');
                if (/^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/i.test(source)) {
                  const altMatch = /\balt\s*=\s*(["'])(.*?)\1/i.exec(attributes);
                  return `<img src="${escapeXml(source)}" alt="${escapeXml(altMatch ? altMatch[2] : '')}">`;
                }
                try {
                  const url = new URL(source);
                  if (url.protocol !== 'https:') return '';
                  const altMatch = /\balt\s*=\s*(["'])(.*?)\1/i.exec(attributes);
                  return `<img src="${escapeXml(url.href)}" alt="${escapeXml(altMatch ? altMatch[2] : '')}">`;
                } catch { return ''; }
              }
              if (!['table', 'th', 'td', 'span'].includes(tag.toLowerCase())) return `<${tag}>`;
              const styleMatch = /\bstyle\s*=\s*(["'])(.*?)\1/i.exec(attributes);
              if (!styleMatch) return `<${tag}>`;
              const safeStyles = styleMatch[2].split(';').map(rule => rule.trim()).filter(rule => {
                const [property, value] = rule.split(':').map(part => part.trim().toLowerCase());
                if (!property || !value) return false;
                if (property === 'border') return /^1px (solid|dashed|dotted|double) #[0-9a-f]{6}$/.test(value);
                if (property === 'color' || property === 'background-color') return /^#[0-9a-f]{6}$/.test(value) || /^rgb\(\s*(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\s*,\s*(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\s*,\s*(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\s*\)$/.test(value);
                if (property === 'padding') return /^\d{1,2}px$/.test(value);
                return tag.toLowerCase() === 'table' && ((property === 'width' && value === '100%') || (property === 'border-collapse' && value === 'collapse'));
              }).join(';');
              return safeStyles ? `<${tag} style="${safeStyles}">` : `<${tag}>`;
            })
            .replace(/<\/(p|div|span|strong|b|em|i|u|ol|ul|li|table|thead|tbody|tr|th|td|h[1-6]|blockquote|a|font)\s*>/gi, (_, tag) => tag.toLowerCase() === 'font' ? '</span>' : `</${tag}>`)
            .replace(/<br\b[^>]*>/gi, '<br>')
            .replace(/<br>/gi, '<br>');
          return { title, content: safeContent, fields: safeFields };
        });
      }
      out[key] = JSON.stringify(values);
    }
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
async function importPatients(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw bad('Excel workbook must contain 1–1,000 patients');
  const patients = rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw bad('Each patient must be an object');
    try { return clean('patients', row, false); }
    catch (error) {
      if (error instanceof HttpError) throw bad(`Row ${row.rowNumber || '?'}: ${error.message}`);
      throw error;
    }
  });
  await tx(async (client) => {
    for (const patient of patients) {
      const columns = Object.keys(patient);
      await client.query(
        `INSERT INTO patients(${columns.map((column) => `"${column}"`).join(',')}) VALUES(${columns.map((_, index) => `$${index + 1}`).join(',')})`,
        columns.map((column) => patient[column]),
      );
    }
  });
  return patients.length;
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
async function importLabs(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw bad('rows must contain 1–1,000 lab templates');
  const templates = rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw bad('Each lab template must be an object');
    const amount = row.price == null || row.price === '' ? 0 : Number(typeof row.price === 'string' ? row.price.trim().replace(/[,\s]/g, '') : row.price);
    if (!Number.isInteger(amount) || amount < 0 || amount > 2e9) throw bad(`Row ${row.rowNumber || '?'}: price must be a whole number`);
    let fields = row.fields ?? '';
    if (Array.isArray(fields)) fields = fields;
    else if (typeof fields === 'string' && fields.trim()) {
      try {
        const parsed = JSON.parse(fields);
        fields = Array.isArray(parsed) ? parsed : fields.split(/[|,]/);
      } catch {
        fields = fields.split(/[|,]/);
      }
    } else fields = [];
    if (!Array.isArray(fields) || fields.length > 50) throw bad(`Row ${row.rowNumber || '?'}: fields must contain up to 50 entries`);
    const normalizedFields = fields.map((field) => {
      if (typeof field === 'string') {
        const name = field.trim();
        return name ? { name, normal_range: '', unit: '' } : null;
      }
      if (!field || typeof field !== 'object' || Array.isArray(field)) return null;
      const name = String(field.name ?? '').trim();
      return name ? {
        name,
        normal_range: String(field.normal_range ?? field.normalRange ?? '').trim(),
        unit: String(field.unit ?? '').trim(),
      } : null;
    }).filter(Boolean);
    const template = clean('labs', {
      name: row.name,
      price: amount,
      cat: row.cat ?? '',
      fields: JSON.stringify(normalizedFields),
    }, false);
    return template;
  });
  await tx(async (client) => {
    for (const template of templates) {
      await client.query('INSERT INTO labs(name,price,cat,fields) VALUES($1,$2,$3,$4)', [
        template.name, template.price ?? 0, template.cat ?? '', template.fields ?? '[]',
      ]);
    }
  });
  return templates.length;
}
async function importEchoTemplates(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw bad('rows must contain 1–1,000 echo templates');
  const templates = rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw bad('Each echo template must be an object');
    const amount = row.price == null || row.price === '' ? 0 : Number(typeof row.price === 'string' ? row.price.trim().replace(/[,\s]/g, '') : row.price);
    if (!Number.isInteger(amount) || amount < 0 || amount > 2e9) throw bad(`Row ${row.rowNumber || '?'}: price must be a whole number`);
    const parseList = (value, label) => {
      if (Array.isArray(value)) return value;
      if (value == null || value === '') return [];
      try {
        const parsed = JSON.parse(String(value));
        if (!Array.isArray(parsed)) throw 0;
        return parsed;
      } catch { throw bad(`Row ${row.rowNumber || '?'}: ${label} must be a JSON list`); }
    };
    return clean('echo', {
      name: row.name,
      price: amount,
      font: row.font || 'Moul',
      sections: JSON.stringify(parseList(row.sections, 'sections')),
      fields: JSON.stringify(parseList(row.fields, 'fields')),
    }, false);
  });
  await tx(async (client) => {
    for (const template of templates) {
      await client.query('INSERT INTO echo(name,price,font,sections,fields) VALUES($1,$2,$3,$4,$5)', [
        template.name, template.price ?? 0, template.font ?? 'Moul', template.sections ?? '[]', template.fields ?? '[]',
      ]);
    }
  });
  return templates.length;
}
async function importDiagnoses(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw bad('rows must contain 1–1,000 diagnoses');
  const diagnoses = rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw bad('Each diagnosis must be an object');
    const name = String(row.name ?? row.diagnosis ?? row.diagnosis_name ?? '').trim();
    if (!name) throw bad('Each diagnosis must include a name');
    return clean('diagnoses', { name }, false);
  });
  await tx(async (client) => {
    for (const diagnosis of diagnoses) {
      await client.query('INSERT INTO diagnoses(name) VALUES($1)', [diagnosis.name]);
    }
  });
  return diagnoses.length;
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

const PERMISSION_AREAS = {
  patients: ['patients'],
  appointments_ipd: ['appointments', 'ipd', 'chat'],
  clinical: ['records'],
  pharmacy_services: ['medicines', 'services', 'sales'],
  finance_reports: ['expenses'],
  staff_payroll: ['doctors', 'payslips', 'leaves'],
  templates_reference: ['labs', 'labcategories', 'echo', 'diagnoses', 'prescriptions', 'symptoms', 'addresses', 'files'],
  clinic_settings: ['clinic'],
  user_management: ['users'],
};
const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'delete', 'print'];
function defaultStaffPermissions() {
  return Object.fromEntries(Object.keys(PERMISSION_AREAS).map((area) => [area,
    ['clinic_settings', 'user_management'].includes(area)
      ? Object.fromEntries(PERMISSION_ACTIONS.map((action) => [action, false]))
      : { view: true, create: true, edit: true, delete: false, print: true },
  ]));
}
function parsePermissions(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { source = null; }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source) || !Object.keys(source).length) return defaultStaffPermissions();
  return Object.fromEntries(Object.keys(PERMISSION_AREAS).map((area) => [
    area, Object.fromEntries(PERMISSION_ACTIONS.map((action) => [action, source[area]?.[action] === true])),
  ]));
}
function validatePermissions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('permissions must be an object');
  for (const area of Object.keys(value)) if (!Object.hasOwn(PERMISSION_AREAS, area)) throw bad(`Unknown permission area: ${area}`);
  return Object.fromEntries(Object.keys(PERMISSION_AREAS).map((area) => {
    const source = value[area] || {};
    if (typeof source !== 'object' || Array.isArray(source)) throw bad(`permissions.${area} must be an object`);
    for (const action of Object.keys(source)) if (!PERMISSION_ACTIONS.includes(action)) throw bad(`Unknown permission action: ${action}`);
    for (const action of PERMISSION_ACTIONS) if (action in source && typeof source[action] !== 'boolean') throw bad(`permissions.${area}.${action} must be true or false`);
    return [area, Object.fromEntries(PERMISSION_ACTIONS.map((action) => [action, source[action] === true]))];
  }));
}

// ---------- API ----------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
  const [a, b, c, d] = parts, m = req.method;
  const ip = req.socket.remoteAddress;

  if (a === 'health') return send(res, 200, { ok: true });
  if (a === 'auth' && b === 'status' && m === 'GET') return send(res, 200, { needsSetup: (await userCount()) === 0 });
  if (a === 'portal' && b && m === 'GET') {
    if (!/^[A-Za-z0-9_-]{43}$/.test(b)) throw new HttpError(404, 'Patient portal link not found');
    const access = await queryOne('SELECT patient_id FROM patient_portal_tokens WHERE token_hash=$1 AND revoked_at IS NULL', [patientPortalTokenHash(b)]);
    if (!access) throw new HttpError(404, 'Patient portal link not found');
    const patient = await queryOne('SELECT id,name,latin_name,age,age_unit,sex,phone,addr,khmer,nssf_id,national_id,diagnosis,complaints,history FROM patients WHERE id=$1', [access.patient_id]);
    if (!patient) throw new HttpError(404, 'Patient portal link not found');
    const [appointments, records] = await Promise.all([
      queryAll('SELECT date,time,svc,doc,st,type,notes FROM appointments WHERE patient_id=$1 ORDER BY date DESC,id DESC LIMIT 500', [patient.id]),
      queryAll("SELECT kind,title,date,notes,data FROM records WHERE patient_id=$1 AND kind<>'payment' ORDER BY date DESC,id DESC LIMIT 500", [patient.id]),
    ]);
    return send(res, 200, {
      patient,
      appointments,
      records: records.map((record) => ({ ...record, data: typeof record.data === 'string' ? JSON.parse(record.data || '{}') : record.data || {} })),
    });
  }

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
    return send(res, 200, { token: sign({ uid: u.id }), user: { id: u.id, email: u.email, name: u.name, role: u.role, permissions: u.role === 'admin' ? null : parsePermissions(u.permissions), permissions_custom: Boolean(u.permissions && u.permissions !== '{}') } });
  }

  // everything below needs a valid token
  const tok = verify((req.headers.authorization || '').replace(/^Bearer /, ''));
  const user = tok && (await queryOne('SELECT id,email,name,role,permissions FROM users WHERE id=$1', [tok.uid]));
  if (!user) throw new HttpError(401, 'Sign in required');
  const permissions = user.role === 'admin' ? null : parsePermissions(user.permissions);
  const hasCustomPermissions = Boolean(user.permissions && user.permissions !== '{}');
  const can = (area, action) => user.role === 'admin' || permissions[area]?.[action] === true;
  const canPrintAny = () => user.role === 'admin' || Object.keys(PERMISSION_AREAS).some((area) => can(area, 'print'));
  const requirePermission = (area, action) => { if (!can(area, action)) throw new HttpError(403, `Missing ${action} permission for ${area.replaceAll('_', ' ')}`); };
  const grantPermissions = (value, existing = null) => {
    const granted = validatePermissions(value);
    const current = existing ? parsePermissions(existing) : null;
    if (user.role !== 'admin' && Object.entries(granted).some(([area, actions]) => PERMISSION_ACTIONS.some((permission) => actions[permission] && !can(area, permission) && current?.[area]?.[permission] !== true))) {
      throw new HttpError(403, 'You cannot grant permissions you do not have');
    }
    return granted;
  };
  const recordArea = (kind) => kind === 'schedule' ? 'appointments_ipd' : kind === 'payment' ? 'finance_reports' : 'clinical';
  const action = ({ GET: 'view', POST: 'create', PUT: 'edit', DELETE: 'delete' })[m];
  const resourceArea = a === 'records' ? null : Object.entries(PERMISSION_AREAS).find(([, resources]) => resources.includes(a))?.[0];
  if (a === 'auth') {
    if (b !== 'me' && b !== 'password') throw new HttpError(404, 'Not found');
  } else if (a === 'clinic' && b === 'print') {
    if (m !== 'GET') throw new HttpError(405, 'Method not allowed');
    if (!canPrintAny()) throw new HttpError(403, 'Missing print permission');
  } else if (a === 'clinic') {
    requirePermission('clinic_settings', m === 'GET' ? 'view' : 'edit');
  } else if (a === 'users') {
    requirePermission('user_management', action || 'view');
  } else if (a === 'medicines' && (b === 'codes' || c === 'code')) {
    requirePermission('pharmacy_services', 'view');
    requirePermission('pharmacy_services', 'print');
  } else if (a === 'export') {
    if (!canPrintAny()) throw new HttpError(403, 'Missing print permission');
  } else if (a === 'sales') {
    if (m === 'GET' && user.role !== 'admin' && !can('pharmacy_services', 'view') && !can('finance_reports', 'view')) {
      throw new HttpError(403, 'Missing sales view permission');
    }
    if (m !== 'GET') requirePermission('pharmacy_services', action || 'view');
  } else if (a === 'reports' && b === 'medicine-sales') {
    requirePermission('pharmacy_services', 'view');
  } else if (a === 'reports' || a === 'expenses') {
    requirePermission('finance_reports', action || 'view');
  } else if (a === 'dashboard') {
    if (user.role !== 'admin' && !['patients', 'appointments_ipd', 'finance_reports'].some((area) => can(area, 'view'))) {
      throw new HttpError(403, 'Missing dashboard view permission');
    }
  } else if ((a === 'uploads' || a === 'echo-uploads') && m === 'POST') {
    const areas = a === 'echo-uploads' ? ['clinical'] : ['patients', 'clinical', 'staff_payroll', 'pharmacy_services', 'clinic_settings'];
    if (user.role !== 'admin' && !areas.some((area) => can(area, 'create') || can(area, 'edit'))) throw new HttpError(403, 'Missing upload permission');
  } else if (a === 'ocr') {
    requirePermission('clinical', action || 'view');
  } else if (a === 'records' && m === 'GET' && !b) {
    const kind = url.searchParams.get('kind');
    if (kind) requirePermission(recordArea(kind), 'view');
    else if (user.role !== 'admin' && !['clinical', 'appointments_ipd', 'finance_reports'].some((area) => can(area, 'view'))) {
      throw new HttpError(403, 'Missing records view permission');
    }
  } else if (resourceArea && !(a === 'patients' && c === 'portal')) {
    const imports = b === 'import' || b === 'import-xlsx';
    requirePermission(resourceArea, imports ? 'create' : action || 'view');
  }

  if (a === 'auth' && b === 'me' && m === 'GET') return send(res, 200, { id: user.id, email: user.email, name: user.name, role: user.role, permissions, permissions_custom: hasCustomPermissions });

  if (a === 'patients' && b && c === 'portal') {
    const patientId = Number(b);
    if (!Number.isInteger(patientId) || patientId < 1) throw new HttpError(404, 'Patient not found');
    const patient = await queryOne('SELECT id FROM patients WHERE id=$1', [patientId]);
    if (!patient) throw new HttpError(404, 'Patient not found');
    if (m === 'POST') {
      requirePermission('patients', 'print');
      const body = await readJson(req);
      let origin;
      try { origin = new URL(String(body.portal_origin || '')); } catch { throw bad('portal_origin must be a valid web origin'); }
      if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
          (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname))) {
        throw bad('portal_origin must be an HTTPS origin (HTTP is allowed only on localhost)');
      }
      if (req.headers.origin) {
        let requestOrigin;
        try { requestOrigin = new URL(req.headers.origin).origin; } catch { throw bad('Request origin is invalid'); }
        if (requestOrigin !== origin.origin) throw bad('portal_origin must match the requesting application origin');
      }
      const token = crypto.randomBytes(32).toString('base64url');
      await query('INSERT INTO patient_portal_tokens(patient_id,token_hash) VALUES($1,$2)', [patientId, patientPortalTokenHash(token)]);
      const portalUrl = `${origin.origin}/portal.html#${token}`;
      const qr = await QRCode.toDataURL(portalUrl, { errorCorrectionLevel: 'M', margin: 1, width: 320 });
      return send(res, 201, { portal_url: portalUrl, qr });
    }
    if (m === 'DELETE') {
      requirePermission('patients', 'edit');
      await query('UPDATE patient_portal_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE patient_id=$1 AND revoked_at IS NULL', [patientId]);
      return send(res, 200, { ok: true });
    }
    throw new HttpError(405, 'Method not allowed');
  }

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
    const svg = await medicineCodeSvg(medicine, d);
    return send(res, 200, { svg });
  }

  if (a === 'medicines' && b === 'codes' && ['qr', 'barcode'].includes(c) && m === 'POST') {
    const body = await readJson(req);
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 5000 || body.ids.some((id) => !Number.isInteger(id) || id < 1)) {
      throw bad('ids must contain 1–5,000 positive medicine IDs');
    }
    const ids = [...new Set(body.ids)];
    const rows = await queryAll(`SELECT id,name,composition FROM medicines WHERE id IN (${ids.map((_, index) => `$${index + 1}`).join(',')})`, ids);
    if (rows.length !== ids.length) throw new HttpError(404, 'One or more medicines were not found');
    const medicines = new Map(rows.map((medicine) => [medicine.id, medicine]));
    const codes = await Promise.all(ids.map(async (id) => {
      const medicine = medicines.get(id);
      const svg = await medicineCodeSvg(medicine, c);
      const viewBox = svg.match(/\bviewBox="([^"]+)"/);
      if (!viewBox) throw new Error('Generated medicine code has no viewBox');
      const content = svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>'));
      return { medicine, viewBox: viewBox[1], content };
    }));
    const rowHeight = c === 'qr' ? 280 : 220;
    const codeSize = c === 'qr' ? 210 : 180;
    const labels = codes.map(({ medicine, viewBox, content }, index) => {
      const y = index * rowHeight;
      return `<rect x="0" y="${y}" width="800" height="${rowHeight}" fill="#fff"/><svg x="24" y="${y + 16}" width="${codeSize}" height="${rowHeight - 32}" viewBox="${viewBox}">${content}</svg><text x="260" y="${y + 95}" font-family="Arial,sans-serif" font-size="24" font-weight="bold">${escapeXml(medicine.name)}</text><text x="260" y="${y + 132}" font-family="Arial,sans-serif" font-size="18">Medicine ID: ${medicine.id}</text>`;
    }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${rowHeight * codes.length}" viewBox="0 0 800 ${rowHeight * codes.length}">${labels}</svg>`;
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="medicine-${c}-codes.svg"`,
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(svg),
    });
    return res.end(svg);
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

  if (a === 'clinic' && b === 'print' && m === 'GET') {
    return send(res, 200, await queryOne(`SELECT name,specialty,address,phone,currency,rate,logo,qr,banner,footer_banner,footer_banner_text,footer_banner_mode,show_name,show_address,show_phone,print_header,print_footer,print_template FROM clinic WHERE id=1`));
  }

  if (a === 'clinic' && !b) {
    const row = () => queryOne('SELECT * FROM clinic WHERE id=1');
    if (m === 'GET') { requirePermission('clinic_settings', 'view'); return send(res, 200, await row()); }
    if (m === 'PUT') {
      requirePermission('clinic_settings', 'edit');
      const d = clean(null, await readJson(req), true, CLINIC), cols = Object.keys(d);
      if (!cols.length) throw bad('Nothing to update');
      if ('footer_banner_mode' in d && !['image', 'text'].includes(d.footer_banner_mode)) throw bad('Footer mode must be image or text');
      const old = await row();
      await query(`UPDATE clinic SET ${cols.map((x, i) => `"${x}"=$${i + 1}`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=1`, cols.map((x) => d[x]));
      for (const k of ['logo', 'qr', 'banner', 'footer_banner']) if (k in d && old[k] !== d[k]) await dropFile(old[k]);
      return send(res, 200, await row());
    }
  }

  if (a === 'users') {
    if (!b && m === 'GET') {
      requirePermission('user_management', 'view');
      const users = await queryAll('SELECT id,email,name,role,permissions,created_at FROM users ORDER BY id');
      return send(res, 200, users.map((item) => ({ ...item, permissions: item.role === 'admin' ? null : parsePermissions(item.permissions) })));
    }
    if (!b && m === 'POST') {
      requirePermission('user_management', 'create');
      const body = await readJson(req), email = String(body.email || '').trim().toLowerCase();
      if (!isEmail(email)) throw bad('Enter a valid email');
      if (String(body.password || '').length < 8) throw bad('Password must be at least 8 characters');
      if (body.role && body.role !== 'staff') throw bad('New accounts must use the staff role');
      if (await queryOne('SELECT 1 FROM users WHERE email=$1', [email])) throw new HttpError(409, 'Email already in use');
      if (body.permissions === undefined && user.role !== 'admin') throw bad('Custom permissions are required');
      const access = body.permissions === undefined ? null : grantPermissions(body.permissions);
      const r = await queryOne('INSERT INTO users(email,name,role,permissions,pass) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [email, String(body.name || email.split('@')[0]).slice(0, 100), 'staff', JSON.stringify(access || {}), await hashPw(String(body.password))]);
      return send(res, 201, { id: r.id, email, name: String(body.name || email.split('@')[0]).slice(0, 100), role: 'staff', permissions: access || defaultStaffPermissions() });
    }
    if (b && m === 'PUT') {
      requirePermission('user_management', 'edit');
      const id = Number(b);
      if (!Number.isInteger(id) || id < 1) throw bad('Invalid user ID');
      if (id === user.id && user.role !== 'admin') throw bad('You cannot change your own permissions');
      const target = await queryOne('SELECT id,role,permissions FROM users WHERE id=$1', [id]);
      if (!target) throw new HttpError(404, 'Not found');
      if (target.role === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Administrator accounts cannot be edited here');
      const body = await readJson(req), fields = [], values = [];
      if (body.email !== undefined) {
        const email = String(body.email).trim().toLowerCase();
        if (!isEmail(email)) throw bad('Enter a valid email');
        if (await queryOne('SELECT id FROM users WHERE email=$1 AND id<>$2', [email, id])) throw new HttpError(409, 'Email already in use');
        fields.push(`email=$${fields.length + 1}`); values.push(email);
      }
      if (body.name !== undefined) { fields.push(`name=$${fields.length + 1}`); values.push(String(body.name).slice(0, 100)); }
      if (body.password !== undefined && String(body.password)) {
        if (String(body.password).length < 8) throw bad('Password must be at least 8 characters');
        fields.push(`pass=$${fields.length + 1}`); values.push(await hashPw(String(body.password)));
      }
      if (body.permissions !== undefined) {
        if (target.role === 'admin') throw bad('Administrator permissions are fixed');
        fields.push(`permissions=$${fields.length + 1}`); values.push(JSON.stringify(grantPermissions(body.permissions, target.permissions)));
      }
      if (!fields.length) throw bad('Nothing to update');
      values.push(id);
      const updated = await queryOne(`UPDATE users SET ${fields.join(',')} WHERE id=$${values.length} RETURNING id,email,name,role,permissions,created_at`, values);
      return send(res, 200, { ...updated, permissions: updated.role === 'admin' ? null : parsePermissions(updated.permissions) });
    }
    if (b && m === 'DELETE') {
      requirePermission('user_management', 'delete');
      const id = Number(b);
      if (!Number.isInteger(id) || id < 1) throw bad('Invalid user ID');
      if (id === user.id) throw bad('You cannot delete your own account');
      const target = await queryOne('SELECT role FROM users WHERE id=$1', [id]);
      if (target?.role === 'admin') throw bad('Administrator accounts cannot be deleted here');
      const r = await query('DELETE FROM users WHERE id=$1', [id]);
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
  if (a === 'sales' && b && c === 'items' && d && m === 'DELETE') {
    requirePermission('pharmacy_services', 'delete');
    const saleId = Number(b), itemId = Number(d);
    if (!Number.isInteger(saleId) || saleId < 1 || !Number.isInteger(itemId) || itemId < 1) throw bad('Invalid sale item');
    await tx(async (client) => {
      const item = (await client.query('SELECT medicine_id,qty FROM sale_items WHERE id=$1 AND sale_id=$2', [itemId, saleId])).rows[0];
      if (!item) throw new HttpError(404, 'Medicine sale item not found');
      await client.query('DELETE FROM sale_items WHERE id=$1', [itemId]);
      if (item.medicine_id != null) await client.query('UPDATE medicines SET stock=stock+$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2', [item.qty, item.medicine_id]);
      const totals = (await client.query('SELECT COUNT(*)::int AS count,COALESCE(SUM(qty*price),0)::int AS total FROM sale_items WHERE sale_id=$1', [saleId])).rows[0];
      if (!totals.count) await client.query('DELETE FROM sales WHERE id=$1', [saleId]);
      else await client.query('UPDATE sales SET total=$1 WHERE id=$2', [totals.total, saleId]);
    });
    return send(res, 200, { ok: true });
  }
  if (a === 'sales' && !b && m === 'GET') {
    const limit = Math.min(5000, Math.max(1, parseInt(url.searchParams.get('limit')) || 200));
    return send(res, 200, await queryAll('SELECT * FROM sales ORDER BY id DESC LIMIT $1', [limit]));
  }

  if (a === 'reports' && b === 'medicine-sales' && m === 'GET') {
    const from = url.searchParams.get('from') || null, to = url.searchParams.get('to') || null;
    const validDate = (value) => {
      if (!value) return true;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const parsed = new Date(value + 'T00:00:00Z');
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    };
    if (!validDate(from) || !validDate(to)) throw bad('from and to must be valid dates');
    if (from && to && from > to) throw bad('from date must not be after to date');
    const limit = Math.min(5000, Math.max(1, parseInt(url.searchParams.get('limit')) || 5000));
    const rows = await queryAll(`SELECT si.id AS item_id,si.sale_id,si.name,si.qty,si.price,(si.qty*si.price)::int AS total,s.method,
      TO_CHAR(s.created_at + ($1 || ' hours')::interval, 'YYYY-MM-DD') AS date
      FROM sale_items si JOIN sales s ON s.id=si.sale_id
      WHERE ($2::text IS NULL OR TO_CHAR(s.created_at + ($1 || ' hours')::interval, 'YYYY-MM-DD') >= $2)
        AND ($3::text IS NULL OR TO_CHAR(s.created_at + ($1 || ' hours')::interval, 'YYYY-MM-DD') <= $3)
      ORDER BY s.created_at DESC,si.id DESC LIMIT $4`, [String(tzh), from, to, limit]);
    return send(res, 200, rows);
  }

  if (a === 'reports' && b === 'daily' && m === 'GET') {
    const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days')) || 30));
    const rows = await queryAll(`SELECT TO_CHAR(created_at + ($1 || ' hours')::interval, 'YYYY-MM-DD') AS "day",COUNT(*)::int AS n,COALESCE(SUM(total),0)::int AS amt FROM sales
      WHERE created_at >= (NOW() - ($2 || ' days')::interval) GROUP BY TO_CHAR(created_at + ($1 || ' hours')::interval, 'YYYY-MM-DD') ORDER BY 1 DESC`, [String(tzh), String(days)]);
    return send(res, 200, rows);
  }
  if (a === 'dashboard' && m === 'GET') {
    const pCount = can('patients', 'view') ? (await queryOne('SELECT COUNT(*)::int n FROM patients'))?.n || 0 : 0;
    const apptCount = can('appointments_ipd', 'view') ? (await queryOne("SELECT COUNT(*)::int n FROM appointments WHERE date = TO_CHAR(NOW() + ($1 || ' hours')::interval, 'YYYY-MM-DD')", [String(tzh)]))?.n || 0 : 0;
    const revToday = can('finance_reports', 'view') ? (await queryOne("SELECT COALESCE(SUM(total),0)::int n FROM sales WHERE TO_CHAR(created_at + ($1 || ' hours')::interval, 'YYYY-MM-DD') = TO_CHAR(NOW() + ($1 || ' hours')::interval, 'YYYY-MM-DD')", [String(tzh)]))?.n || 0 : 0;
    const ipdCount = can('appointments_ipd', 'view') ? (await queryOne('SELECT COUNT(*)::int n FROM ipd WHERE "out"=0'))?.n || 0 : 0;
    return send(res, 200, {
      patients: pCount,
      appointmentsToday: apptCount,
      revenueToday: revToday,
      ipdCurrent: ipdCount,
    });
  }

  if ((a === 'uploads' || a === 'echo-uploads') && !b && m === 'POST') {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type];
    if (!ext) throw new HttpError(415, 'Use a JPG, PNG or WebP picture');
    const echoReport = a === 'echo-uploads';
    const buf = await readRaw(req, echoReport ? 10e6 : 2e6, echoReport ? 'Picture is too large (max 10 MB)' : undefined);
    const magic = ext === 'jpg' ? buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
      : ext === 'png' ? buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
    if (!magic) throw bad('File is not a valid picture');
    const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
    fs.mkdirSync(UPLOADS, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS, name), buf);
    return send(res, 201, { photo: name });
  }
  if (a === 'ocr' && !b && m === 'POST') {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type];
    if (!ext) throw new HttpError(415, 'Use a JPG, PNG or WebP picture');
    const image = await readRaw(req, 2e6);
    const validImage = ext === 'jpg' ? image.length > 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff
      : ext === 'png' ? image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : image.subarray(0, 4).toString('latin1') === 'RIFF' && image.subarray(8, 12).toString('latin1') === 'WEBP';
    if (!validImage) throw bad('File is not a valid picture');
    let worker;
    try {
      if (!ocrWorkerPromise) ocrWorkerPromise = createWorker(['eng', 'khm'], 1, { cachePath: path.join(dataDir, 'tessdata') });
      worker = await ocrWorkerPromise;
    } catch (error) {
      ocrWorkerPromise = null;
      throw new HttpError(503, `OCR is unavailable: ${error.message}`);
    }
    try {
      const result = await worker.recognize(image);
      return send(res, 200, { text: String(result.data.text || '').trim() });
    } catch (error) { throw new HttpError(422, `Image OCR failed: ${error.message}`); }
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

  if (a === 'patients' && b === 'import-xlsx' && m === 'POST') {
    const buffer = await readRaw(req, 1e6, 'Excel workbook is too large (max 1 MB)');
    let workbook;
    try { workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer); }
    catch { throw bad('Invalid Excel workbook'); }
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount < 2) throw bad('Excel workbook must include a header and at least one patient');
    if (sheet.rowCount > 1001) throw bad('Excel workbook can contain up to 1,000 patients');
    const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const headers = sheet.getRow(1).values.slice(1).map(normalize);
    const aliases = {
      name: ['name', 'patientname'],
      latin_name: ['latinname'],
      age: ['age'],
      age_unit: ['ageunit'],
      dob: ['dob', 'dateofbirth', 'birthdate'],
      sex: ['sex', 'gender'],
      phone: ['phone', 'telephone'],
      addr: ['addr', 'address'],
      type: ['type', 'patienttype'],
      room: ['room'],
      bed: ['bed'],
      unpaid: ['unpaid'],
      khmer: ['khmer'],
      nssf: ['nssf'],
      pet: ['pet'],
      follow_up: ['followup'],
      diagnosis: ['diagnosis'],
      nssf_id: ['nssfid'],
      national_id: ['nationalid'],
      complaints: ['complaints'],
      history: ['history', 'medicalhistory'],
      reg_date: ['regdate', 'registrationdate'],
      photo: ['photo'],
    };
    const columns = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, headers.findIndex((header) => names.includes(header))]));
    if (columns.name < 0) throw bad('Excel workbook needs a patient name column');
    const dateValue = (value) => {
      if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2958465) {
        return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
      }
      return value;
    };
    const booleanValue = (value, rowNumber, key) => {
      if (value == null || value === '') return undefined;
      if (typeof value === 'boolean') return value;
      const normalized = String(value).trim().toLowerCase();
      if (['1', 'yes', 'true'].includes(normalized)) return true;
      if (['0', 'no', 'false'].includes(normalized)) return false;
      throw bad(`Row ${rowNumber}: ${key} must be Yes or No`);
    };
    const rows = [];
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
      const values = sheet.getRow(rowNumber).values.slice(1);
      if (!values.some((value) => value != null && String(value).trim())) continue;
      const row = { rowNumber };
      for (const [key, index] of Object.entries(columns)) {
        if (index < 0 || values[index] == null || values[index] === '') continue;
        const value = ['dob', 'reg_date'].includes(key) ? dateValue(values[index]) : values[index];
        row[key] = ['unpaid', 'khmer', 'nssf', 'pet', 'follow_up'].includes(key)
          ? booleanValue(value, rowNumber, key)
          : value;
      }
      rows.push(row);
    }
    return send(res, 201, { imported: await importPatients(rows) });
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

  if (a === 'labs' && b === 'import-xlsx' && m === 'POST') {
    const buffer = await readRaw(req, 1e6, 'Excel workbook is too large (max 1 MB)');
    let workbook;
    try { workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer); }
    catch { throw bad('Invalid Excel workbook'); }
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount < 2) throw bad('Excel workbook must include a header and at least one lab template');
    if (sheet.rowCount > 1001) throw bad('Excel workbook can contain up to 1,000 lab templates');
    const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const headers = sheet.getRow(1).values.slice(1).map(normalize);
    const find = (...names) => headers.findIndex((header) => names.includes(header));
    const columns = {
      name: find('name', 'test', 'labname', 'testname'),
      price: find('price', 'pricekhr', 'amount'),
      cat: find('category', 'cat'),
      fields: find('fields', 'fieldnames'),
    };
    if (columns.name < 0 || columns.price < 0) throw bad('Excel workbook needs name and price columns');
    const rows = [];
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
      const values = sheet.getRow(rowNumber).values.slice(1);
      if (!values.some((value) => value != null && String(value).trim())) continue;
      const row = { rowNumber };
      for (const [key, index] of Object.entries(columns)) {
        if (index >= 0 && values[index] != null) row[key] = values[index];
      }
      rows.push(row);
    }
    return send(res, 201, { imported: await importLabs(rows) });
  }

  if (a === 'diagnoses' && b === 'import-xlsx' && m === 'POST') {
    const buffer = await readRaw(req, 1e6, 'Import file is too large (max 1 MB)');
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const isCsv = contentType === 'text/csv' || contentType === 'application/csv';
    let rows = [];
    if (isCsv) {
      const text = buffer.toString('utf8');
      const split = (line) => { const cells = []; let cell = ''; let quote = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (ch === '"') { if (quote && line[i + 1] === '"') { cell += '"'; i++; } else quote = !quote; } else if (ch === ',' && !quote) { cells.push(cell); cell = ''; } else if (ch === '\r') continue; else { cell += ch; } } cells.push(cell); return cells; };
      const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
      if (!lines.length) throw bad('CSV must include a header and at least one diagnosis');
      const headers = split(lines[0]).map((header) => String(header ?? '').trim().toLowerCase());
      const nameIndex = headers.findIndex((header) => ['name', 'diagnosis', 'diagnosisname'].includes(header));
      if (nameIndex < 0) throw bad('CSV needs a name column');
      for (let index = 1; index < lines.length; index++) {
        const values = split(lines[index]);
        if (!values.some((value) => String(value || '').trim())) continue;
        const row = { name: values[nameIndex] ?? '' };
        for (let headerIndex = 0; headerIndex < headers.length; headerIndex++) {
          const key = headers[headerIndex];
          if (key && headerIndex < values.length) row[key] = values[headerIndex];
        }
        rows.push(row);
      }
    } else {
      let workbook;
      try { workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer); }
      catch { throw bad('Invalid Excel workbook'); }
      const sheet = workbook.worksheets[0];
      if (!sheet || sheet.rowCount < 2) throw bad('Excel workbook must include a header and at least one diagnosis');
      const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      const headers = sheet.getRow(1).values.slice(1).map(normalize);
      const find = (...names) => headers.findIndex((header) => names.includes(header));
      const columns = { name: find('name', 'diagnosis', 'diagnosisname') };
      if (columns.name < 0) throw bad('Excel workbook needs a diagnosis name column');
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
        const values = sheet.getRow(rowNumber).values.slice(1);
        if (!values.some((value) => value != null && String(value).trim())) continue;
        const row = { rowNumber };
        for (const [key, index] of Object.entries(columns)) {
          if (index >= 0 && values[index] != null) row[key] = values[index];
        }
        rows.push(row);
      }
    }
    return send(res, 201, { imported: await importDiagnoses(rows) });
  }

  if (a === 'echo' && b === 'import-xlsx' && m === 'POST') {
    const buffer = await readRaw(req, 1e6, 'Excel workbook is too large (max 1 MB)');
    let workbook;
    try { workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer); }
    catch { throw bad('Invalid Excel workbook'); }
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount < 2) throw bad('Excel workbook must include a header and at least one echo template');
    if (sheet.rowCount > 1001) throw bad('Excel workbook can contain up to 1,000 echo templates');
    const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const headers = sheet.getRow(1).values.slice(1).map(normalize);
    const find = (...names) => headers.findIndex((header) => names.includes(header));
    const columns = {
      name: find('name', 'templatename', 'echoname'),
      price: find('price', 'pricekhr', 'amount'),
      font: find('font', 'defaultfont'),
      sections: find('sections', 'content'),
      fields: find('fields', 'additionalfields'),
    };
    if (columns.name < 0 || columns.price < 0) throw bad('Excel workbook needs name and price columns');
    const rows = [];
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
      const values = sheet.getRow(rowNumber).values.slice(1);
      if (!values.some((value) => value != null && String(value).trim())) continue;
      const row = { rowNumber };
      for (const [key, index] of Object.entries(columns)) {
        if (index >= 0 && values[index] != null) row[key] = values[index];
      }
      rows.push(row);
    }
    return send(res, 201, { imported: await importEchoTemplates(rows) });
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
      if (a === 'leaves') {
        const existing = id ? await queryOne('SELECT start_date,end_date,status FROM leaves WHERE id=$1', [id]) : null;
        const start = d.start_date || existing?.start_date, end = d.end_date || existing?.end_date;
        if ((creating || 'start_date' in d) && !isISODate(start)) throw bad('start_date must be a valid date');
        if ((creating || 'end_date' in d) && !isISODate(end)) throw bad('end_date must be a valid date');
        if (start && end && start > end) throw bad('end_date must not be before start_date');
        if ('leave_type' in d && !['Annual', 'Sick', 'Personal', 'Maternity', 'Other'].includes(d.leave_type)) throw bad('leave_type is not valid');
        if ('status' in d && !['Pending', 'Approved', 'Rejected'].includes(d.status)) throw bad('status is not valid');
        if (creating && !d.status) throw bad('status is required');
      }
    };
    const needPatient = async (d, must) => {
      if (a === 'records') {
        if (must && !d.patient_id) throw bad('patient_id is required');
        if ('patient_id' in d && !(await queryOne('SELECT 1 FROM patients WHERE id=$1', [d.patient_id]))) throw bad('Patient not found');
        return;
      }
      if (a !== 'appointments') return;
      const existing = !must && id ? await queryOne('SELECT patient_id,type,date,reminder_date FROM appointments WHERE id=$1', [id]) : null;
      const patientId = Object.hasOwn(d, 'patient_id') ? d.patient_id : existing?.patient_id;
      const type = Object.hasOwn(d, 'type') ? d.type : existing?.type;
      const date = Object.hasOwn(d, 'date') ? d.date : existing?.date;
      const reminderDate = Object.hasOwn(d, 'reminder_date') ? d.reminder_date : existing?.reminder_date;
      if (type === 'Follow Up' && !patientId) throw bad('patient_id is required for follow-up appointments');
      if (type === 'Follow Up' && (!date || !isISODate(date))) throw bad('date must be a valid date for follow-up appointments');
      if (type === 'Follow Up' && reminderDate && (!isISODate(reminderDate) || reminderDate > date)) throw bad('reminder_date must be on or before the appointment date');
      if (patientId && !(await queryOne('SELECT 1 FROM patients WHERE id=$1', [patientId]))) throw bad('Patient not found');
    };

    if (id === null && m === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
      const limit = Math.min(5000, Math.max(1, parseInt(url.searchParams.get('limit')) || 1000));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset')) || 0);
      const conds = [], params = [];
      let pIdx = 1;
      if (a === 'records' && user.role !== 'admin' && !url.searchParams.has('kind')) {
        const allowedKinds = KINDS.filter((kind) => can(recordArea(kind), 'view'));
        if (!allowedKinds.length) throw new HttpError(403, 'Missing records view permission');
        conds.push(`kind IN (${allowedKinds.map(() => `$${pIdx++}`).join(',')})`);
        params.push(...allowedKinds);
      }
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
      if (a === 'records') requirePermission(recordArea(d.kind), 'create');
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
      if (a === 'records') requirePermission(recordArea(row.kind), 'view');
      return send(res, 200, row);
    }
    if (id !== null && m === 'PUT') {
      const d = withUser(clean(a, await readJson(req), true));
      if (a === 'records') {
        const existing = await queryOne('SELECT kind FROM records WHERE id=$1', [id]);
        if (!existing) throw new HttpError(404, 'Not found');
        requirePermission(recordArea(d.kind || existing.kind), 'edit');
      }
      await validateResource(d, false);
      await needPatient(d, false);
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
        const row = await queryOne('SELECT created_by,kind FROM records WHERE id=$1', [id]);
        if (row) {
          const area = recordArea(row.kind);
          if (!can(area, 'delete') && !(user.role !== 'admin' && !hasCustomPermissions && row.created_by === user.id)) {
            requirePermission(area, 'delete');
          }
        }
        if (row && user.role !== 'admin' && !hasCustomPermissions && row.created_by !== user.id) throw new HttpError(403, 'Only the author or an admin can delete this record');
      }
      const imgs = names.filter((n) => IMG.includes(n));
      const old = imgs.length ? await queryOne(`SELECT ${imgs.map((q) => `"${q}"`).join(',')} FROM "${a}" WHERE id=$1`, [id]) : null;
      const recImgs = a === 'patients' ? (await queryAll("SELECT image FROM records WHERE patient_id=$1 AND image<>''", [id])).map((x) => x.image) : [];
      if (a === 'patients') {
        const linkedKinds = await queryAll('SELECT DISTINCT kind FROM records WHERE patient_id=$1', [id]);
        for (const row of linkedKinds) requirePermission(recordArea(row.kind), 'delete');
        if (await queryOne('SELECT 1 FROM appointments WHERE patient_id=$1 LIMIT 1', [id])) requirePermission('appointments_ipd', 'delete');
        await query('DELETE FROM records WHERE patient_id=$1', [id]);
        await query('DELETE FROM appointments WHERE patient_id=$1', [id]);
      }
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
