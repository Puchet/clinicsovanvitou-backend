'use strict';
// Smoke test: starts the server on a test database and exercises auth, CRUD, POS and permissions.
const os = require('os'), path = require('path'), assert = require('assert');
const ExcelJS = require('exceljs');
process.env.NODE_ENV = 'test';
process.env.USE_MEM_DB = 'true';
process.env.JWT_SECRET = 'x'.repeat(40);
const { server } = require('./server');
const { close } = require('./db');

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = null;
  const call = async (method, url, body, tk = token) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  };
  const ok = (name) => console.log('  ✓', name);
  try {
    assert.equal((await call('GET', '/api/patients')).status, 401); ok('API rejects unauthenticated requests');
    assert.equal((await call('GET', '/api/auth/status')).body.needsSetup, true); ok('first run needs setup');
    assert.equal((await call('POST', '/api/auth/setup', { email: 'bad', password: 'longenough' })).status, 400); ok('setup validates email');
    assert.equal((await call('POST', '/api/auth/setup', { email: 'admin@clinic.test', password: 'correct-horse' })).status, 201); ok('admin created');
    assert.equal((await call('POST', '/api/auth/setup', { email: 'x@y.zz', password: 'correct-horse' })).status, 403); ok('setup is one-time only');
    assert.equal((await call('POST', '/api/auth/login', { email: 'admin@clinic.test', password: 'wrong' })).status, 401); ok('wrong password rejected');
    token = (await call('POST', '/api/auth/login', { email: 'admin@clinic.test', password: 'correct-horse' })).body.token; assert.ok(token); ok('login returns token');
    assert.equal((await call('GET', '/api/patients', null, token + 'x')).status, 401); ok('tampered token rejected');

    const p = await call('POST', '/api/patients', { name: '  Sok Dara ', age: '34', sex: 'M', type: 'OPD' });
    assert.equal(p.status, 201); assert.equal(p.body.name, 'Sok Dara'); assert.equal(p.body.age, 34); ok('create patient (trimmed, coerced)');
    assert.equal((await call('POST', '/api/patients', { age: 3 })).status, 400); ok('name required');
    assert.equal((await call('POST', '/api/patients', { name: 'A', type: 'XYZ' })).status, 400); ok('type validated');
    assert.equal((await call('POST', '/api/patients', { name: "Robert'); DROP TABLE patients;--" })).status, 201); ok('SQL injection stored as plain text');
    const list = await call('GET', '/api/patients?q=' + encodeURIComponent('%')); assert.equal(list.body.length, 0); ok('LIKE wildcards are escaped');
    assert.equal((await call('GET', '/api/patients?q=sok')).body.length, 1); ok('search works');
    assert.equal((await call('PUT', `/api/patients/${p.body.id}`, { phone: '012 345 678' })).body.phone, '012 345 678'); ok('update patient');
    assert.equal((await call('GET', '/api/patients/99999')).status, 404); ok('404 for missing record');
    const service = await call('POST', '/api/services', { name: 'Facial care', price: '60000', description: 'សេវាថែរក្សាផ្ទៃមុខ' });
    assert.equal(service.status, 201); assert.equal(service.body.price, 60000); assert.equal(service.body.description, 'សេវាថែរក្សាផ្ទៃមុខ');
    assert.equal((await call('PUT', `/api/services/${service.body.id}`, { description: 'ការពិពណ៌នាថ្មី' })).body.description, 'ការពិពណ៌នាថ្មី');
    assert.equal((await call('GET', '/api/services?q=' + encodeURIComponent('ពិពណ៌នា'))).body[0].description, 'ការពិពណ៌នាថ្មី'); ok('service description is created, updated and searchable');
    const imported = await call('POST', '/api/services/import', { rows: [
      { name: 'Imported peel', price: 25000, description: 'First imported service' },
      { name: 'Imported facial', price: 40000, description: 'Second imported service' },
    ] });
    assert.equal(imported.status, 201); assert.equal(imported.body.imported, 2);
    assert.equal((await call('GET', '/api/services?q=Imported')).body.length, 2); ok('services import accepts multiple rows');
    const invalidImport = await call('POST', '/api/services/import', { rows: [
      { name: 'Must roll back', price: 1000 },
      { price: 2000 },
    ] });
    assert.equal(invalidImport.status, 400);
    assert.equal((await call('GET', '/api/services?q=' + encodeURIComponent('Must roll back'))).body.length, 0); ok('invalid service import is rejected without partial inserts');
    const exportResponse = await fetch(base + '/api/export/xlsx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ rows: [{ name: 'Exported service', price: 25000, description: 'Description included' }] }),
    });
    assert.equal(exportResponse.status, 200); assert.match(exportResponse.headers.get('content-type'), /spreadsheetml\.sheet/);
    assert.match(exportResponse.headers.get('content-disposition'), /\.xlsx/);
    const workbookBytes = Buffer.from(await exportResponse.arrayBuffer()), workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(workbookBytes);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.getRow(1).getCell(3).value, 'description');
    assert.equal(sheet.getRow(2).getCell(3).value, 'Description included');
    const xlsxImport = await fetch(base + '/api/services/import-xlsx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Authorization: 'Bearer ' + token },
      body: workbookBytes,
    });
    assert.equal(xlsxImport.status, 201); assert.equal((await xlsxImport.json()).imported, 1);
    assert.equal((await call('GET', '/api/services?q=Exported')).body[0].description, 'Description included'); ok('real Excel export includes service descriptions and imports back into Services');

    const med = (await call('POST', '/api/medicines', { name: 'Paracetamol', price: 500, stock: 10 })).body;
    let s = await call('POST', '/api/sales', { method: 'Cash', items: [{ medicine_id: med.id, qty: 4 }] });
    assert.equal(s.status, 201); assert.equal(s.body.total, 2000); ok('sale uses DB price and totals correctly');
    assert.equal((await call('GET', `/api/medicines/${med.id}`)).body.stock, 6); ok('stock decremented');
    s = await call('POST', '/api/sales', { method: 'Cash', items: [{ medicine_id: med.id, qty: 7 }] });
    assert.equal(s.status, 409); assert.equal((await call('GET', `/api/medicines/${med.id}`)).body.stock, 6); ok('oversell blocked, stock unchanged');
    const dash = (await call('GET', '/api/dashboard')).body; assert.equal(dash.revenueToday, 2000); ok('dashboard revenue');
    assert.equal((await call('GET', '/api/reports/daily')).body[0].amt, 2000); ok('daily report');

    const item = await call('POST', '/api/medicines', { name: 'Bandage roll', price: '1500', stock: '20' });
    assert.equal(item.status, 201); assert.equal(item.body.price, 1500); assert.equal(item.body.stock, 20); ok('create store item (name, price, stock)');
    assert.equal((await call('POST', '/api/medicines', { name: 'Free', price: -5 })).status, 400); ok('negative price rejected');
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const up = (buf, type, tk = token) => fetch(base + '/api/uploads', { method: 'POST', headers: { 'Content-Type': type, ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: buf });
    assert.equal((await up(PNG, 'image/png', null)).status, 401); ok('upload needs sign-in');
    assert.equal((await up(Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml')).status, 415); ok('SVG / non-image types refused');
    assert.equal((await up(Buffer.from('not an image'), 'image/png')).status, 400); ok('fake picture (wrong signature) refused');
    const pj = await (await up(PNG, 'image/png')).json(); assert.match(pj.photo, /^[a-f0-9]{32}\.png$/); ok('picture uploaded');
    const img = await fetch(base + '/uploads/' + pj.photo); assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png'); ok('picture is served');
    assert.equal((await call('POST', '/api/medicines', { name: 'Bad', photo: '../../etc/passwd' })).status, 400); ok('photo name validated');
    const withPic = (await call('POST', '/api/medicines', { name: 'Gauze', price: 1000, stock: 5, photo: pj.photo })).body; assert.equal(withPic.photo, pj.photo); ok('item saved with picture');
    const signature = { strokes: [{ color: '#2563eb', points: [[0.1, 0.2], [0.8, 0.7]] }] };
    const dr = (await call('POST', '/api/doctors', { name: 'Dr. Test', role: 'Doctor', code: 'S001', phone: '012 345 678', workdays: 'Mon-Fri', department: 'OPD', specialist: 'Nurse', epf_no: 'EPF-01', basic_salary_cents: 25050, contract_type: 'Permanent', work_location: 'Main Clinic', date_joined: '2026-09-18', signature, photo: pj.photo })).body;
    assert.equal(dr.photo, pj.photo); assert.equal(dr.workdays, 'Mon-Fri'); assert.equal(dr.basic_salary_cents, 25050); assert.deepEqual(JSON.parse(dr.signature), signature); ok('doctor profile saves employment information and signature');
    assert.equal((await call('POST', '/api/doctors', { name: 'Duplicate ID', code: 'S001' })).status, 409); ok('staff IDs are unique');
    const payslip = { doctor_id: dr.id, period_month: 10, period_year: 2026, date_start: '2026-10-01', date_end: '2026-10-31', basic_cents: 25050, position_allowance_cents: 1025, overtime_cents: 500, benefits_cents: 250, deduction_cents: 300, note: 'October payroll' };
    const savedPayslip = await call('POST', '/api/payslips', payslip);
    assert.equal(savedPayslip.status, 201); assert.equal(savedPayslip.body.basic_cents, 25050);
    assert.equal((await call('POST', '/api/payslips', payslip)).status, 400); ok('payslip saves salary breakdown and rejects duplicate month');
    assert.equal((await call('POST', '/api/payslips', { ...payslip, period_month: 11 })).status, 400);
    assert.equal((await call('DELETE', `/api/doctors/${dr.id}`)).status, 409); ok('payslip period is validated and payroll history protects doctor record');
    assert.equal((await up(Buffer.alloc(2.5e6, 1), 'image/png')).status, 413); ok('oversized picture refused');
    await call('DELETE', `/api/medicines/${withPic.id}`); assert.equal((await fetch(base + '/uploads/' + pj.photo)).status, 200); ok('picture kept while another record uses it');
    await call('DELETE', `/api/payslips/${savedPayslip.body.id}`);
    await call('DELETE', `/api/doctors/${dr.id}`); await new Promise((r) => setTimeout(r, 100)); assert.equal((await fetch(base + '/uploads/' + pj.photo)).status, 404); ok('picture file removed when last record is deleted');
    const staff = await call('POST', '/api/users', { email: 'nurse@clinic.test', password: 'password123', role: 'staff' }); assert.equal(staff.status, 201);
    const st = (await call('POST', '/api/auth/login', { email: 'nurse@clinic.test', password: 'password123' })).body.token;
    assert.equal((await call('POST', '/api/symptoms', { name: 'Cough' }, st)).status, 201); ok('staff can create');
    assert.equal((await call('DELETE', `/api/patients/${p.body.id}`, null, st)).status, 403); ok('staff cannot delete');
    assert.equal((await call('GET', '/api/users', null, st)).status, 403); ok('staff cannot list users');
    const cl0 = (await call('GET', '/api/clinic')).body; assert.equal(cl0.currency, 'KHR'); assert.equal(cl0.rate, 4000); assert.equal(cl0.show_name, 1); ok('clinic settings have defaults');
    assert.equal((await call('PUT', '/api/clinic', { name: 'X' }, st)).status, 403); ok('staff cannot change clinic settings');
    const cl1 = (await call('PUT', '/api/clinic', { name: 'Sovanvitou Clinic', specialty: 'Medical doctor', address: 'Phnom Penh', phone: '093 733 375', currency: 'USD', rate: '4100', show_phone: false, logo: pj.photo })).body;
    assert.equal(cl1.name, 'Sovanvitou Clinic'); assert.equal(cl1.currency, 'USD'); assert.equal(cl1.rate, 4100); assert.equal(cl1.show_phone, 0); assert.equal(cl1.logo, pj.photo); ok('admin saves clinic settings');
    assert.equal((await call('PUT', '/api/clinic', { currency: 'EUR' })).status, 400); assert.equal((await call('PUT', '/api/clinic', { rate: 0 })).status, 400); ok('currency and rate validated');
    assert.equal((await call('PUT', '/api/clinic', { logo: '../x' })).status, 400); ok('clinic image name validated');
    await call('PUT', '/api/clinic', { logo: '' }); await new Promise((r) => setTimeout(r, 100)); assert.equal((await fetch(base + '/uploads/' + pj.photo)).status, 404); ok('removed logo file is deleted');
    assert.equal((await call('POST', '/api/auth/password', { current: 'nope', password: 'brand-new-pass' })).status, 403); ok('password change needs current password');
    assert.equal((await call('POST', '/api/auth/password', { current: 'correct-horse', password: 'short' })).status, 400); ok('new password length enforced');
    assert.equal((await call('POST', '/api/auth/password', { current: 'correct-horse', password: 'brand-new-pass' })).status, 200);
    assert.equal((await call('POST', '/api/auth/login', { email: 'admin@clinic.test', password: 'correct-horse' })).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { email: 'admin@clinic.test', password: 'brand-new-pass' })).status, 200); ok('password changed; old one stops working');
    assert.equal((await call('DELETE', `/api/patients/${p.body.id}`)).status, 200); ok('admin can delete');

    // ---- full registration, appointments with time, patient records ----
    const long = 'x'.repeat(1200);
    const pt = (await call('POST', '/api/patients', { name: 'សុខ ដារា', latin_name: 'Sok Dara', phone: '012 111 222', age: 14, age_unit: 'M', sex: 'F', khmer: true, nssf: true, pet: false, nssf_id: 'N-1', national_id: '0123', complaints: long, history: 'None', reg_date: '2026-10-14T08:47', type: 'OPD' })).body;
    assert.equal(pt.latin_name, 'Sok Dara'); assert.equal(pt.nssf, 1); assert.equal(pt.khmer, 1); assert.equal(pt.pet, 0); assert.equal(pt.complaints.length, 1200); assert.equal(pt.age_unit, 'M'); ok('full patient registration saved (long text, flags, age unit)');
    assert.equal((await call('POST', '/api/patients', { name: 'Bad', age_unit: 'Z' })).status, 400); ok('age unit validated');
    assert.equal((await call('POST', '/api/appointments', { name: 'Sok Dara', date: '2026-10-20', time: '09:30', st: 'Waiting' })).body.time, '09:30'); ok('appointment time saved');
    const vit = await call('POST', '/api/records', { patient_id: pt.id, kind: 'vitals', date: '2026-10-14', data: { t: '36.8', hr: '80', bp: '120/80' } });
    assert.equal(vit.status, 201); assert.equal(JSON.parse(vit.body.data).bp, '120/80'); ok('vital signs record saved with JSON data');
    assert.equal((await call('POST', '/api/records', { patient_id: pt.id, kind: 'medical', data: { cc: 'Cough', vacc: ['BCG/HepB'], mt: [['d', 'e', 't']] } })).status, 201); ok('medical record saved');
    assert.equal((await call('POST', '/api/records', { patient_id: pt.id, kind: 'beu', title: 'Before', color: '#ef4444', image: '' })).status, 201); ok('BEU record with label colour saved');
    assert.equal((await call('GET', `/api/records?patient_id=${pt.id}&kind=vitals`)).body.length, 1); assert.equal((await call('GET', `/api/records?patient_id=${pt.id}`)).body.length, 3); ok('records filter by patient and kind');
    assert.equal((await call('POST', '/api/records', { patient_id: pt.id, kind: 'hack' })).status, 400); assert.equal((await call('POST', '/api/records', { patient_id: 99999, kind: 'vitals' })).status, 400);
    assert.equal((await call('POST', '/api/records', { patient_id: pt.id, kind: 'beu', color: 'red' })).status, 400); assert.equal((await call('POST', '/api/records', { kind: 'vitals' })).status, 400); ok('record kind, patient and colour validated');
    assert.equal((await call('POST', '/api/records', { patient_id: pt.id, kind: 'medical', data: 'x'.repeat(61000) })).status, 400); assert.equal((await call('POST', '/api/records', { patient_id: pt.id, kind: 'medical', data: '"just a string"' })).status, 400); ok('record data must be a JSON object under 60 KB');
    const mine = (await call('POST', '/api/records', { patient_id: pt.id, kind: 'consultation', title: 'Staff note' }, st)).body;
    assert.equal((await call('DELETE', `/api/records/${vit.body.id}`, null, st)).status, 403); ok("staff cannot delete someone else's record");
    assert.equal((await call('DELETE', `/api/records/${mine.id}`, null, st)).status, 200); ok('staff can delete their own record');
    const rp = await (await up(PNG, 'image/png')).json();
    const withImg = (await call('POST', '/api/records', { patient_id: pt.id, kind: 'beu', title: 'Photo', image: rp.photo })).body;
    assert.equal((await fetch(base + '/uploads/' + rp.photo)).status, 200);
    assert.equal((await call('DELETE', `/api/patients/${pt.id}`)).status, 200); await new Promise((r) => setTimeout(r, 100));
    assert.equal((await call('GET', `/api/records?patient_id=${pt.id}`)).body.length, 0); assert.equal((await fetch(base + '/uploads/' + rp.photo)).status, 404); ok('deleting a patient removes their records and pictures');

    for (const kind of ['mrd', 'schedulenote', 'cnf', 'schedule', 'treatment', 'allergy', 'vaccination', 'referral', 'diagnosis_history', 'laborder', 'imagingorder']) assert.equal((await call('POST', '/api/records', { patient_id: (await call('POST', '/api/patients', { name: 'K' + kind })).body.id, kind, title: 'Standard', data: { x: 1 } })).status, 201); ok('MRD, follow-up, clinical orders, and six new patient modules are accepted');
    const ct = (await call('PUT', '/api/clinic', { cnf_text: { acc: 'Custom wording' } })).body; assert.equal(JSON.parse(ct.cnf_text).acc, 'Custom wording'); assert.equal(JSON.parse((await call('GET', '/api/clinic')).body.cnf_text).acc, 'Custom wording'); ok('consultation-form agreement text saved in clinic settings');
    const idx = await fetch(base + '/'); assert.equal(idx.status, 200); assert.ok((await idx.text()).includes('SOVANVITOU')); ok('frontend served');
    assert.equal((await fetch(base + '/app.js')).status, 200); assert.equal((await fetch(base + '/styles.css')).status, 200); ok('frontend script and styles served');
    assert.equal((await fetch(base + '/..%2fserver.js')).status, 403); ok('path traversal blocked');
    console.log('\nAll tests passed.');
    process.exitCode = 0;
  } catch (e) { console.error('\nFAILED:', e.message, e.cause || '', e.stack); process.exitCode = 1; }
  server.close(async () => {
    try { await close(); } catch {}
    process.exit(process.exitCode);
  });
});
