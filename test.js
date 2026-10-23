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
  let token = null, medicineSaleItem = null, medicineSaleId = null;
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
    const sampleFile = await call('POST', '/api/files', { name: 'Clinic letter', content: '<p onclick="x()">Clinic <strong>hours</strong></p><script>alert(1)</script><img src="javascript:alert(1)">' });
    assert.equal(sampleFile.status, 201);
    assert.equal(sampleFile.body.content, '<p>Clinic <strong>hours</strong></p>');
    assert.equal((await call('PUT', `/api/files/${sampleFile.body.id}`, { content: '<p>Updated safely</p>' })).body.content, '<p>Updated safely</p>');
    assert.equal((await call('POST', '/api/ocr', {}, null)).status, 401);
    assert.equal((await call('POST', '/api/ocr', {})).status, 415);
    const invalidOcrImage = await fetch(base + '/api/ocr', { method: 'POST', headers: { 'Content-Type': 'image/png', Authorization: 'Bearer ' + token }, body: Buffer.from('not an image') });
    assert.equal(invalidOcrImage.status, 400);
    ok('sample file templates save sanitized rich text and OCR rejects unauthenticated or invalid images');
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
    const expense = await call('POST', '/api/expenses', { name: 'Clinic supplies', category: 'Supplies', date: '2026-10-22', unit_price: 2000, quantity: 2, amount: 4000, notes: 'Monthly purchase' });
    assert.equal(expense.status, 201); assert.equal(expense.body.amount, 4000);
    const savedExpense = (await call('GET', '/api/expenses?limit=5000')).body[0];
    assert.equal(savedExpense.name, 'Clinic supplies');
    assert.equal(savedExpense.unit_price, 2000);
    assert.equal(savedExpense.quantity, 2);
    assert.equal(savedExpense.notes, 'Monthly purchase');
    assert.equal((await call('POST', '/api/expenses', { name: 'Invalid date', date: '2026-02-30', amount: 100 })).status, 400);
    assert.equal((await call('POST', '/api/expenses', { name: 'Mismatched total', date: '2026-10-22', unit_price: 2000, quantity: 2, amount: 3000 })).status, 400);
    assert.equal((await call('DELETE', `/api/expenses/${expense.body.id}`, null, token)).status, 200);
    ok('report expenses can be saved, listed, date-validated and deleted');

    const diagnosisWorkbook = new ExcelJS.Workbook();
    const diagnosisSheet = diagnosisWorkbook.addWorksheet('Diagnoses');
    diagnosisSheet.addRow(['Diagnosis Name']);
    diagnosisSheet.addRow(['Imported diagnosis from Excel']);
    const diagnosisXlsx = await fetch(base + '/api/diagnoses/import-xlsx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Authorization: 'Bearer ' + token },
      body: Buffer.from(await diagnosisWorkbook.xlsx.writeBuffer()),
    });
    assert.equal(diagnosisXlsx.status, 201); assert.equal((await diagnosisXlsx.json()).imported, 1);
    assert.equal((await call('GET', '/api/diagnoses?q=Imported diagnosis from Excel')).body[0].name, 'Imported diagnosis from Excel');
    const diagnosisCsv = await fetch(base + '/api/diagnoses/import-xlsx', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv; charset=utf-8', Authorization: 'Bearer ' + token },
      body: 'diagnosis\n"Imported, quoted diagnosis"\n',
    });
    assert.equal(diagnosisCsv.status, 201); assert.equal((await diagnosisCsv.json()).imported, 1);
    assert.equal((await call('GET', '/api/diagnoses?q=' + encodeURIComponent('Imported, quoted diagnosis'))).body[0].name, 'Imported, quoted diagnosis');
    ok('diagnosis imports accept Excel workbooks and quoted CSV rows');

    const med = (await call('POST', '/api/medicines', { name: 'Paracetamol', price: 500, stock: 10 })).body;
    const detailedMedicine = await call('POST', '/api/medicines', {
      name: 'Paracetamol 500mg', composition: 'Paracetamol 500mg', stock: 100,
      units: JSON.stringify([{ name: 'Tablet', price: 1000, qty: 1 }, { name: 'Box', price: 9000, qty: 10 }]),
      price: 1000, expiration_date: '2027-06-30', notification_date: '2027-05-30',
    });
    assert.equal(detailedMedicine.status, 201);
    assert.equal(detailedMedicine.body.composition, 'Paracetamol 500mg');
    assert.deepEqual(JSON.parse(detailedMedicine.body.units), [{ name: 'Tablet', price: 1000, qty: 1 }, { name: 'Box', price: 9000, qty: 10 }]);
    assert.equal(detailedMedicine.body.expiration_date, '2027-06-30');
    const qrCode = await call('GET', `/api/medicines/${detailedMedicine.body.id}/code/qr`);
    const barCode = await call('GET', `/api/medicines/${detailedMedicine.body.id}/code/barcode`);
    assert.equal(qrCode.status, 200); assert.match(qrCode.body.svg, /^<svg/);
    assert.equal(barCode.status, 200); assert.match(barCode.body.svg, /^<svg/); ok('medicine QR and Code 128 barcode labels generate as SVG');
    for (const kind of ['qr', 'barcode']) {
      const response = await fetch(`${base}/api/medicines/codes/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ ids: [med.id, detailedMedicine.body.id] }),
      });
      const svg = await response.text();
      assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /image\/svg\+xml/);
      assert.match(response.headers.get('content-disposition'), new RegExp(`medicine-${kind}-codes\\.svg`));
      assert.equal((svg.match(/<svg/g) || []).length, 3);
      assert.ok(svg.includes('Paracetamol') && svg.includes('Paracetamol 500mg'));
    }
    assert.equal((await call('POST', '/api/medicines/codes/qr', { ids: [med.id, 0] })).status, 400);
    ok('bulk QR and barcode exports include all requested medicines in downloadable SVG sheets');
    assert.equal((await call('GET', '/api/medicines?q=500mg')).body[0].id, detailedMedicine.body.id);
    assert.equal((await call('POST', '/api/medicines', { name: 'Bad date', expiration_date: '2026-99-99' })).status, 400);
    assert.equal((await call('POST', '/api/medicines', { name: 'Bad unit', units: JSON.stringify([{ name: '', price: 500, qty: 1 }]) })).status, 400); ok('medicine details, multiple sales units, expiry dates, and validation persist');
    const medicineWorkbook = new ExcelJS.Workbook(), medicineSheet = medicineWorkbook.addWorksheet('Medicines');
    medicineSheet.addRow(['Drug name', 'Composition', 'In Stock', 'Units', 'Expiry date', 'Reminder date']);
    medicineSheet.addRow(['Imported medicine', '250mg', 40, JSON.stringify([{ name: 'Capsule', price: 'KHR 3,000', qty: 1 }]), new Date('2027-08-01T00:00:00Z'), new Date('2027-07-01T00:00:00Z')]);
    const medicineWorkbookBytes = Buffer.from(await medicineWorkbook.xlsx.writeBuffer());
    const medicineImport = await fetch(base + '/api/medicines/import-xlsx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Authorization: 'Bearer ' + token },
      body: medicineWorkbookBytes,
    });
    assert.equal(medicineImport.status, 201); assert.equal((await medicineImport.json()).imported, 1);
    const importedMedicine = (await call('GET', '/api/medicines?q=Imported medicine')).body[0];
    assert.equal(importedMedicine.composition, '250mg'); assert.equal(importedMedicine.stock, 40); assert.equal(importedMedicine.price, 3000);
    assert.deepEqual(JSON.parse(importedMedicine.units), [{ name: 'Capsule', price: 3000, qty: 1 }]); ok('medicines can be imported from Excel workbooks');
    const invalidMedicineBook = new ExcelJS.Workbook(), invalidMedicineSheet = invalidMedicineBook.addWorksheet('Medicines');
    invalidMedicineSheet.addRow(['Name', 'Price']); invalidMedicineSheet.addRow(['Broken price', 'not a number']);
    const invalidMedicineResponse = await fetch(base + '/api/medicines/import-xlsx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Authorization: 'Bearer ' + token },
      body: Buffer.from(await invalidMedicineBook.xlsx.writeBuffer()),
    });
    assert.equal(invalidMedicineResponse.status, 400);
    assert.match((await invalidMedicineResponse.json()).error, /Row 2: Price must be a whole KHR amount/);
    assert.equal((await call('GET', '/api/medicines?q=Broken price')).body.length, 0); ok('invalid medicine prices report their Excel row and leave imports unchanged');
    let s = await call('POST', '/api/sales', { method: 'Cash', items: [{ medicine_id: med.id, qty: 4 }] });
    assert.equal(s.status, 201); assert.equal(s.body.total, 2000); ok('sale uses DB price and totals correctly');
    const medicineReport = await call('GET', '/api/reports/medicine-sales?limit=5000');
    assert.equal(medicineReport.status, 200);
    assert.ok(medicineReport.body.some(item => item.name === 'Paracetamol' && item.qty === 4 && item.total === 2000));
    medicineSaleItem = medicineReport.body.find(item => item.name === 'Paracetamol' && item.qty === 4);
    medicineSaleId = medicineSaleItem.sale_id;
    assert.equal((await call('GET', '/api/reports/medicine-sales?from=2026-02-30')).status, 400);
    assert.equal((await call('GET', '/api/reports/medicine-sales?from=2026-99-99')).status, 400);
    const filteredMedicineReport = await call('GET', `/api/reports/medicine-sales?from=${medicineSaleItem.date}&to=${medicineSaleItem.date}`);
    assert.ok(filteredMedicineReport.body.some(item => item.item_id === medicineSaleItem.item_id));
    ok('medicine sales report returns itemized sale rows with date filters');
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
    assert.equal((await call('DELETE', `/api/sales/${medicineSaleId}/items/${medicineSaleItem.item_id}`, null, st)).status, 403);
    assert.equal((await call('DELETE', `/api/sales/${medicineSaleId}/items/${medicineSaleItem.item_id}`)).status, 200);
    assert.equal((await call('GET', `/api/medicines/${med.id}`)).body.stock, 10);
    assert.equal((await call('GET', '/api/reports/medicine-sales')).body.some(item => item.item_id === medicineSaleItem.item_id), false);
    ok('admin can delete a medicine sale row and stock is restored; staff cannot');
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
    const printSettings = (await call('PUT', '/api/clinic', { print_header: 'Clinic print heading', print_footer: 'Clinic contact footer' })).body;
    assert.equal(printSettings.print_header, 'Clinic print heading'); assert.equal(printSettings.print_footer, 'Clinic contact footer');
    const ct = (await call('PUT', '/api/clinic', { cnf_text: { acc: 'Custom wording' } })).body; assert.equal(JSON.parse(ct.cnf_text).acc, 'Custom wording'); assert.equal(JSON.parse((await call('GET', '/api/clinic')).body.cnf_text).acc, 'Custom wording'); ok('custom shared print header/footer and consultation wording save in clinic settings');
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
