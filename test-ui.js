'use strict';
// UI logic test: runs the real frontend scripts (app.js + patient.js) in a simulated browser against a live server.
const os = require('os'), path = require('path'), fs = require('fs'), vm = require('vm'), assert = require('assert');
const ExcelJS = require('exceljs');
process.env.NODE_ENV = 'test';
process.env.USE_MEM_DB = 'true';
process.env.JWT_SECRET = 'y'.repeat(40);
const { server } = require('./server');
const { close } = require('./db');

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const ok = (n) => console.log('  ✓', n);
  const el = () => new Proxy({ dataset: { mode: 'manual' }, classList: { add() {}, remove() {}, toggle() {} }, style: {}, value: '', hidden: false, innerHTML: '', textContent: '', insertAdjacentHTML() {}, querySelector: () => el(), querySelectorAll: () => [] }, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  const els = {}; const downloads = []; const listeners = {}, windowListeners = {}, location = { hash: '' };
  const sessionValues = {};
  const ctx = vm.createContext({
    console, URL, setTimeout, clearTimeout, Promise, Intl, Date,
    document: { querySelector: (s) => (els[s] = els[s] || el()), querySelectorAll: () => [], addEventListener: (type, fn) => (listeners[type] = [...(listeners[type] || []), fn]), createElement: () => ({ click() { downloads.push(this); }, style: {} }), createTreeWalker: () => ({ nextNode: () => false }), body: { querySelectorAll: () => [] }, documentElement: { dataset: {}, lang: 'en' } },
    window: { location, addEventListener: (type, fn) => (windowListeners[type] = [...(windowListeners[type] || []), fn]), print() {} }, location, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: (key) => sessionValues[key] || null, setItem: (key, value) => { sessionValues[key] = String(value); }, removeItem: (key) => { delete sessionValues[key]; } }, MutationObserver: class { observe() {} }, NodeFilter: { SHOW_TEXT: 4 },
    matchMedia: () => ({ matches: false }), requestAnimationFrame: (f) => f(), confirm: () => true,
    fetch: (u, o) => fetch(base + u, o),
    FormData: class { constructor(f) { this.m = (f && f.__m) || {}; } get(k) { return this.m[k] ?? null; } getAll(k) { return [].concat(this.m[k] ?? []); } [Symbol.iterator]() { return Object.entries(this.m)[Symbol.iterator](); } },
    Blob: class { constructor(p) { this.p = p; } },
  });
  ctx.URL = Object.assign(function () {}, { createObjectURL: (b) => { downloads.blob = b; return 'blob:x'; }, revokeObjectURL() {} });
  const frontendDir = fs.existsSync(path.resolve(__dirname, '../frontend')) ? path.resolve(__dirname, '../frontend') : path.join(__dirname, 'public');
  vm.runInContext(fs.readFileSync(path.join(frontendDir, 'app.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(frontendDir, 'patient.js'), 'utf8'), ctx);
  const run = (code) => vm.runInContext(code, ctx);
  ctx.__nativeOpenForm = run('openForm');
  ctx.__nativePrintDoc = run('printDoc');
  try {
    await (await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.cc', password: 'password123' }) })).json();
    run(`tok=null`); const lg = await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.cc', password: 'password123' }) })).json();
    ctx.__t = lg.token; run('tok=__t; toast=function(m){__toast=m}'); await run('load()'); ok('app loads data from the API');
    run(`D.billing=[{kind:'payment',date:'2026-10-02',data:'{"amount":6000}'}];D.sales=[{created_at:'2026-10-03',total:4000}];D.expenses=[{date:'2026-10-04',amount:3000}];D.medicineSales=[{date:'2026-10-05',name:'Clinic medicine',qty:5},{date:'2026-09-30',name:'Outside period',qty:20}];D.ap=[{date:'2026-10-06',svc:'Consultation',st:'Done'},{date:'2026-10-07',svc:'Consultation',st:'Waiting'},{date:'2026-10-08',svc:'Lab test',st:'Done'},{date:'2026-10-09',svc:'Cancelled service',st:'Cancelled'}];analyticsFrom='2026-10-01';analyticsTo='2026-10-31';analyticsPeriod='monthly'`);
    const analyticsModel = run('analyticsRecords()'), analyticsHtml = run('R.an()');
    assert.equal(analyticsModel.series.length, 1); assert.equal(analyticsModel.series[0].income, 10000); assert.equal(analyticsModel.series[0].expenses, 3000);
    assert.deepEqual(Array.from(analyticsModel.medicines, item => item.name), ['Clinic medicine']);
    assert.deepEqual(Array.from(analyticsModel.services, item => [item.name, item.value]), [['Consultation', 2], ['Lab test', 1]]);
    for (const section of ['Analytics Dashboard', 'Start Date', 'End Date', 'Daily', 'Monthly', 'Yearly', 'Clear Filters', 'Income vs. Expenses', 'Top Selling Medicines', 'Top Selling Services', 'Clinic medicine', 'Consultation']) assert.ok(analyticsHtml.includes(section), 'Analytics dashboard should include ' + section);
    assert.ok(analyticsHtml.includes('Income: KHR 10,000') && analyticsHtml.includes('Expense: KHR 3,000'), 'financial chart should use payment, POS sales, and expense totals');
    run(`rt='an'`);
    listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'analytics-period:yearly' } }) }, preventDefault() {} });
    assert.equal(run('analyticsPeriod'), 'yearly'); assert.ok(els['#v'].innerHTML.includes('aria-pressed="true">Yearly'));
    listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'analytics-clear' } }) }, preventDefault() {} });
    assert.equal(run('analyticsPeriod'), 'daily'); assert.equal(run('analyticsFrom'), ''); assert.equal(run('analyticsTo'), '');
    run(`D.billing=[];D.sales=[];D.expenses=[];D.medicineSales=[];D.ap=[];analyticsFrom='';analyticsTo='';analyticsPeriod='daily'`);
    ok('Analytics dashboard filters financial charts and summarizes top medicines and services');
    run(`rt='da';D.dr=[{id:1,name:'Dr A'},{id:2,name:'Dr B'}];D.ap=[{doc:'Dr A',name:'Patient One',phone:'012 345',date:'2026-10-02',st:'Done'},{doc:'Dr A',name:'Patient One',phone:'012345',date:'2026-10-03',st:'Waiting'},{doc:'Dr A',name:'Patient Two',phone:'099',date:'2026-10-04',st:'Done'},{doc:'Dr A',name:'Outside patient',phone:'088',date:'2026-09-30',st:'Done'},{doc:'Dr B',name:'Cancelled patient',phone:'077',date:'2026-10-02',st:'Cancelled'}];doctorAnalyticsFrom='2026-10-01';doctorAnalyticsTo='2026-10-31';doctorAnalyticsId=''`);
    const doctorRows = run('doctorAnalyticsRows()'), doctorAnalyticsHtml = run('R.da()');
    assert.deepEqual(Array.from(doctorRows, row => [row.name, row.count]), [['Dr A', 2], ['Dr B', 0]]);
    for (const field of ['Overview of patient assignments per doctor.', 'Filters', 'Start Date', 'End Date', 'All Doctors', 'Clear Filters', 'Patients per Doctor', 'Number of Patients']) assert.ok(doctorAnalyticsHtml.includes(field), 'Doctor Analytics should include ' + field);
    assert.ok(doctorAnalyticsHtml.includes('viewBox="0 0 1100 270"'), 'Doctor Analytics chart should keep a compact height to fit the page');
    assert.ok(doctorAnalyticsHtml.includes('doctor-analytics-tooltip') && doctorAnalyticsHtml.includes('Dr A') && doctorAnalyticsHtml.includes('Number of Patients: 2') && doctorAnalyticsHtml.includes('tabindex="0"'), 'Doctor Analytics chart bars should expose an accessible hover and keyboard tooltip');
    run(`doctorAnalyticsId='dr a'`);
    assert.deepEqual(Array.from(run('doctorAnalyticsRows()'), row => [row.name, row.count]), [['Dr A', 2]]);
    const doctorFilterChange = { target: { id: 'doctor-analytics-doctor', value: '' } };
    listeners.change.forEach(listener => listener(doctorFilterChange));
    assert.equal(run('doctorAnalyticsId'), ''); assert.ok(els['#v'].innerHTML.includes('Dr B'));
    listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'doctor-analytics-clear' } }) }, preventDefault() {} });
    assert.equal(run('doctorAnalyticsFrom'), ''); assert.equal(run('doctorAnalyticsTo'), '');
    run(`D.dr=[];D.ap=[];doctorAnalyticsFrom='';doctorAnalyticsTo='';doctorAnalyticsId=''`);
    ok('Doctor Analytics filters date and doctor, counts unique assigned patients, and retains doctors with no assignments');
    const rxMedicineResponse = await fetch(base + '/api/medicines', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lg.token }, body: JSON.stringify({ name: 'Prescription test medicine', price: 1000, stock: 12 }) });
    ctx.__rxMedicine = await rxMedicineResponse.json(); run('D.med.push(__rxMedicine);rt="rx"');
    const rxPage = run('R.rx()');
    assert.ok(rxPage.includes('Add Template'), 'prescription template page should label the add action');
    run('rxTemplateForm()'); let rxHtml = els['#mf'].innerHTML;
    for (const must of ['Create Template', 'Disease Name', 'Search Medicine', 'Save Template', 'rx-prescription-table', 'ព្រឹក', 'ថ្ងៃ', 'ល្ងាច']) assert.ok(rxHtml.includes(must), 'prescription template form missing ' + must);
    run('toggleRxMedicine(__rxMedicine.id)');
    assert.ok(run('rxMedicineRows()').includes('Prescription test medicine') && run('rxTemplateRows()').includes(`data-rx-id="${ctx.__rxMedicine.id}"`) && run('rxTemplateRows()').includes('data-rx-field="morning"'), 'selected medicine should appear in the dose table');
    els['#mf'].__m = { name: 'Template test disease' };
    listeners.input[1]({ target: { id: '', classList: { contains: name => name == 'rx-dose-input' }, dataset: { rxId: String(ctx.__rxMedicine.id), rxField: 'morning' }, value: '1 tablet' } });
    listeners.input[1]({ target: { id: '', classList: { contains: name => name == 'rx-dose-input' }, dataset: { rxId: String(ctx.__rxMedicine.id), rxField: 'duration' }, value: '5' } });
    await run(`$('#mf').onsubmit({preventDefault(){}})`);
    let rxTemplate = run(`D.rx.find(item=>item.name=='Template test disease')`);
    assert.ok(rxTemplate); assert.equal(JSON.parse(rxTemplate.meds)[0].morning, '1 tablet'); assert.equal(JSON.parse(rxTemplate.meds)[0].duration, '5');
    run(`rxTemplateForm(D.rx.indexOf(D.rx.find(item=>item.name=='Template test disease')))`);
    assert.ok(els['#mf'].innerHTML.includes('1 tablet') && els['#mf'].innerHTML.includes('Update Template'));
    ok('prescription template editor supports medicine selection, dosage fields and saved edits');
    run(`rt='sf';q=''`);
    const sampleFileList = run('R.sf()');
    assert.ok(sampleFileList.includes('Add Template'), 'Sample file page should expose Add Template');
    run('sampleFileForm()');
    for (const field of ['Create New Template', 'name="name"', 'Template Title', 'contenteditable="true"', 'data-sample-command="fontName"', 'data-a="sampleformat:bold"', 'data-a="samplefileimage"', 'Upload Image (OCR)', 'Save']) assert.ok(els['#mf'].innerHTML.includes(field), 'Sample file editor should include ' + field);
    const sampleEditor = { innerHTML: '<p>Patient <strong>instructions</strong></p>' };
    els['#mf'].querySelector = selector => selector == '.sample-file-editor-body' ? sampleEditor : null;
    els['#mf'].__m = { name: 'Patient instructions' };
    await run(`$('#mf').onsubmit({preventDefault(){}})`);
    const savedSample = run(`D.sf.find(item=>item.name=='Patient instructions')`);
    assert.ok(savedSample && savedSample.content.includes('<strong>instructions</strong>'), 'Sample file template should save rich editor content');
    run(`sampleFileForm(D.sf.indexOf(D.sf.find(item=>item.name=='Patient instructions')))`);
    assert.ok(els['#mf'].innerHTML.includes('Patient instructions') && els['#mf'].innerHTML.includes('<strong>instructions</strong>'), 'Sample file editor should reopen saved template for editing');
    let ocrTextInserted = '';
    ctx.document.execCommand = (command, _, value) => { if (command === 'insertText') ocrTextInserted = value; };
    const savedFetch = ctx.fetch;
    ctx.fetch = async (url, options) => {
      assert.ok(url.endsWith('/api/ocr') && options.method === 'POST', 'OCR image should be sent to the authenticated OCR endpoint');
      return { ok: true, json: async () => ({ text: 'Text from scanned form' }) };
    };
    ctx.__ocrImage = { type: 'image/png', size: 100 };
    await run('sampleFileUploadImage(__ocrImage)');
    assert.equal(ocrTextInserted, 'Text from scanned form', 'recognized OCR text should be inserted into the rich text editor');
    ctx.fetch = savedFetch;
    delete ctx.document.execCommand;
    ok('Sample file templates support rich-text create/edit and image OCR text insertion');
    const medicineSaleResponse = await fetch(base + '/api/sales', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lg.token }, body: JSON.stringify({ method: 'Cash', items: [{ medicine_id: ctx.__rxMedicine.id, qty: 2 }] }) });
    assert.equal(medicineSaleResponse.status, 201);
    await run('load()');
    let medicineReportHtml = run('R.mr()');
    for (const must of ['medicine-report-from', 'medicine-report-to', 'Quantity sold', 'Total revenue', 'Medicine name', 'Date sold', 'Quantity', 'Total', 'Prescription test medicine', 'KHR 2,000', 'data-a="medreportexport"', 'data-a="medreportdelete:']) assert.ok(medicineReportHtml.includes(must), 'medicine report should include ' + must);
    const medicineSaleDate = run('D.medicineSales[0].date');
    const medicineReportFromField = run("$('#medicine-report-from')"), medicineReportToField = run("$('#medicine-report-to')");
    medicineReportFromField.value = medicineSaleDate;
    medicineReportToField.value = medicineSaleDate;
    await run('medicineReportApply()');
    assert.ok(run('R.mr()').includes('Prescription test medicine'), 'medicine report search should return the selected date');
    medicineReportFromField.value = '2999-01-01';
    medicineReportToField.value = '2999-01-31';
    await run('medicineReportApply()');
    assert.ok(run('R.mr()').includes('No medicine sales found for this date range.'), 'medicine report date filters should exclude rows outside the selected dates');
    medicineReportFromField.value = '';
    medicineReportToField.value = '';
    await run('medicineReportApply()');
    ok('medicine report displays itemized POS sales, summary totals, date filters and export/delete actions');
    run(`rt='bill';reportFrom='';reportTo='';reportQuery='';reportRange=''`);
    let reportHtml = run('R.bill()');
    for (const must of ['Search patient', 'report-from', 'report-to', 'Patient Payments', 'POS Sales', 'Total Income', 'Expenses', 'Bill Summary', 'Payroll Report', 'Add Expense', 'Income', 'report-ledgers']) assert.ok(reportHtml.includes(must), 'financial report missing ' + must);
    const expensePriceInput = { value: '', addEventListener(type, handler) { this.oninput = handler; } };
    const expenseQuantityInput = { value: '1', addEventListener(type, handler) { this.oninput = handler; } };
    const expenseTotalInput = { value: '' };
    els['#mf'].querySelector = selector => selector.includes('unit_price') ? expensePriceInput : selector.includes('quantity') ? expenseQuantityInput : expenseTotalInput;
    run('reportExpenseForm()');
    for (const field of ['name="date"', 'name="name"', 'name="category"', 'name="unit_price"', 'name="quantity"', 'name="total"', 'name="notes"', 'Save Expense']) assert.ok(els['#mf'].innerHTML.includes(field), 'expense dialog should include ' + field);
    assert.ok(!els['#mf'].innerHTML.includes('name="payee"') && !els['#mf'].innerHTML.includes('name="amount"'), 'expense dialog should use unit price and quantity instead of payee and manual total');
    expensePriceInput.value = '2000'; expensePriceInput.oninput();
    assert.equal(expenseTotalInput.value, '2,000', 'unit price entry updates the computed total using current quantity');
    expenseQuantityInput.value = '2';
    expenseQuantityInput.oninput();
    assert.equal(expenseTotalInput.value, '4,000', 'total should equal unit price multiplied by quantity');
    els['#mf'].__m = { name: 'Test report expense', category: 'Supplies', date: '2026-10-22', unit_price: '2000', quantity: '2', amount: '4000', notes: 'Test note' };
    await run(`$('#mf').onsubmit({preventDefault(){}})`);
    const reportExpense = run(`D.expenses.find(item=>item.name=='Test report expense')`);
    assert.ok(reportExpense); assert.equal(reportExpense.amount, 4000); assert.equal(reportExpense.unit_price, 2000); assert.equal(reportExpense.quantity, 2); assert.equal(reportExpense.notes, 'Test note');
    reportHtml = run('R.bill()');
    assert.ok(reportHtml.includes('Test report expense') && reportHtml.includes('KHR 4,000'));
    run(`reportQuery='not found'`);
    assert.ok(!run('R.bill()').includes('Test report expense'));
    run(`reportQuery='';reportFrom='2026-10-23';reportTo='2026-10-24'`);
    assert.ok(!run('R.bill()').includes('Test report expense'));
    run(`reportFrom='';reportTo='';reportRange=''`);
    ok('financial report filters and displays saved expenses with summary and print/export actions');
    for (const page of ['ap', 'ipd', 'cur', 'med', 'set']) {
      listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'go:' + page } }) }, preventDefault() {} });
      assert.equal(sessionValues.currentPage, page); assert.equal(location.hash, '#' + page);
      sessionValues.currentPage = '';
      run(`rt='dash';restorePage()`);
      assert.equal(run('rt'), page);
    }
    run(`rt='dash';pAct('dashap')`);
    assert.equal(sessionValues.currentPage, 'ap', 'dashboard appointment shortcut should persist the appointments page');
    for (const page of ['ap', 'ipd', 'cur']) {
      sessionValues.currentPage = ''; location.hash = '#' + page;
      run(`rt='dash';restorePage()`);
      assert.equal(run('rt'), page, `${page} must be accepted as a valid saved route despite using the generic table renderer`);
    }
    location.hash = '#ipd'; windowListeners.hashchange[0](); assert.equal(run('rt'), 'ipd', 'browser history changes should switch to the route in the URL');
    run(`cal.mode='month';rt='dash'`);
    sessionValues.currentPage = 'unknown'; location.hash = '#unknown'; run(`rt='dash';restorePage()`); assert.equal(run('rt'), 'dash');
    ok('refresh restores Appointments, IPD, Current IPD, and other pages from this browser tab');

    run(`rt='dr';doctorForm()`); let doctorHtml = els['#mf'].innerHTML;
    for (const must of ['Add Doctor', 'Upload Photo', 'Staff ID (Required for Login)', 'Work Shift / Days', 'Department', 'Basic Salary ($)', 'Date Of Joining', 'Signature', 'drsig', 'drsigclear', 'Cancel', 'Save']) assert.ok(doctorHtml.includes(must), 'doctor form missing ' + must + ': ' + doctorHtml);
    run(`doctorSignature={strokes:[{color:'#2563eb',points:[[0.1,0.2],[0.8,0.7]]}]}`);
    els['#mf'].__m = { name: 'Dr. Follow-up', code: 'S002', role: 'Doctor', phone: '012 555 000', workdays: 'Mon-Fri', department: 'OPD', specialist: 'Nurse', basic_salary: '250.50', contract_type: 'Permanent', work_location: 'Main Clinic', date_joined: '2026-09-18', photo: '' };
    await run(`$('#mf').onsubmit({preventDefault(){}})`);
    const doctor = run(`D.dr.find(x=>x.code=='S002')`);
    assert.ok(doctor); assert.equal(doctor.workdays, 'Mon-Fri'); assert.equal(doctor.department, 'OPD'); assert.equal(doctor.basic_salary_cents, 25050); assert.equal(JSON.parse(doctor.signature).strokes[0].points.length, 2);
    run('doctorProfileId=null'); const doctorCards = run('R.dr()');
    assert.ok(doctorCards.includes(`data-a="doctorhistory:${doctor.id}"`) && doctorCards.includes('title="Doctor history"'), 'doctor card should include history action');
    run(`openDoctorHistory('${doctor.id}')`);
    assert.equal(run('doctorTab'), 'timeline'); assert.ok(run('R.dr()').includes('Employment Timeline'), 'history action should open the doctor timeline');
    run(`doctorForm(D.dr.indexOf(D.dr.find(x=>x.code=='S002')))`);
    assert.ok(els['#mf'].innerHTML.includes('Edit Doctor') && els['#mf'].innerHTML.includes('Mon-Fri'));
    run(`openDoctorProfile(${doctor.id})`); let doctorProfile = run('R.dr()');
    for (const must of ['Payroll', 'Total Net Salary Paid', 'Total Gross Salary', 'Total Earning', 'Total Deduction', 'Add Payslip', 'No payslips available']) assert.ok(doctorProfile.includes(must), 'doctor profile payroll view missing ' + must);
    run(`payrollForm(${doctor.id})`); doctorHtml = els['#mf'].innerHTML;
    for (const must of ['Add New Payslip', 'period_month', 'period_year', 'date_start', 'date_end', 'Position Allowance', 'Overtime / Extra', 'Other Benefits', 'Deduction', 'Calculated Net Salary']) assert.ok(doctorHtml.includes(must), 'payslip form missing ' + must);
    els['#mf'].__m = { period_month: '10', period_year: '2026', date_start: '2026-10-01', date_end: '2026-10-31', basic_cents: '250.50', position_allowance_cents: '10.25', overtime_cents: '5', benefits_cents: '2.50', deduction_cents: '3', note: 'October payroll' };
    await run(`$('#mf').onsubmit({preventDefault(){}})`);
    const slip = run(`D.payslips.find(x=>x.doctor_id==${doctor.id})`);
    assert.ok(slip); assert.equal(slip.basic_cents, 25050); assert.equal(slip.deduction_cents, 300); assert.equal(slip.period_month, 10);
    doctorProfile = run('R.dr()'); assert.ok(doctorProfile.includes('PAY-' + slip.id) && doctorProfile.includes('$265.25'));
    ok('doctor profile shows payroll history and saved payslips with net salary');

    // registration with age modes, flags and vital signs
    run('openForm=function(t,b,s,o){__body=b;__save=s;__opts=o}'); run('regForm()');
    for (const must of ['Basic information', 'Demographics', 'data-a="agem:dob"', 'name="nssf_id"', 'name="complaints"', 'name="reg_date"', 'data-a="vsbtn"', 'Register Patient']) assert.ok((ctx.__body + ctx.__opts.ok + ctx.__opts.extra).includes(must), 'registration form missing ' + must);
    ok('registration form has every section from the screenshot');
    ctx.__f = { __m: { name: 'Test Patient', latin_name: 'Latin', phone: '012 999', age: '14', age_unit: 'M', sex: 'F', khmer: '1', nssf: '1', pet: null, nssf_id: 'N1', national_id: 'ID9', complaints: 'cough', history: '', addr: 'Phnom Penh', reg_date: '2026-10-14T08:47', vs_t: '37.2', vs_bp: '110/70' } };
    await run('__save(__f)'); const p = run('D.pt.find(x=>x.name=="Test Patient")'); assert.ok(p); assert.equal(p.nssf, 1); assert.equal(p.pet, 0); assert.equal(p.age, 14); assert.equal(p.age_unit, 'M');
    assert.equal(run(`fmtAge(D.pt.find(x=>x.name=="Test Patient"))`), '1 y 2 m'); ok('patient registered; 14 months shown as "1 y 2 m"');
    ctx.__f = { __m: { name: 'Baby', age: '', age_unit: 'Y', dob: '2026-04-14', khmer: '1' } }; run('__body=null'); run('$("#agebox").dataset.mode="dob"'); await run('__save(__f)'); const baby = run('D.pt.find(x=>x.name=="Baby")'); assert.equal(baby.age_unit, 'M'); assert.ok(baby.age >= 5 && baby.age <= 7); ok('date-of-birth mode computes age in months');

    // patient file
    await run(`openPatient(${p.id})`); assert.equal(run('rt'), 'pd');
    let html = run('R.pd()'); for (const must of ['Test Patient', 'Vital signs', 'Medical Record', 'MD History', 'BEU', 'Treatment Schedule', 'Consultation', 'Operation', 'ស្នើសុំពិនិត្យ', 'Homecare', 'Allergy History', 'Vaccination', 'Referral', 'Diagnosis History', 'Lab Orders', 'Imaging Orders', 'NSSF ID', 'National ID', 'id="pdd"']) assert.ok(html.includes(must), 'patient file missing ' + must);
    assert.equal(run('PT.length'), 23, 'Patient Management should show exactly 23 sections');
    ok('patient file displays all 23 Patient Management sections');
    assert.ok(html.includes('37.2') && html.includes('110/70'), 'vitals entered at registration should show'); ok('patient file shows header, menu and the vital signs entered at registration');
    await run(`api('POST','records',{patient_id:pdId,kind:'vaccination',title:'Child vaccines',date:'2026-10-23',data:{category:'child',vaccine_group:'Child vaccines',doses:[{vaccine:'BCG',date:'2026-10-23',given:true,notes:'Lot A'}],administered_by:'Nurse Lee'}})`);
    await run('loadRecs()');
    const vaccination = run(`recs.find(r=>r.kind=='vaccination')`), vaccinationCardHtml = run(`recCard(recs.find(r=>r.kind=='vaccination'))`);
    assert.ok(vaccinationCardHtml.includes(`data-a="vaxprint:${vaccination.id}"`) && vaccinationCardHtml.includes('🖨'), 'vaccination records should include a printer icon');
    run(`__printed=null;printDoc=(title,html)=>{__printed={title,html}};pAct('vaxprint','${vaccination.id}')`);
    const printedVaccination = run('__printed');
    assert.equal(printedVaccination.title, 'Vaccination');
    for (const text of ['Test Patient', 'Child vaccines', 'BCG', 'Given', 'Lot A', 'Nurse Lee']) assert.ok(printedVaccination.html.includes(text), 'vaccination printout missing ' + text);
    run('printDoc=__nativePrintDoc');
    await run(`api('DELETE','records/${vaccination.id}')`);
    await run('loadRecs()');
    ok('vaccination printer icon prints the patient and dose details');

    // vital signs
    run('vsForm()'); ctx.__f = { __m: { v_t: '38.1', v_hr: '90', date: '2026-10-14T09:00' } }; await run('__save(__f)'); assert.equal(run('recs.filter(r=>r.kind=="vitals").length'), 2); ok('vital signs added');

    // investigation request service picker
    await run(`openPatient(${baby.id})`);
    run("D.sv.push({id:991,name:'Investigation Test',price:12500},{id:992,name:'Other Service',price:20000});ptab='investigation'");
    html = run('recPanel()');
    for (const must of ['Request service', 'id="investigation-service-search"', 'data-investigation-service="991"', 'Investigation Test', 'KHR 12,500', 'data-a="investigation-request"']) assert.ok(html.includes(must), 'investigation service picker missing ' + must);
    const investigationSearchHandler = listeners.input.find((fn) => fn.toString().includes('investigation-service-search'));
    const investigationSelectionHandler = listeners.change.find((fn) => fn.toString().includes('investigationService'));
    assert.ok(investigationSearchHandler && investigationSelectionHandler, 'investigation search and selection handlers should be registered');
    investigationSearchHandler({ target: { id: 'investigation-service-search', value: 'other' } });
    assert.ok(els['#investigation-service-list'].innerHTML.includes('Other Service') && !els['#investigation-service-list'].innerHTML.includes('Investigation Test'), 'service search should filter the service cards');
    investigationSearchHandler({ target: { id: 'investigation-service-search', value: '' } });
    investigationSelectionHandler({ target: { dataset: { investigationService: '991' }, checked: true, closest: () => ({ classList: { toggle() {} } }) } });
    assert.ok(run("investigationSelection.has('991')"), 'checking a service should add it to the selection');
    await run('requestInvestigationServices()');
    let investigation = run(`recs.find(r=>r.patient_id==${baby.id}&&r.kind=='investigation')`);
    assert.ok(investigation, ctx.__toast || 'investigation request was not saved');
    assert.deepEqual(JSON.parse(investigation.data).items.map((item) => item.name), ['Investigation Test']);
    assert.ok(run('recPanel()').includes('Requested services') && run('recPanel()').includes('Investigation Test'));
    await run(`changeInvestigationQuantity(${investigation.id},0,1)`);
    assert.equal(run(`patientDue(${baby.id})`), 25000);
    assert.equal(run(`JSON.parse(recs.find(r=>r.id==${investigation.id}).data).items[0].quantity`), 2);
    await run(`changeInvestigationQuantity(${investigation.id},0,-1)`);
    assert.equal(run(`patientDue(${baby.id})`), 12500);
    assert.ok(run('billPanel()').includes('data-a="svcplus:') && run('billPanel()').includes('data-a="svcminus:'));
    await run(`changeInvestigationQuantity(${investigation.id},0,-1)`);
    assert.equal(run(`patientDue(${baby.id})`), 0, 'decrementing service quantity to zero should remove the service charge');
    run("D.sv.push({id:991,name:'Investigation Test',price:12500})");
    run("investigationSelection.add('991')");
    await run('requestInvestigationServices()');
    investigation = run(`recs.find(r=>r.patient_id==${baby.id}&&r.kind=='investigation')`);
    assert.equal(run(`billTotals(recs).ch`), 12500); assert.equal(run(`patientDue(${baby.id})`), 12500);
    assert.equal(run(`billingOutstandingItems([{kind:'investigation',data:JSON.stringify({items:[{name:'Echo',price:12500}]})},{kind:'payment',data:JSON.stringify({amount:5000})}])[0].price`), 7500);
    run("ptab='billing'"); html = run('recPanel()');
    for (const must of ['Service Charges', 'Investigation Test', 'Total Unpaid Amount', 'KHR 12,500', 'Paid History']) assert.ok(html.includes(must), 'billing history missing investigation charge or screenshot layout: ' + must);
    await run(`pAct('payall')`);
    await run('__save({__m:{"discount":"0","discount_currency":"KHR","received":"12500","method":"Cash","payment_date":"2026-10-14","receiver_name":"Clinic User"}})');
    assert.equal(run(`patientDue(${baby.id})`), 0);
    html = run('billPanel()');
    assert.ok(html.includes('class="bill-payment-table"') && html.includes('<th>Date</th>') && html.includes('<th>Method</th>') && html.includes('<td>1</td>') && html.includes('Total Paid') && html.includes('KHR 12,500'));
    assert.equal(run(`paidHistoryTable([{id:1,date:'2026-10-14',data:JSON.stringify({amount:12500})},{id:2,date:'2026-10-15',data:JSON.stringify({amount:2500})}],[]).total`), 15000, 'Paid History overall total should include each receipt amount');
    assert.ok(run(`paidHistoryTable([{id:1,data:JSON.stringify({amount:12500})},{id:2,data:JSON.stringify({amount:2500})}],[]).html`).includes('KHR 15,000'), 'Paid History table footer should show the sum of all receipts');
    assert.ok(html.includes('data-a="paidview"') && html.includes('aria-label="Switch to cards view"'), 'Paid History should offer a view toggle icon');
    ctx.__paidPanel = { innerHTML: '' };
    run('pAct("paidview","","",{closest:()=>__paidPanel})');
    assert.equal(run('paidHistoryView'), 'cards'); assert.ok(ctx.__paidPanel.innerHTML.includes('class="bill-payment-cards"') && ctx.__paidPanel.innerHTML.includes('PAY-'), 'view toggle should show receipt cards');
    run('pAct("paidview","","",{closest:()=>__paidPanel})');
    assert.equal(run('paidHistoryView'), 'table'); assert.ok(ctx.__paidPanel.innerHTML.includes('class="bill-payment-table-wrap"'), 'view toggle should switch back to the receipt table');
    delete ctx.__paidPanel;
    ok('investigation services appear as unpaid billing line items and update the patient balance');
    await run(`openPatient(${p.id})`);

    // treatment follow-up interface
    run('openForm=__nativeOpenForm'); await run(`treatmentFollowup(${p.id})`);
    html = els['#mf'].innerHTML;
    for (const must of ['Treatment Follow-up', 'Date / Vital Signs', 'Diagnosis / Evolution', 'Treatment / Notes', 'View History', 'Add New Treatment Row', 'Print All Records', 'Save Record']) assert.ok(html.includes(must), 'treatment follow-up interface missing ' + must);
    els['#mf'].elements = {
      'tf-date-0': { value: '2026-10-14T09:30' },
      'tf-vitals-0': { value: 'BP: 120/80\\nTemp: 37.2 °C' },
      'tf-diagnosis-0': { value: 'Follow-up, improving' },
      'tf-notes-0': { value: 'Continue treatment' }
    };
    els['#mf'].__m = { 'tf-date-0': '2026-10-14T09:30', 'tf-vitals-0': 'BP: 120/80\\nTemp: 37.2 °C', 'tf-diagnosis-0': 'Follow-up, improving', 'tf-notes-0': 'Continue treatment' };
    await run(`$('#mf').onsubmit({preventDefault(){}})`);
    const tf = run(`recs.find(r=>r.patient_id==${p.id}&&r.kind=='treatment')`);
    assert.ok(tf, ctx.__toast || 'treatment follow-up record was not saved'); assert.equal(tf.notes, 'Continue treatment'); assert.equal(JSON.parse(tf.data).diagnosis, 'Follow-up, improving');
    assert.equal(JSON.parse(tf.data).vitals, 'BP: 120/80\\nTemp: 37.2 °C'); ok('treatment follow-up saves vitals, diagnosis and treatment notes');
    run("D.sv.push({id:993,name:'Operation Service',price:0});ptab='operation';genForm()");
    let operationHtml = els['#mf'].innerHTML;
    for (const must of ['New Operation Request Form', 'Requested by *', 'Requested date *', 'Service *', 'Operation date *', 'List Participants', 'Add physician', 'Form Type', 'Surgical Procedure', 'Patient Profile/Condition', 'Pre-OP Diagnosis', 'Procedure/Indication', 'Post-OP Diagnosis', 'Anesthesia Type', 'Anesthesia Desc', 'Description of Procedure', 'Preoperative Medications', 'Preparation of the Patient', 'Position of the Patient', 'Incision Site', 'Technique / Procedure', 'Assessment before Closure', 'Instruments &amp; Sponges Count', 'Materials Input', 'Closure Description', 'Estimation blood loss', 'Blood Transfusion', 'Further Investigation', 'Complications prediction', 'Post-OP Plan']) assert.ok(operationHtml.includes(must), 'operation request form missing ' + must);
    assert.ok(run(`operationParticipantRow(${doctor.id})`).includes('Dr. Follow-up'), 'operation participants should select existing physicians');
    let addedParticipant = '';
    run("$('#operation-participants')");
    els['#operation-participants'].insertAdjacentHTML = (position, markup) => { addedParticipant = markup; };
    run("pAct('opaddphysician')");
    assert.ok(addedParticipant.includes('name="participants"'), 'Add physician should create a participant selector');
    ctx.__removedParticipant = false;
    run("pAct('opremovephysician',null,null,{closest:()=>({remove:()=>{__removedParticipant=true}})})");
    const removedParticipant = run('__removedParticipant');
    assert.ok(removedParticipant, 'participant rows should be removable');
    els['#mf'].__m = {
      requested_by: 'Dr. Follow-up', requested_date: '2026-10-22T09:30', service_id: '993', operation_date: '2026-10-23T10:00',
      participants: [String(doctor.id)], form_type: 'English', patient_profile_condition: 'Stable patient', pre_op_diagnosis: 'Appendicitis',
      procedure_indication: 'Abdominal pain', post_op_diagnosis: 'Appendectomy completed', anesthesia_types: ['General', 'Spinal'],
      anesthesia_description: 'General anesthesia', preoperative_medications: 'Antibiotic prophylaxis', preparation_of_patient: 'NPO',
      position_of_patient: 'Supine', incision_site: 'Right lower quadrant', description: 'Laparoscopic appendectomy',
      assessment_before_closure: 'Hemostasis achieved', instruments_sponges_count: 'Correct', materials_input: 'Sutures',
      closure_description: 'Closed in layers', estimation_blood_loss: '50 mL', blood_transfusion: 'Not required',
      further_investigation: 'Histopathology', complications_prediction: 'None', post_op_plan: 'Monitor recovery'
    };
    await run(`$('#mf').onsubmit({preventDefault(){}})`);
    const operation = run(`recs.find(r=>r.patient_id==${p.id}&&r.kind=='operation')`);
    assert.ok(operation, ctx.__toast || 'operation record was not saved');
    const operationData = JSON.parse(operation.data);
    assert.equal(operation.title, 'Operation Service'); assert.equal(operation.date, '2026-10-23T10:00');
    assert.deepEqual(operationData.anesthesia_types, ['General', 'Spinal']); assert.deepEqual(operationData.participants, [String(doctor.id)]);
    assert.equal(operationData.description, 'Laparoscopic appendectomy'); assert.equal(operationData.post_op_plan, 'Monitor recovery');
    run(`genForm(recs.find(r=>r.id==${operation.id}))`);
    assert.ok(els['#mf'].innerHTML.includes('Edit Operation Request Form') && els['#mf'].innerHTML.includes('Laparoscopic appendectomy'), 'editing an operation should prefill saved details');
    ok('operation request form follows the requested sections and saves editable operation details');
    run('openForm=function(t,b,s,o){__body=b;__save=s;__opts=o}');

    const newPatientModules = [
      ['allergy', { allergen: 'Penicillin', reaction: 'Rash', severity: 'Severe', status: 'Active', date: '2026-10-14', notes: 'Avoid penicillin' }, 'Penicillin'],
      ['referral', { referred_to: 'City Hospital', specialty: 'Cardiology', reason: 'Assessment', status: 'Pending', date: '2026-10-14', notes: 'Routine referral' }, 'City Hospital'],
      ['diagnosis_history', { diagnosis: 'Asthma', code: 'J45', status: 'Chronic', date: '2026-10-14', notes: 'Reviewed' }, 'Asthma'],
      ['laborder', { test: 'CBC', priority: 'Urgent', status: 'Requested', result: '', date: '2026-10-14', notes: 'Fasting' }, 'CBC'],
      ['imagingorder', { modality: 'X-Ray', body_part: 'Chest', priority: 'Routine', status: 'Scheduled', indication: 'Cough', date: '2026-10-14', notes: '' }, 'Chest']
    ];
    run('openForm=__nativeOpenForm');
    for (const [kind, values, expected] of newPatientModules) {
      run(`ptab='${kind}';genForm()`);
      assert.ok(els['#mf'].innerHTML.includes('Add '), `${kind} should open an add form`);
      els['#mf'].__m = values;
      await run(`$('#mf').onsubmit({preventDefault(){}})`);
      const saved = run(`recs.find(r=>r.patient_id==${p.id}&&r.kind=='${kind}')`);
      assert.ok(saved, ctx.__toast || `${kind} record was not saved`);
      assert.ok(run('recPanel()').includes(expected), `${kind} details should render in its patient section`);
    }
    run("ptab='vaccination';genForm()");
    const vaccinationHtml = els['#mf'].innerHTML;
    for (const must of ['vaccination-form', 'Vaccine category', 'Vaccine group', 'Vaccine name', 'Dose date', 'Given', 'Administered by', 'vax_name_5']) assert.ok(vaccinationHtml.includes(must), 'vaccination form missing ' + must);
    assert.equal((vaccinationHtml.match(/class="vax-dose-index"/g) || []).length, 6, 'vaccination form should show six dose rows');
    els['#mf'].__m = {
      category: 'child',
      vaccine_group: 'Childhood series',
      vax_name_0: 'BCG',
      vax_date_0: '2026-10-21',
      vax_given_0: '1',
      vax_note_0: 'Lot BCG-19',
      notes: 'Routine immunization',
      date: '2026-10-21',
      administered_by: 'Nurse Dara'
    };
    await run(`$('#mf').onsubmit({preventDefault(){}})`);
    let vaccineRecord = run(`recs.find(r=>r.patient_id==${p.id}&&r.kind=='vaccination')`);
    assert.ok(vaccineRecord, ctx.__toast || 'vaccination record should be saved');
    let vaccineData = JSON.parse(vaccineRecord.data);
    assert.equal(vaccineData.vaccine_group, 'Childhood series'); assert.equal(vaccineData.doses[0].vaccine, 'BCG'); assert.equal(vaccineData.doses[0].given, true); assert.equal(vaccineData.administered_by, 'Nurse Dara');
    assert.ok(run('recPanel()').includes('BCG') && run('recPanel()').includes('Nurse Dara'), 'vaccination doses should render in the patient record');
    run(`genForm(recs.find(r=>r.id==${vaccineRecord.id}))`);
    assert.ok(els['#mf'].innerHTML.includes('value="Childhood series"') && /name="vax_given_0"[^>]*checked/.test(els['#mf'].innerHTML), 'editing vaccination should restore saved details');
    ok('allergy, vaccination, referral, diagnosis history, lab and imaging orders save and display records');
    run('openForm=function(t,b,s,o){__body=b;__save=s;__opts=o}');

    // medical record: form, collect, save, print
    run('ptab="medical"; mrForm()'); for (const must of ['1. Vital signs', '6. Past medical history', 'BCG/HepB', 'TT5', '7.4 Respiratory system', 'Thorax asymmetric', '8. Probable diagnosis', 'Salt restriction', 'Monitoring', 'data-a="mtadd"']) assert.ok(ctx.__body.includes(must), 'medical form missing ' + must);
    assert.ok(ctx.__opts.extra.includes('Print')); ctx.__f = { __m: { date: '2026-10-14T09:10', mr_bp: '120/80', mr_cc: 'Cough 3 days', mr_dx: 'Bronchitis', mrc_vacc: ['BCG/HepB', 'Measles+JE'], mr_eyes_l: 'normal', mon_vs: '1', mon_vs_h: '4', mt_d: ['10/14', ''], mt_e: ['better', ''], mt_t: ['Amoxicillin', ''] } };
    ctx.__mr = run('mrCollect(__f)'); assert.deepEqual(ctx.__mr.vacc, ['BCG/HepB', 'Measles+JE']); assert.equal(ctx.__mr.mt.length, 1); assert.equal(ctx.__mr.mon_vs, 1);
    await run('__save(__f)'); const mr = run('recs.find(r=>r.kind=="medical")'); assert.equal(JSON.parse(mr.data).dx, 'Bronchitis'); ok('medical record collected and saved');
    const printed = run(`mrPrintHtml(JSON.parse(recs.find(r=>r.kind=="medical").data))`); assert.ok(printed.includes('Bronchitis') && printed.includes('Cough 3 days') && printed.includes('Measles+JE') && printed.includes('Vital signs every 4 h') && printed.includes('Amoxicillin')); ok('medical record printout contains the entered data');
    ctx.__mr2 = run(`(function(){mrForm(recs.find(r=>r.kind=="medical"));return __body})()`); assert.ok(ctx.__mr2.includes('value="Bronchitis"') || ctx.__mr2.includes('>Bronchitis<')); assert.ok(/value="BCG\/HepB"\s+checked/.test(ctx.__mr2)); ok('editing a medical record pre-fills it');

    // BEU record with colour
    run('ptab="beu"; genForm()'); assert.ok(ctx.__body.includes('Label colour') && ctx.__body.includes('type="radio"') && ctx.__body.includes('id="pf_image"')); ctx.__f = { __m: { title: 'Before treatment', date: '2026-10-14', notes: 'wound', color: '#ef4444', image: '' } }; await run('__save(__f)');
    html = run('recPanel()'); assert.ok(html.includes('Before treatment') && html.includes('border-left:6px solid #ef4444')); ok('BEU record saved with colour label');
    run('ptab="consultation"; genForm()'); assert.ok(!ctx.__body.includes('Label colour')); ok('other tabs use the plain notes form');

    // appointments calendar
    const apptDate = run('ymd(new Date())');
    await run(`api('POST','appointments',{name:'Test Patient',svc:'Echo',date:'${apptDate}',time:'09:30',doc:'Dr. A',st:'Waiting'})`); await run('load()');
    run('rt="ap"; cal.list=false'); html = run('R.ap()'); assert.ok(html.includes('class="cal"') && html.includes('09:30 Test Patient') && html.includes('data-a="calmode:week"') && html.includes('List view')); ok('calendar month view shows the appointment with its time');
    run('cal.mode="week"'); assert.ok(run('R.ap()').includes('class="cal wk"')); run('cal.mode="day"; cal.d=new Date()'); assert.ok(run('R.ap()').includes('Test Patient')); ok('week and day views work');
    const y0 = run('cal.d.getMonth()'); run('cal.mode="month"; pAct("calnext")'); assert.notEqual(run('cal.d.getMonth()'), y0); ok('next/previous navigation moves the calendar');
    run('cal.list=true'); assert.ok(run('R.ap()').includes('Calendar view') && run('R.ap()').includes('Test Patient')); ok('list view toggle works');

    run("modal('Add appointment',P.ap.f,{st:'Waiting',date:'2026-10-20',time:''},()=>{})"); const mh = els['#mf'].innerHTML;
    assert.ok(mh.includes('type="date"') && mh.includes('type="time"') && mh.includes('<select class="in" name="st">') && mh.includes('<option value="Cancelled"') && /name="name"[^>]*required/.test(mh) && !/name="phone"[^>]*required/.test(mh)); ok('appointment form has date, time and status pickers; only the name is required');

    // ---- Medical Record toolbar: HT Controls, History, MRD ----
    run('ptab="medical"'); html = run('recPanel()'); for (const must of ['data-a="htc"', 'data-a="mhist"', 'data-a="mrd"', 'data-a="radd"']) assert.ok(html.includes(must), 'medical toolbar missing ' + must); ok('Medical Record tab has gear, History, MRD and Add buttons');
    run('openForm=function(t,b,s,o){__body=b;__save=s;__opts=o;__title=t}'); run('htControls()');
    for (const l of ['Vital Signs', 'Illness History', 'Past Medical History', 'Clinical Examination', 'Other Systems', 'Diet & Monitor', 'Monitor Table', 'Additional Sections']) assert.ok(ctx.__body.includes(l), 'HT Controls missing ' + l); assert.equal(ctx.__title, 'HT Controls'); ok('HT Controls lists the eight hideable sections');
    ctx.__f = { __m: { ht: ['ce', 'mt'] } }; await run('__save(__f)'); run('mrForm()'); assert.ok(!ctx.__body.includes('7. Clinical examination') && !ctx.__body.includes('Monitoring') && ctx.__body.includes('6. Past medical history') && ctx.__body.includes('8. Probable diagnosis')); ok('hidden sections disappear from the Medical Record form');
    const hid = run(`mrCollect({__m:{mr_cc:'new cc'}}, {r_ins:'kept value', head:'kept head', mt:[['a','b','c']]})`); assert.equal(hid.r_ins, 'kept value'); assert.equal(hid.head, 'kept head'); assert.equal(hid.mt.length, 1); assert.equal(hid.cc, 'new cc'); ok('data in hidden sections is kept when saving');
    const hiddenPrint = run('mrPrintHtml({head:"HEADTEXT",cc:"CCTEXT",r_ins:"INSPECTION"})');
    for (const section of ['1. Vital signs', '2. Chief complaint', '3. History of present illness', '4. Review of systems', '5. Current medication', '6. Past medical history', '6.1 Personal history', '6.2 Family history', '7. Clinical examination', '7.1 General appearance', '7.2 Head, eyes, ears, nose, throat and neck', '7.3 Lymphadenopathy', '7.4 Respiratory system', '7.5 Cardiovascular system', '7.6 Abdomen', '7.7 Genito-urinary', '7.8 Extremities', '7.9 Musculoskeletal', '7.10 Other systems', '8. Probable diagnosis', '9. Differential diagnosis', '10. Investigation', '11. Initial treatment']) assert.ok(hiddenPrint.includes(section), 'medical printout missing section ' + section);
    assert.ok(hiddenPrint.includes('HEADTEXT') && hiddenPrint.includes('CCTEXT') && hiddenPrint.includes('INSPECTION') && hiddenPrint.includes('Blood pressure (BP)') && hiddenPrint.includes('Evolution of patient'), 'printout should include hidden data, entered values, and blank field labels'); ok('Medical Record printout always includes all 11 sections, sub-sections, and blank fields');
    run('htControls()'); ctx.__f = { __m: { ht: [] } }; await run('__save(__f)'); assert.ok(run('(mrForm(),__body)').includes('7. Clinical examination')); ok('un-hiding restores the sections');
    run('mrHistory()'); assert.equal(ctx.__title, 'History'); assert.ok(ctx.__body.includes('Bronchitis')); ok('History button lists the patient’s medical records');
    run('mrdList()'); assert.ok(ctx.__body.includes('No records yet') && ctx.__body.includes('data-a="mrdnew"')); run('mrdForm()'); for (const l of ['Patient name', 'Sex', 'Age', 'Diagnosis', 'Request', 'Result']) assert.ok(ctx.__body.includes(l)); assert.ok(ctx.__body.includes('Test Patient'));
    ctx.__f = { __m: { date: '2026-10-14', dx: 'Acne', req: 'Peel', res: 'Improved' } }; await run('__save(__f)'); assert.equal(JSON.parse(run('recs.find(r=>r.kind=="mrd")').data).res, 'Improved'); run('mrdList()'); assert.ok(ctx.__body.includes('Acne')); ok('MRD record can be created and then listed');

    // ---- Treatment Schedule ----
    run('printDoc=function(t,h){__pd=[t,h]}'); run('ptab="schedule"; sch="Standard"'); html = run('recPanel()');
    for (const must of ['Treatment Schedule', 'Total:', 'data-a="schinv"', 'data-a="cnf"', 'data-a="schprint"', 'Add Schedule', 'Standard', 'data-a="schaddtab"', 'id="schnote"', 'Diagnosis / type', 'Treatment / notes', 'No schedules found']) assert.ok(html.includes(must), 'schedule panel missing ' + must);
    ok('Treatment Schedule panel has tabs, total, Invoice, Add Schedule, CNF, Print and note box');
    run("D.sv.push({id:77,name:'Peel service',price:50000})"); run('schForm()');
    assert.equal(ctx.__title, 'Add New Schedule');
    for (const must of ['name="date"', 'Select Medicine &amp; Services', 'Peel service', 'Treatment Type', 'e.g. Consultation, Laser...', 'name="diagnosis"', 'Diagnosis details...', 'Treatment / Notes', 'Treatment details or notes...', 'name="schedule_type"', 'Treatment2', 'name="amount"', 'USD', 'Add to Unpaid Billing', 'Mark as Done']) assert.ok(ctx.__body.includes(must), 'schedule form missing ' + must);
    assert.equal(ctx.__opts.cls, 'schedule-form');
    assert.match(ctx.__body, /name="schedule_type" value="Standard" checked/);
    assert.match(ctx.__body, /name="billable" value="1" checked/);
    const schControls = { treatment_type: { value: '' }, amount: { value: '' } };
    els['#mf'].elements = { namedItem: (name) => schControls[name] };
    run("schItemChanged('service:77')");
    assert.equal(schControls.treatment_type.value, 'Peel service'); assert.equal(schControls.amount.value, '12.50');
    ctx.__f = { __m: { date: '2026-10-14', selection_ref: 'service:77', amount: '12.50', treatment_type: 'Peel', diagnosis: 'Acne', notes: 'Peel session 1', schedule_type: 'Standard', billable: '1', done: null } }; await run('__save(__f)');
    let savedSchedule = run('schRows()[0]'); let savedScheduleData = JSON.parse(savedSchedule.data);
    assert.equal(savedScheduleData.amount, 50000); assert.equal(savedScheduleData.selection, 'Peel service'); assert.equal(savedScheduleData.treatment_type, 'Peel'); assert.equal(savedScheduleData.diagnosis, 'Acne'); assert.equal(savedScheduleData.billable, 1);
    ctx.__f = { __m: { date: '2026-10-21', amount: '7.50', treatment_type: 'Peel', diagnosis: 'Acne', notes: 'Peel session 2', schedule_type: 'Standard', billable: '1', done: '1' } }; run('schForm()'); await run('__save(__f)');
    assert.equal(run('schRows().length'), 2); assert.equal(run('schTotal()'), 80000); assert.equal(run(`patientDue(${p.id})`), 80000);
    assert.equal(run("billTotals([{kind:'schedule',data:JSON.stringify({amount:4000,billable:0})}]).ch"), 0);
    assert.ok(run(`ipdRow({code:'${p.id}',name:'Test Patient',adm:'2026-10-14'})`).includes(`data-a="ptpay:${p.id}"`));
    html = run('recPanel()'); assert.ok(html.includes('Peel session 1') && html.includes('80,000')); ok('schedule charges calculate the patient balance used by IPD billing status');
    const rid = run('schRows()[0].id'); run(`pAct('schdone','${rid}')`); await new Promise((r) => setTimeout(r, 300)); assert.equal(JSON.parse(run('schRows()[0]').data).done, 1); ok('Done tick can be toggled');
    await run(`api('POST','records',{patient_id:pdId,kind:'schedulenote',title:'Treatment2'})`); await run('loadRecs()'); assert.ok(run('schNames()').includes('Treatment2')); run('sch="Treatment2"'); assert.equal(run('schRows().length'), 0); assert.ok(run('recPanel()').includes('Treatment2')); ok('a second schedule (Treatment2) is a separate tab with its own rows');
    run('schForm()'); ctx.__f = { __m: { date: '2026-10-22', amount: '10', treatment_type: 'Free follow-up', diagnosis: 'Acne', notes: 'Not billed', schedule_type: 'Treatment2', billable: null, done: null } }; await run('__save(__f)');
    assert.equal(run('schRows().length'), 1); assert.equal(run('schTotal()'), 40000); assert.equal(run(`patientDue(${p.id})`), 80000); assert.equal(run('billTotals(recs).ch'), 80000);
    run('sch="Standard"'); assert.ok(!run('billPanel()').includes('Not billed')); ok('Add to Unpaid Billing excludes unchecked schedule items from billing');
    ctx.__x = null; run('document.querySelector("#schnote").value="Header for print"'); await run(`(async()=>{pAct('schnotesave');await new Promise(r=>setTimeout(r,300))})()`); assert.equal(run('schNote().notes'), 'Header for print'); ok('schedule header note saved');
    run('schPrint(false)'); assert.ok(ctx.__pd[1].includes('Header for print') && ctx.__pd[1].includes('Peel session 2') && ctx.__pd[1].includes('80,000')); run('schPrint(true)'); assert.equal(ctx.__pd[0], 'Invoice'); assert.ok(ctx.__pd[1].includes('Acne – Peel session 1') && ctx.__pd[1].includes('Total')); ok('Print Schedule and Invoice produce documents');

    // ---- Pay All ----
    await run(`openPatient(${p.id})`); run('ptab="billing"'); html = run('recPanel()'); assert.ok(html.includes('data-a="payall"') && html.includes('Pay All') && html.includes('KHR 80,000'));
    run('openForm=__nativeOpenForm'); await run('pAct("payall")');
    for (const control of ['payall-items', 'name="all_discount"', 'name="all_discount_currency"', 'name="method"', 'name="payment_date"', 'name="received"', 'name="receiver_name"', 'payall-discount-open', 'payall-qr', 'payall-print:compact', 'payall-shortcut:100000', 'Confirm payment', 'បញ្ចុះតម្លៃគ្រប់សេវា / Discount all services', 'បញ្ចុះតម្លៃតាមសេវាដែលបានជ្រើសរើស / Discount selected services', 'តម្លៃសរុប / Total price', 'តម្លៃត្រូវបង់ / Final total', 'វិធីទូទាត់ / Payment method', 'សាច់ប្រាក់ / Cash', 'ធនាគារ / Bank', 'ឈ្មោះអ្នកទទួលប្រាក់ / Received by', 'បញ្ជាក់ការទូទាត់ / Confirm payment']) assert.ok(els['#mf'].innerHTML.includes(control), 'Pay All dialog missing bilingual discount/payment content: ' + control);
    assert.ok(!els['#mf'].innerHTML.includes('ប្រាក់អាប់') && !els['#mf'].innerHTML.includes('name="change"'), 'Pay All form should not show a Change field');
    run('payAllContext.draftSelectedIndexes=[];payAllContext.draftDiscountInput=0;payAllContext.draftDiscountCurrency="KHR"');
    const discountModal = run('payAllDiscountModalHtml()');
    assert.ok(discountModal.includes('data-payall-discount-item="0"') && discountModal.includes('សេវាសម្រាប់បញ្ចុះតម្លៃ / Select services for discount') && discountModal.includes('name="payall_discount_input"'));
    const paymentStyles = fs.readFileSync(path.join(frontendDir, 'styles.css'), 'utf8');
    assert.match(paymentStyles, /\.payall-discount-dialog\s*\{[^}]*width:\s*min\(565px,\s*calc\(100vw - 32px\)\)/s, 'discount dialog should fit within the viewport');
    assert.match(paymentStyles, /#md \.payall-discount-entry \.in\s*\{[^}]*min-width:\s*0;/s, 'discount inputs should not overflow the dialog grid');
    assert.match(paymentStyles, /\.payall-items th\s*\{[^}]*color:\s*#2563eb;/s, 'Pay All table headers should use blue text');
    assert.equal(run('payAllCalculation(80000,5,"USD").discount'), 20000);
    assert.equal(run('payAllCalculation(80000,5,"USD").finalTotal'), 60000);
    assert.equal(run('payAllDiscountCalculation([{price:100},{price:200}],[1],30,"KHR").finalTotal'), 270);
    assert.equal(run('payAllDiscountCalculation([{price:100},{price:200}],[1],30,"KHR",10,"KHR").finalTotal'), 260);
    assert.equal(run('payAllDiscountAllocation([{price:100},{price:200}],[1],30)[1]'), 30);
    run('payAllContext.selectedIndexes=[0];payAllContext.discountInput=10000;payAllContext.discountCurrency="KHR"');
    els['#mf'].__m = { all_discount: '5000', all_discount_currency: 'KHR', received: '65000', method: 'Bank', payment_date: '2026-10-05', receiver_name: 'Cashier One' }; await run('$("#mf").onsubmit({preventDefault(){}})');
    assert.equal(run('billTotals(recs).bal'), 0); assert.equal(run('jd(recs.find(r=>r.kind=="payment")).method'), 'Bank');
    assert.equal(run('jd(recs.find(r=>r.kind=="payment")).amount'), 65000);
    assert.equal(run('jd(recs.find(r=>r.kind=="payment")).applied_amount'), 80000);
    assert.equal(run('jd(recs.find(r=>r.kind=="payment")).discount'), 15000);
    assert.equal(run('jd(recs.find(r=>r.kind=="payment")).discount_item'), 10000);
    assert.equal(run('jd(recs.find(r=>r.kind=="payment")).discount_all'), 5000);
    assert.match(run('jd(recs.find(r=>r.kind=="payment")).paid_at'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    assert.equal(run('jd(recs.find(r=>r.kind=="payment")).discount_items[0].name'), run('payAllContext.items[0].name'));
    assert.equal(run('jd(recs.find(r=>r.kind=="payment")).items.reduce((sum,item)=>sum+item.discount_item,0)'), 10000);
    assert.equal(run('jd(recs.find(r=>r.kind=="payment")).items.reduce((sum,item)=>sum+item.discount_all,0)'), 5000);
    assert.equal(run('jd(recs.find(r=>r.kind=="payment")).receiver_name'), 'Cashier One');
    html = run('billPanel()'); const paidId = run('recs.find(r=>r.kind=="payment").id');
    assert.ok(html.includes('KHR 65,000') && /data-a="payall" disabled/.test(html) && /data-a="recpay" disabled/.test(html));
    assert.ok(html.includes(`data-a="payreceipt:${paidId}"`) && html.includes('bill-payment-date') && html.includes(run('jd(recs.find(r=>r.kind=="payment")).paid_at.slice(11,16)'))); run(`D.clinic.banner='clinic-banner.jpg';pAct('payreceipt','${paidId}')`);
    assert.equal(ctx.__pd[0], ''); assert.ok(ctx.__pd[1].includes('payment-receipt') && ctx.__pd[1].includes('DETAILED INVOICE') && ctx.__pd[1].includes('Test Patient') && ctx.__pd[1].includes('PAY-' + paidId) && ctx.__pd[1].includes('Bank') && ctx.__pd[1].includes('KHR 80,000') && ctx.__pd[1].includes('KHR 65,000') && ctx.__pd[1].includes('Discount') && ctx.__pd[1].includes('Grand Total') && ctx.__pd[1].includes('Cashier One') && ctx.__pd[1].includes('អ្នកទទួលប្រាក់ / Received by') && ctx.__pd[1].includes(`${run('API_BASE')}/uploads/clinic-banner.jpg`) && ctx.__pd[1].includes('payment-receipt-signatures'));
    run("D.clinic.banner=''");
    assert.match(fs.readFileSync(path.join(frontendDir, 'styles.css'), 'utf8'), /\.payment-receipt-table th,\s*\.payment-receipt-table td\s*\{[^}]*font-size:\s*9pt;/s, 'payment receipt should use the compact invoice table styling');
    ok('paid billing history can print payment receipts; payment actions are disabled when no balance remains');
    run('openForm=function(t,b,s,o){__body=b;__save=s;__opts=o;__title=t}');

    // ---- Partial Pay All and follow-up payment ----
    ctx.__partialPatient = await run(`api('POST','patients',{name:'Partial Payment Test',type:'OPD'})`);
    await run(`api('POST','records',{patient_id:__partialPatient.id,kind:'investigation',data:{items:[{name:'Service One',price:120000,quantity:1},{name:'Service Two',price:80000,quantity:1}]}})`);
    run('openForm=__nativeOpenForm'); await run('load()'); await run('openPatient(__partialPatient.id)'); await run('pAct("payall")');
    assert.ok(els['#mf'].innerHTML.includes('Remaining balance in Unpaid') && els['#mf'].innerHTML.includes('Discounts apply only when the full final total is paid.'));
    const payAllControls = { '[name="all_discount"]': { value: '0' }, '[name="all_discount_currency"]': { value: 'KHR' }, '[name="received"]': { value: '150000' } };
    els['#mf'].querySelector = selector => payAllControls[selector] || el();
    run('payAllRefresh()');
    assert.equal(els['#payall-remaining-balance'].textContent, 'KHR 50,000', 'Pay All should preview the remaining unpaid balance');
    els['#mf'].__m = { all_discount: '0', all_discount_currency: 'KHR', received: '150000', method: 'Cash', payment_date: '2026-10-23', receiver_name: 'Clinic User' };
    await run('$("#mf").onsubmit({preventDefault(){}})');
    assert.equal(run('billTotals(recs).bal'), 50000, 'a partial Pay All payment should leave its remainder unpaid');
    assert.equal(run('jd(recs.find(r=>r.kind=="payment")).applied_amount'), 150000);
    assert.equal(run('jd(recs.find(r=>r.kind=="payment")).remaining_balance'), 50000);
    assert.equal(run('jd(recs.find(r=>r.kind=="payment")).discount'), 0);
    assert.ok(run('billPanel()').includes('KHR 50,000'), 'remaining amount should be shown in Unpaid after partial payment');
    const partialPaymentId = run('recs.find(r=>r.kind=="payment").id');
    run(`pAct('payreceipt','${partialPaymentId}')`);
    assert.ok(ctx.__pd[1].includes('Remaining Balance') && ctx.__pd[1].includes('KHR 50,000'), 'partial payment receipt should show the remaining amount');
    assert.match(fs.readFileSync(path.join(frontendDir, 'styles.css'), 'utf8'), /\.payall-balance\s*\{[^}]*background:\s*#f0fdf4;/s, 'remaining balance should be visually distinct in Pay All');
    await run('pAct("payall")');
    els['#mf'].__m = { all_discount: '0', all_discount_currency: 'KHR', received: '50000', method: 'Cash', payment_date: '2026-10-24', receiver_name: 'Clinic User' };
    await run('$("#mf").onsubmit({preventDefault(){}})');
    assert.equal(run('billTotals(recs).bal'), 0, 'the patient should be able to pay the remaining balance on a later visit');
    ok('Pay All accepts partial payments, displays the Unpaid remainder, and accepts a later payment');
    await run(`openPatient(${p.id})`); run('openForm=function(t,b,s,o){__body=b;__save=s;__opts=o;__title=t}');

    // ---- Medicines list and Add Medicine form ----
    run('rt="pos";medicineFormOpen=false;medicineFormReturnPage=null');
    listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'add:med' } }) }, preventDefault() {} });
    assert.equal(run('rt'), 'med');
    let posAddMedicineHtml = run('R.med()');
    for (const must of ['Add New Medicine', 'Medicine Image', 'Drug name', 'Composition', 'In Stock', 'Sales unit', 'Expiration date', 'Notification date', 'Cancel', '＋ Add sales unit']) assert.ok(posAddMedicineHtml.includes(must), 'POS Add item should open the screenshot medicine form with ' + must);
    assert.ok(!posAddMedicineHtml.includes('medicine-table-wrap') && !posAddMedicineHtml.includes('Import Excel'), 'POS Add item should show the form by itself');
    const medicineCss = fs.readFileSync(path.join(frontendDir, 'styles.css'), 'utf8');
    assert.match(medicineCss, /\.medicine-unit-add\s*\{[^}]*width:\s*100%;/, 'sales-unit add action should span the form');
    listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'medformclose' } }) }, preventDefault() {} });
    assert.equal(run('rt'), 'pos', 'cancelling an item added from POS should return to POS');
    listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'add:med' } }) }, preventDefault() {} });
    ctx.__medForm = { __m: { name: 'POS Added Medicine', composition: '250mg', stock: '8', photo: '', expiration_date: '', notification_date: '' }, querySelectorAll: () => [{ querySelector: (selector) => selector == '.unit-name' ? { value: 'Tablet' } : selector == '.unit-price' ? { value: '1250' } : { value: '1' } }] };
    ctx.__medEvent = { preventDefault() {}, target: ctx.__medForm };
    await run('medicineSave(__medEvent)');
    assert.equal(run('rt'), 'pos', 'saving an item added from POS should return to POS');
    assert.ok(run(`D.med.some(m=>m.name=="POS Added Medicine")`), 'medicine added from POS should be saved');
    ok('POS Add item opens the screenshot medicine form and returns to POS after saving');
    run('rt="med";q="";medicineFormOpen=true;medicineEditIndex=null;render()'); let medicineHtml = run('R.med()');
    for (const must of ['Medicine Image', 'Drug name', 'Composition', 'In Stock', 'Sales unit', 'Unit name', 'Price (KHR)', 'Qty per unit', 'Expiration date', 'Notification date', 'medunitadd', 'Add']) assert.ok(medicineHtml.includes(must), 'medicine form missing ' + must);
    assert.ok(medicineHtml.includes('data-a="medimport"') && medicineHtml.includes('id="med-import-file"'), 'medicine page should offer Excel import');
    const medicineUnitInput = (value) => ({ value, });
    const medicineRow = { querySelector: (selector) => selector == '.unit-name' ? medicineUnitInput('Tablet') : selector == '.unit-price' ? medicineUnitInput('5000') : medicineUnitInput('1') };
    ctx.__medForm = { __m: { name: 'Amoxicillin', composition: '500mg capsule', stock: '30', photo: '', expiration_date: '2027-06-30', notification_date: '2027-05-30' }, querySelectorAll: () => [medicineRow] };
    ctx.__medEvent = { preventDefault() {}, target: ctx.__medForm };
    await run('medicineSave(__medEvent)');
    let medicine = run(`D.med.find(x=>x.name=="Amoxicillin")`);
    assert.ok(medicine && medicine.composition == '500mg capsule' && medicine.stock == 30);
    assert.deepEqual(JSON.parse(medicine.units), [{ name: 'Tablet', price: 5000, qty: 1 }]);
    const medicineIndex = run('D.med.indexOf(D.med.find(x=>x.name=="Amoxicillin"))');
    medicineHtml = run('R.med()');
    for (const action of ['medstock', 'medcomposition', 'medqr', 'medbarcode']) assert.ok(medicineHtml.includes(`data-a="${action}:${medicineIndex}"`), 'medicine row missing ' + action + ' action');
    assert.ok(medicineHtml.includes('data-a="medlayout"') && medicineHtml.includes('Switch to Cards View') && !medicineHtml.includes('medlayout:table') && !medicineHtml.includes('medlayout:cards') && medicineHtml.includes(`data-a="medview:${medicine.id}"`), 'Medicine table should offer a single layout toggle and a detail view');
    assert.match(medicineCss, /\.medicine-card\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\);/s, 'medicine card photo and details should each use half the card width');
    assert.match(medicineCss, /\.medicine-card-photo\s*\{[^}]*width:\s*calc\(100% - 12px\);[^}]*height:\s*auto;[^}]*aspect-ratio:\s*1;/s, 'medicine card photos should use a square crop at half card width');
    assert.match(medicineCss, /\.medicine-thumb\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/s, 'medicine table thumbnails should be square');
    listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'medlayout' } }) }, preventDefault() {} });
    assert.equal(run('medicineLayout'), 'cards');
    const medicineCardsHtml=run('R.med()');
    assert.ok(medicineCardsHtml.includes('medicine-card-grid') && medicineCardsHtml.includes('medicine-card') && medicineCardsHtml.includes('Switch to Table View') && medicineCardsHtml.includes(`data-a="medview:${medicine.id}"`), 'Cards layout should show medicine cards, a single reverse toggle, and a detail action');
    listeners.click[0]({ target: { closest: () => ({ dataset: { a: `mededit:${medicineIndex}` } }) }, preventDefault() {} });
    assert.equal(run('medicineLayout'), 'cards', 'editing a medicine from Cards should preserve the selected layout');
    assert.equal(run('medicineFormOpen'), true);
    const medicineEditPage=run('R.med()');
    assert.ok(medicineEditPage.includes('<h1>Edit Medicine</h1>') && medicineEditPage.includes('medicine-edit-page') && medicineEditPage.includes('value="Amoxicillin"'));
    assert.ok(!medicineEditPage.includes('medicine-table-wrap'), 'edit should open a dedicated medicine form, not the item list');
    ctx.__medForm.__m = { name: 'Amoxicillin', composition: '500mg capsule', stock: '35', photo: '', expiration_date: '2027-06-30', notification_date: '2027-05-30' };
    await run('medicineSave(__medEvent)');
    assert.equal(run('medicineFormOpen'), false, 'saving an edit should close the form');
    assert.equal(run('medicineEditIndex'), null);
    assert.equal(run('medicineLayout'), 'cards', 'saving should return to Cards when that was the selected layout');
    assert.ok(run('R.med()').includes('medicine-card-grid') && !run('R.med()').includes('medicine-form-card'));
    assert.equal(run(`D.med.find(x=>x.name=="Amoxicillin").stock`), 35);
    listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'medlayout' } }) }, preventDefault() {} });
    assert.equal(run('medicineLayout'), 'table');
    listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'medview:' + medicine.id } }) }, preventDefault() {} });
    assert.equal(run('medicineViewId'), String(medicine.id));
    const medicineDetail=run('R.med()');
    for (const detail of ['medicine-detail', 'Back to Medicines', 'Medicine ID:', 'Composition', '500mg capsule', 'Sales units and prices', 'Tablet', 'KHR 5,000', 'Inventory dates', '2027-06-30']) assert.ok(medicineDetail.includes(detail), 'Medicine detail view missing ' + detail);
    listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'medback' } }) }, preventDefault() {} });
    assert.equal(run('medicineViewId'), null);
    listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'medlayout' } }) }, preventDefault() {} });
    assert.equal(run('medicineLayout'), 'cards');
    medicineHtml = run('R.med()');
    assert.ok(medicineHtml.includes('data-a="medqrbulk"') && medicineHtml.includes('data-a="medbarcodebulk"'), 'medicine page should expose bulk code exports outside row actions');
    assert.ok(!medicineHtml.includes('medqrdownload') && !medicineHtml.includes('medbarcodedownload'), 'bulk code exports should not be in row actions');
    assert.ok(medicineHtml.includes('500mg capsule') && medicineHtml.includes('Tablet:') && medicineHtml.includes('2027-06-30') && medicineHtml.includes(`data-a="mededit:${medicineIndex}"`));
    run(`viewMedicineComposition(${medicineIndex})`); assert.ok(els['#mf'].innerHTML.includes('500mg capsule') && !els['#mf'].innerHTML.includes('<textarea'));
    run(`updateMedicineStock(${medicineIndex})`); assert.ok(els['#mf'].innerHTML.includes('Update Stock') && els['#mf'].innerHTML.includes('value="35"'));
    els['#mf'].__m = { stock: '42' }; await run(`$('#mf').onsubmit({preventDefault(){},target:$('#mf')})`);
    assert.equal(run(`D.med.find(x=>x.name=="Amoxicillin").stock`), 42, ctx.__toast);
    run('printDoc=function(t,h){__printed=[t,h]}');
    await run(`printMedicineCode(${medicineIndex},'qr')`);
    assert.equal(ctx.__printed[0], 'Medicine QR Code'); assert.ok(ctx.__printed[1].includes('Amoxicillin') && ctx.__printed[1].includes('<svg'));
    await run(`printMedicineCode(${medicineIndex},'barcode')`);
    assert.equal(ctx.__printed[0], 'Medicine Barcode'); assert.ok(ctx.__printed[1].includes('Amoxicillin') && ctx.__printed[1].includes('<svg'));
    run('printDoc=__nativePrintDoc');
    run('rt="med";q=""'); await run(`exportMedicineCodes('qr')`);
    assert.equal(downloads[downloads.length - 1].download, 'medicine-qr-codes.svg');
    const qrSheet = await downloads.blob.text();
    assert.ok(qrSheet.includes('Amoxicillin')); assert.equal((qrSheet.match(/<svg x="/g) || []).length, run('D.med.length'));
    await run(`exportMedicineCodes('barcode')`);
    assert.equal(downloads[downloads.length - 1].download, 'medicine-barcode-codes.svg');
    const barcodeSheet = await downloads.blob.text();
    assert.ok(barcodeSheet.includes('Amoxicillin')); assert.equal((barcodeSheet.match(/<svg x="/g) || []).length, run('D.med.length'));
    ok('medicine stock, composition, print actions, and toolbar bulk code exports work');
    run(`medicineEditIndex=D.med.indexOf(D.med.find(x=>x.name=="Amoxicillin"));medicineFormOpen=true;render()`); medicineHtml = run('R.med()');
    assert.ok(medicineHtml.includes('value="Amoxicillin"') && medicineHtml.includes('value="500mg capsule"') && medicineHtml.includes('value="Tablet"'));
    ok('Medicines list and Add/Edit form support image, composition, stock, multiple sales units, and dates');
    run(`medicineFormOpen=false;medicineEditIndex=null;render();$('#med-import-file')`); let medicinePickerOpened = false; els['#med-import-file'].click = () => { medicinePickerOpened = true; };
    listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'medimport' } }) }, preventDefault() {} }); assert.ok(medicinePickerOpened);
    const medicineWorkbookForImport = new ExcelJS.Workbook(), medicineImportSheet = medicineWorkbookForImport.addWorksheet('Medicines');
    medicineImportSheet.addRow(['Drug name', 'Composition', 'In Stock', 'Price (KHR)']); medicineImportSheet.addRow(['Imported UI medicine', '100mg', 18, 1500]);
    const uiMedicineImportBytes = Buffer.from(await medicineWorkbookForImport.xlsx.writeBuffer());
    const medicineFile = { name: 'medicines.xlsx', size: uiMedicineImportBytes.length, arrayBuffer: async () => uiMedicineImportBytes.buffer.slice(uiMedicineImportBytes.byteOffset, uiMedicineImportBytes.byteOffset + uiMedicineImportBytes.byteLength) };
    await listeners.change.find(fn => fn.toString().includes('med-import-file'))({ target: { id: 'med-import-file', files: [medicineFile], value: 'medicines.xlsx' } });
    const importedUiMedicine = run(`D.med.find(m=>m.name=="Imported UI medicine")`);
    assert.ok(importedUiMedicine && importedUiMedicine.composition == '100mg' && importedUiMedicine.stock == 18); ok('medicine Excel import button saves spreadsheet rows');

    // ---- Services cards and Add / Edit form ----
    run('rt="sv";q="";render()'); let serviceHtml = run('R.sv()');
    assert.ok(serviceHtml.includes('data-a="svimport"') && serviceHtml.includes('id="sv-import-file"') && serviceHtml.includes('accept=".csv,.xlsx'), 'Services screen should expose Excel and CSV import');
    const parsedServices = JSON.parse(JSON.stringify(run(`parseServiceCsv('\\ufeffService Name,Price (KHR),Description\\r\\n"Peel, premium","25,000","Includes ""aftercare"", too"')`)));
    assert.deepEqual(parsedServices, [{ name: 'Peel, premium', price: 25000, description: 'Includes "aftercare", too' }]);
    run(`$('#sv-import-file')`); let pickerOpened = false; els['#sv-import-file'].click = () => { pickerOpened = true; };
    listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'svimport' } }) }, preventDefault() {} });
    assert.ok(pickerOpened, 'Import Excel action should open the file picker');
    const importFile = { name: 'services.csv', size: 120, text: async () => 'name,price,description\r\n"CSV peel",25000,"Peel, premium"\r\nCSV facial,40000,Khmer service' };
    const fileInput = { id: 'sv-import-file', files: [importFile], value: 'services.csv' };
    await listeners.change.find(fn => fn.toString().includes('sv-import-file'))({ target: fileInput });
    assert.equal(fileInput.value, ''); assert.equal(run(`D.sv.find(x=>x.name=="CSV peel").price`), 25000); assert.equal(run(`D.sv.find(x=>x.name=="CSV peel").description`), 'Peel, premium');
    assert.equal(run(`D.sv.find(x=>x.name=="CSV facial").price`), 40000); ok('Excel-compatible CSV import handles quoted fields, saves services and resets the file input');
    const serviceCount = run('D.sv.length');
    await run(`importServicesFile({name:'bad.csv',size:10,text:async()=>'name,price\\nMissing price,not-a-number'})`);
    assert.equal(run('D.sv.length'), serviceCount); assert.match(run('__toast'), /Row 2: price must be a whole number/); ok('invalid CSV import reports row errors without changing services');
    const workbookForImport = new ExcelJS.Workbook(), importSheet = workbookForImport.addWorksheet('Services');
    importSheet.addRow(['Service Name', 'Price (KHR)', 'Description']); importSheet.addRow(['Excel service', 35000, 'Imported from workbook']);
    const importBytes = Buffer.from(await workbookForImport.xlsx.writeBuffer());
    ctx.__xlsx = { name: 'services.xlsx', size: importBytes.length, arrayBuffer: async () => importBytes.buffer.slice(importBytes.byteOffset, importBytes.byteOffset + importBytes.byteLength) };
    await run('importServicesFile(__xlsx)');
    const xlsxService = run(`D.sv.find(x=>x.name=="Excel service")`);
    assert.ok(xlsxService && xlsxService.price == 35000 && xlsxService.description == 'Imported from workbook'); ok('Services import accepts real .xlsx workbooks');
    run('serviceForm()'); serviceHtml = els['#mf'].innerHTML;
    for (const must of ['Add Service', 'name="name"', 'name="price"', 'name="description"', 'type="number"', 'min="0"', 'e.g. Facial treatment', 'e.g. 60000', 'Enter service details', 'data-a="close"', 'Add']) assert.ok(serviceHtml.includes(must), 'service form missing ' + must);
    els['#mf'].__m = { name: 'Facial care', price: '60000', description: 'សេវាថែរក្សាផ្ទៃមុខ' };
    await run(`$("#mf").onsubmit({preventDefault(){},target:$("#mf")})`);
    let service = run(`D.sv.find(x=>x.name=="Facial care")`); assert.ok(service, `service was not saved; toast=${run('__toast')}; services=${JSON.stringify(run('D.sv'))}`); assert.equal(service.price, 60000); assert.equal(service.description, 'សេវាថែរក្សាផ្ទៃមុខ');
    serviceHtml = run('R.sv()'); assert.ok(serviceHtml.includes('service-grid') && serviceHtml.includes('Facial care') && serviceHtml.includes('KHR 60,000') && serviceHtml.includes('សេវាថែរក្សាផ្ទៃមុខ') && serviceHtml.includes(`data-a="edit:sv:${run('D.sv.findIndex(x=>x.name=="Facial care")')}"`) && serviceHtml.includes(`data-a="del:sv:${run('D.sv.findIndex(x=>x.name=="Facial care")')}"`)); ok('Services are displayed as searchable cards with price, description and Edit/Delete actions');
    run(`serviceForm(D.sv.indexOf(D.sv.find(x=>x.name=="Facial care")))`); assert.ok(els['#mf'].innerHTML.includes('Edit Service') && els['#mf'].innerHTML.includes('value="Facial care"') && els['#mf'].innerHTML.includes('សេវាថែរក្សាផ្ទៃមុខ') && els['#mf'].innerHTML.includes('>Save</button>'));
    els['#mf'].__m = { name: 'Facial care', price: '65000', description: 'Updated service description' };
    await run(`$("#mf").onsubmit({preventDefault(){},target:$("#mf")})`); service = run(`D.sv.find(x=>x.name=="Facial care")`); assert.equal(service.price, 65000); assert.equal(service.description, 'Updated service description'); ok('service edits save updated price and description');

    // ---- Lab Templates ----
    run('rt="lab";q="";render()'); let labHtml = run('R.lab()');
    for (const must of ['Lab Templates', 'Upload Lab', 'Export Excel', 'Add Type', 'Add Lab Template', 'Name', 'Price', 'Type', 'Actions']) assert.ok(labHtml.includes(must), 'Lab template list missing ' + must);
    run(`labForm()`); let labFormHtml = els['#mf'].innerHTML;
    for (const must of ['Add Lab Template', 'name="name"', 'name="price"', 'name="cat"', 'Fields', 'Add Field', 'labfieldadd', 'data-a="close"', 'Save']) assert.ok(labFormHtml.includes(must), 'Lab template form missing ' + must);
    els['#mf'].__m = { name: 'Complete Blood Count', price: '12000', cat: 'Hematology', lab_field_0: 'WBC', lab_field_1: 'RBC' };
    await run(`$("#mf").onsubmit({preventDefault(){},target:$("#mf")})`);
    let lab = run(`D.lab.find(x=>x.name=="Complete Blood Count")`);
    assert.ok(lab, `lab template was not saved; toast=${run('__toast')}`);
    assert.equal(lab.price, 12000); assert.equal(lab.cat, 'Hematology'); assert.deepEqual(JSON.parse(lab.fields), ['WBC', 'RBC']);
    labHtml = run('R.lab()');
    assert.ok(labHtml.includes('Complete Blood Count') && labHtml.includes('KHR 12,000') && labHtml.includes('Hematology') && labHtml.includes('data-a="labedit:') && labHtml.includes('data-a="labdel:'), 'Lab list should show saved values and row actions');
    run(`labForm(D.lab.indexOf(D.lab.find(x=>x.name=="Complete Blood Count")))`);
    labFormHtml = els['#mf'].innerHTML;
    assert.ok(labFormHtml.includes('Edit Lab Template') && labFormHtml.includes('value="Hematology"') && labFormHtml.includes('value="WBC"') && labFormHtml.includes('value="RBC"'), 'editing a lab template should prefill category and fields');
    els['#mf'].__m = { name: 'Complete Blood Count', price: '15000', cat: 'Hematology', lab_field_0: 'WBC', lab_field_1: 'RBC', lab_field_2: 'Hemoglobin' };
    await run(`$("#mf").onsubmit({preventDefault(){},target:$("#mf")})`);
    lab = run(`D.lab.find(x=>x.name=="Complete Blood Count")`);
    assert.equal(lab.price, 15000); assert.deepEqual(JSON.parse(lab.fields), ['WBC', 'RBC', 'Hemoglobin']);
    const savedModal = run('modal'); run('modal=(...args)=>{__labModal=args}'); run('labCategoryForm()');
    assert.equal(run('__labModal[0]'), 'Add Type'); assert.equal(run('__labModal[1][0][0]'), 'Type');
    await run(`__labModal[3]({name:'Hematology'})`); await run('load()');
    assert.ok(run(`D.labcategories.some(x=>x.name=="Hematology")`), 'Lab categories should persist through the API');
    await assert.rejects(run(`__labModal[3]({name:'hematology'})`), /Type already exists/);
    ctx.__savedModal = savedModal; run('modal=__savedModal');
    run(`q="blood";labHtml=R.lab()`); assert.ok(run('labHtml').includes('Complete Blood Count'));
    run(`q="not found";labHtml=R.lab()`); assert.ok(!run('labHtml').includes('Complete Blood Count'));
    run('q=""');
    run(`$('#lab-import-file')`); const labPicker = els['#lab-import-file']; let labPickerOpened = false; labPicker.click = () => { labPickerOpened = true; };
    listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'labimport' } }) }, preventDefault() {} });
    assert.ok(labPickerOpened, 'Lab Upload action should open the workbook picker');
    const labWorkbook = new ExcelJS.Workbook(), labSheet = labWorkbook.addWorksheet('Labs');
    labSheet.addRow(['Test name', 'Price (KHR)', 'Category', 'Fields']); labSheet.addRow(['Imported CBC', 8000, 'Hematology', '["Platelets","Hematocrit"]']);
    const labImportBytes = Buffer.from(await labWorkbook.xlsx.writeBuffer());
    const labFile = { name: 'labs.xlsx', size: labImportBytes.length, arrayBuffer: async () => labImportBytes.buffer.slice(labImportBytes.byteOffset, labImportBytes.byteOffset + labImportBytes.byteLength) };
    ctx.__labFile = labFile; await run('importLabsFile(__labFile)');
    const importedLab = run(`D.lab.find(x=>x.name=="Imported CBC")`);
    assert.ok(importedLab && importedLab.price == 8000 && importedLab.cat == 'Hematology'); assert.deepEqual(JSON.parse(importedLab.fields), ['Platelets', 'Hematocrit']);
    ok('Lab templates support searchable table, add/edit fields, categories, and Excel import');

    // ---- Echo Templates ----
    run('rt="echo";q="";render()'); let echoHtml = run('R.echo()');
    for (const must of ['Echo Templates', 'Create Template', 'Upload', 'Download', 'echo-template-grid']) assert.ok(echoHtml.includes(must), 'Echo templates page missing ' + must);
    run('echoForm()'); let echoFormHtml = els['#mf'].innerHTML;
    for (const must of ['Create Echo Template', 'Template Name', 'Default Font', 'Section Content (Title/Body)', 'contenteditable="true"', 'Insert Table', 'Additional Fields (Optional)', 'Field Name', 'Add Field', 'Add New Section', 'Save Template', 'data-echo-color="foreColor"', 'data-echo-color="hiliteColor"', 'data-a="echoformat:0:createLink"', 'data-a="echoformat:0:insertImage"', 'echo-image-file-0', 'accept="image/jpeg,image/png,image/webp"', 'Insert Image From Device', '<svg viewBox="0 0 24 24"']) assert.ok(echoFormHtml.includes(must), 'Echo template editor missing ' + must);
    let imagePickerOpened = false;
    els['#echo-image-file-0'] = el();
    els['#echo-image-file-0'].click = () => { imagePickerOpened = true; };
    run(`echoFormat('0','insertImage')`);
    assert.ok(imagePickerOpened, 'Echo image toolbar should open the local file picker');
    const pngImage = new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' });
    ctx.__imageFile = pngImage;
    let insertedImageUrl = '';
    ctx.document.execCommand = (command, _, value) => { if (command === 'insertImage') insertedImageUrl = value; };
    await run(`echoUploadImage('0',__imageFile)`);
    assert.match(insertedImageUrl, /^\/uploads\/[a-f0-9]{32}\.png$/, 'local image should upload and insert a persistent uploads URL');
    const uploadedImageUrl = insertedImageUrl;
    delete ctx.document.execCommand;
    let echoTableDialogHtml = '';
    els['#md'].insertAdjacentHTML = (_, html) => { echoTableDialogHtml = html; };
    run(`echoFormat('0','insertTable')`);
    for (const must of ['echo-table-dialog', 'echo-table-rows', 'value="2"', 'echo-table-columns', 'echo-table-header-color', 'echo-table-header-hex', 'echo-table-border-color', 'echo-table-border-hex', 'echo-table-border-style', 'Dashed', 'Dotted', 'Double', 'echotableinsert']) assert.ok(echoTableDialogHtml.includes(must), 'Echo Insert Table dialog missing ' + must);
    for (const selector of ['#echo-table-rows', '#echo-table-columns', '#echo-table-header-hex', '#echo-table-border-hex', '#echo-table-border-style']) run(`$('${selector}')`);
    els['#echo-table-rows'].value = '3'; els['#echo-table-columns'].value = '4'; els['#echo-table-header-hex'].value = '#ffffcc'; els['#echo-table-border-hex'].value = '#123456'; els['#echo-table-border-style'].value = 'dotted';
    let insertedEchoTable = '';
    ctx.document.execCommand = (command, _, html) => { if (command === 'insertHTML') insertedEchoTable = html; };
    run('echoTableInsert()');
    assert.equal((insertedEchoTable.match(/<tr>/g)||[]).length,3); assert.equal((insertedEchoTable.match(/<th /g)||[]).length,4); assert.equal((insertedEchoTable.match(/<td /g)||[]).length,8);
    assert.ok(insertedEchoTable.includes('background-color:#ffffcc') && insertedEchoTable.includes('border:1px dotted #123456'));
    delete ctx.document.execCommand;
    els['#mf'].__m = { name: 'Abdominal Ultrasound', price: '25000', font: 'Moul', echo_title_0: 'Findings', echo_content_0: `<p onclick="alert(1)">Liver normal <strong>size</strong> <font color="#ff0000">abnormal</font> <span style="background-color:#ffff00">highlight</span> <a href="https://example.test/report" onclick="alert(1)">report</a> <a href="javascript:alert(1)">bad link</a> <img src="https://example.test/image.jpg" onerror="alert(1)"><img src="${uploadedImageUrl}" alt="Local"></p><table style="width:100%;border-collapse:collapse;border:1px dotted #123456"><tbody><tr><th style="border:1px dotted #123456;padding:6px;background-color:#ffffcc" onmouseover="alert(1)">Header</th><td style="border:1px dotted #123456;padding:6px">Value</td></tr></tbody></table><script>alert(2)</script>`, echo_field_0_0: 'Patient ID', echo_field_0_1: 'Exam date' };
    await run(`$("#mf").onsubmit({preventDefault(){},target:$("#mf")})`);
    let echoTemplate = run(`D.echo.find(x=>x.name=="Abdominal Ultrasound")`);
    assert.ok(echoTemplate, `echo template was not saved; toast=${run('__toast')}`);
    assert.equal(echoTemplate.price, 25000); assert.equal(echoTemplate.font, 'Moul');
    let echoSections = JSON.parse(echoTemplate.sections);
    assert.equal(echoSections[0].title, 'Findings'); assert.deepEqual(echoSections[0].fields, ['Patient ID', 'Exam date']);
    assert.ok(echoSections[0].content.startsWith('<p>Liver normal <strong>size</strong> <span style="color:#ff0000">abnormal</span>'), 'saved rich text should preserve formatted text colors');
    assert.ok(echoSections[0].content.includes('<table style="width:100%;border-collapse:collapse;border:1px dotted #123456">'), 'saved rich text should preserve safe table styling');
    assert.ok(echoSections[0].content.includes('background-color:#ffffcc') && !echoSections[0].content.includes('onmouseover') && !echoSections[0].content.includes('<script'), 'table styles should remain while unsafe attributes and scripts are removed');
    assert.ok(echoSections[0].content.includes('<span style="color:#ff0000">abnormal</span>') && echoSections[0].content.includes('background-color:#ffff00'), 'text and highlight colors should persist');
    assert.ok(echoSections[0].content.includes('<a href="https://example.test/report"') && echoSections[0].content.includes('<img src="https://example.test/image.jpg"') && !echoSections[0].content.includes('javascript:'), 'safe links and images should persist without event handlers or unsafe URLs');
    assert.ok(echoSections[0].content.includes(`<img src="${uploadedImageUrl}" alt="Local">`), 'uploaded local image URLs should persist in the saved template');
    echoHtml = run('R.echo()');
    assert.ok(echoHtml.includes('Abdominal Ultrasound') && echoHtml.includes('Font: Moul') && echoHtml.includes('echo-template-price') && echoHtml.includes('data-a="echoedit:') && echoHtml.includes('data-a="echodel:'), 'Echo template cards should show price, font, and edit/delete controls');
    run(`echoForm(D.echo.indexOf(D.echo.find(x=>x.name=="Abdominal Ultrasound")))`);
    echoFormHtml = els['#mf'].innerHTML;
    assert.ok(echoFormHtml.includes('Edit Echo Template') && echoFormHtml.includes('value="Findings"') && echoFormHtml.includes('Liver normal <strong>size</strong>') && echoFormHtml.includes('value="Patient ID"') && echoFormHtml.includes('value="Exam date"'), 'editing an Echo template should restore rich content and additional fields');
    els['#mf'].__m = { name: 'Abdominal Ultrasound', price: '30000', font: 'Koulen', echo_title_0: 'Impression', echo_content_0: '<p>Updated report</p>', echo_field_0_0: 'Patient ID', echo_field_0_1: 'Exam date' };
    await run(`$("#mf").onsubmit({preventDefault(){},target:$("#mf")})`);
    echoTemplate = run(`D.echo.find(x=>x.name=="Abdominal Ultrasound")`);
    assert.equal(echoTemplate.price, 30000); assert.equal(echoTemplate.font, 'Koulen');
    assert.equal(JSON.parse(echoTemplate.sections)[0].content, '<p>Updated report</p>');
    run('echoForm()'); els['#mf'].__m = { name: 'Blank Echo', price: '0', font: 'Moul', echo_title_0: '', echo_content_0: '', echo_field_0_0: '' };
    await run(`$("#mf").onsubmit({preventDefault(){},target:$("#mf")})`);
    assert.equal(JSON.parse(run(`D.echo.find(x=>x.name=="Blank Echo").sections`)).length, 1, 'a new template should be allowed to save with an empty editor section');
    run('echoForm()'); els['#mf'].__m = { name: 'Long Report Template', price: '0', font: 'Moul', echo_title_0: 'Section One', echo_content_0: 'A'.repeat(5000), echo_field_0_0: '', echo_title_1: 'Section Two', echo_content_1: 'B'.repeat(5000), echo_field_1_0: '', echo_title_2: 'Section Three', echo_content_2: 'C'.repeat(5000), echo_field_2_0: '' };
    await run(`$("#mf").onsubmit({preventDefault(){},target:$("#mf")})`);
    const longEcho = run(`D.echo.find(x=>x.name=="Long Report Template")`);
    assert.ok(longEcho, `Echo sections over the old 10,000-character limit should save; toast=${run('__toast')}`);
    assert.equal(JSON.parse(longEcho.sections).reduce((length,section)=>length+section.content.length,0), 15000);
    run('echoForm()'); els['#mf'].__m = { name: 'Long Single Section', price: '0', font: 'Moul', echo_title_0: 'Full report', echo_content_0: 'R'.repeat(12000), echo_field_0_0: '' };
    await run(`$("#mf").onsubmit({preventDefault(){},target:$("#mf")})`);
    const longSectionEcho = run(`D.echo.find(x=>x.name=="Long Single Section")`);
    assert.ok(longSectionEcho, `a single Echo section over 9,000 characters should save; toast=${run('__toast')}`);
    assert.equal(JSON.parse(longSectionEcho.sections)[0].content.length, 12000);
    run('q="ultrasound";echoHtml=R.echo()'); assert.ok(run('echoHtml').includes('Abdominal Ultrasound'));
    run('q="missing";echoHtml=R.echo()'); assert.ok(!run('echoHtml').includes('Abdominal Ultrasound'));
    run('q=""');
    run(`$('#echo-import-file')`); const echoPicker = els['#echo-import-file']; let echoPickerOpened = false; echoPicker.click = () => { echoPickerOpened = true; };
    listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'echoimport' } }) }, preventDefault() {} });
    assert.ok(echoPickerOpened, 'Echo Upload action should open the workbook picker');
    const echoWorkbook = new ExcelJS.Workbook(), echoSheet = echoWorkbook.addWorksheet('Echo');
    echoSheet.addRow(['Template Name', 'Price (KHR)', 'Default Font', 'Sections', 'Additional Fields']);
    echoSheet.addRow(['Imported Echo', 18000, 'Moul', JSON.stringify([{ title: 'Result', content: '<p>Report</p>', fields: ['Comment'] }]), '["Comment"]']);
    const echoImportBytes = Buffer.from(await echoWorkbook.xlsx.writeBuffer());
    const echoFile = { name: 'echo.xlsx', size: echoImportBytes.length, arrayBuffer: async () => echoImportBytes.buffer.slice(echoImportBytes.byteOffset, echoImportBytes.byteOffset + echoImportBytes.byteLength) };
    ctx.__echoFile = echoFile; await run('importEchoFile(__echoFile)');
    const importedEcho = run(`D.echo.find(x=>x.name=="Imported Echo")`);
    assert.ok(importedEcho && importedEcho.price == 18000); assert.equal(JSON.parse(importedEcho.sections)[0].fields[0], 'Comment');
    await run('exportEchoTemplates()');
    assert.equal(downloads[downloads.length - 1].download, 'echo-templates.xlsx');
    const echoExportBook = new ExcelJS.Workbook(); await echoExportBook.xlsx.load(Buffer.from(await downloads.blob.arrayBuffer()));
    assert.equal(echoExportBook.worksheets[0].getRow(1).getCell(1).value, 'name');
    assert.equal(echoExportBook.worksheets[0].getRow(2).getCell(1).value, 'Abdominal Ultrasound');
    ok('Echo templates support sections, rich formatting, additional fields, and Excel upload/download');

    // ---- Consultation Form (CNF) ----
    run('cnfForm()'); for (const must of ['General Form', 'Assessment &amp; Plan', 'Form History', '1. Problems &amp; Concerns', 'Acne scars', '2. Skin type', '3. History of reactions', 'Product usage history', 'Medicine usage', 'Treatment history', 'Personal &amp; family history', 'Lifestyle', 'For women', 'Treatment Agreement', 'Acceptance &amp; Results', 'Guarantee of Care', 'Privacy Notice', 'Photo Consent', 'Responsibility', 'Other Notices', 'Payment Policy', 'Customer understanding', 'Warnings &amp; conditions', 'Personal interview', 'Customer name', 'Test Patient', 'No history records yet', 'Occupation', 'Address override', 'Personal Interview', 'Doctor’s Assessment', 'Doctor’s Treatment Plan', 'Special Notes - Image 5', 'Have you visited our clinic before?', 'TikTok', 'Telegram', 'Facebook', 'Current address', 'Additional notes']) assert.ok(ctx.__body.replace(/&amp;/g, '&amp;').includes(must) || ctx.__body.includes(must.replace('&amp;', '&')), 'CNF form missing ' + must);
    assert.ok(ctx.__opts.extra.includes('Print Current') && ctx.__opts.ok == 'Save Only'); ok('Consultation Form has every section, Form History and Print Current / Save Only');
    ctx.__f = { __m: { cn_occ: 'Teacher', cnc_prob: ['Acne', 'Wrinkles'], cn_prob_o: 'freckles', cnc_skin: ['Oily'], cnc_react: ['None'], cnc_accept: ['Can accept'], cnc_und: ['Received and understood well'], cn_und_t: 'Understood', cn_as_interview: 'Discussed expectations', cn_as_ass: 'Acne vulgaris', cn_as_plan: 'Peel x6', cnc_as_previous: ['បាទ/ចាស'], cnc_as_source: ['Telegram', 'Facebook'], cn_as_reason: 'Acne treatment', cn_as_address: 'Phnom Penh', cn_as_note: 'Edited wording', cn_ag_acc: 'Edited wording' } };
    await run('__save(__f)'); const cn = run('recs.find(r=>r.kind=="cnf")'); const cd = JSON.parse(cn.data); assert.deepEqual(cd.prob, ['Acne', 'Wrinkles']); assert.equal(cd.prob_o, 'freckles'); assert.equal(cd.as_interview, 'Discussed expectations'); assert.equal(cd.as_ass, 'Acne vulgaris'); assert.equal(cd.as_plan, 'Peel x6'); assert.deepEqual(cd.as_previous, ['បាទ/ចាស']); assert.deepEqual(cd.as_source, ['Telegram', 'Facebook']); assert.equal(cd.as_note, 'Edited wording'); assert.equal(cd.ag_acc, 'Edited wording'); ok('CNF answers, agreement text and assessment saved together');
    run("ptab='consultation';pdDate=''");
    const consultationPanel = run('recPanel()');
    for (const item of ['consultation-toolbar', 'data-a="consult-medical"', 'data-a="consult-documents"', 'data-a="consult-cnf"', 'data-a="consult-history"', 'data-a="center-form"', 'មណ្ឌល', 'data-a="radd"', 'ប្រវត្តិពិគ្រោះ', 'Acne, Wrinkles', 'ការវាយតម្លៃរបស់វេជ្ជបណ្ឌិត៖', 'Acne vulgaris', 'ផែនការព្យាបាល៖', 'Peel x6']) assert.ok(consultationPanel.includes(item), 'patient Consultation tab missing ' + item);
    assert.ok(consultationPanel.includes(`data-a="redit:${cn.id}"`) && consultationPanel.includes(`data-a="rdel:${cn.id}"`), 'consultation form history should support editing and deletion');
    run("pAct('consult-medical')"); assert.equal(ctx.__title, 'ទម្រង់ពិគ្រោះជំងឺ', 'Consultation shortcut should open the dedicated consultation form');
    assert.ok(ctx.__body.includes('consultation-intake') && ctx.__body.includes('consultation-assessment-columns') && ctx.__body.includes('consultation-classification') && ctx.__body.includes('consultation-questions') && ctx.__body.includes('consultation-symptom-row'), 'consultation form should match the screenshot left/right sections');
    assert.equal((ctx.__body.match(/name="symptoms"/g) || []).length, 5, 'general consultation form should show the five screenshot complaint choices');
    assert.ok(ctx.__body.includes('consultation-final-note') && ctx.__body.includes('name="followup_date"') && ctx.__body.includes('name="assessment"'), 'general consultation form should end with its notes and two follow-up fields');
    assert.equal(ctx.__opts.close, true, 'consultation form should show a top close control');
    assert.equal(ctx.__opts.hideCancel, true, 'consultation form footer should only contain screenshot actions');
    for (const field of ['chief_complaint', 'medical_history', 'symptoms', 'assessment', 'treatment_plan', 'followup_date']) assert.ok(ctx.__body.includes(`name="${field}"`), 'Khmer consultation form missing ' + field);
    const consultationCss = fs.readFileSync(path.join(frontendDir, 'styles.css'), 'utf8');
    assert.match(consultationCss, /\.consultation-intake\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\);/s, 'consultation intake must retain the left/right screenshot layout');
    assert.match(consultationCss, /#mf\.consultation-form-dialog\s*\{[^}]*width:\s*min\(1480px,\s*98vw\);/s, 'consultation form modal should use the available screenshot width');
    assert.match(consultationCss, /#mf\.cnf\s*\{[^}]*width:\s*min\(1480px,\s*98vw\);/s, 'clinic form should also use the available screenshot width');
    ctx.__f = { __m: { date: '2026-10-22T17:00', chief_complaint: 'ឈឺក្បាល', medical_history: '២ ថ្ងៃ', symptoms: ['headache'], assessment: 'ឈឺក្បាលធម្មតា', treatment_plan: 'សម្រាក និងផឹកទឹក', followup_date: '2026-10-24', notes: 'តាមដាន' } };
    await run('__save(__f)');
    const savedConsultation = run(`recs.find(r=>r.kind=="consultation"&&JSON.parse(r.data).consultation_mode=="standard")`);
    assert.ok(savedConsultation && JSON.parse(savedConsultation.data).chief_complaint == 'ឈឺក្បាល' && JSON.parse(savedConsultation.data).symptoms.includes('headache'), 'consultation form should save Khmer answers');
    ctx.__f = { __m: { consultation_mode: 'standard', date: '2026-10-22T17:00', patient_name: 'Test Patient', patient_age: '៣០', patient_sex: 'ស្រី', chief_complaint: '<b>ឈឺក្បាល</b>', medical_history: 'ឈឺរយៈពេល២ថ្ងៃ', symptoms: ['headache'], conditions: ['adult'], visit_type: ['new'], consult_type: ['mother'], imci_status: ['yes'], risk_flags: ['mild'], screening_flags: ['refer'], history_flags: ['fever'], previous_condition: ['no'], family_condition: ['yes'], rh_positive: 'វិជ្ជមាន', blood_pressure: '120/80', pulse: '80', height: '160', weight: '55', treatment_plan: 'សម្រាក និងផឹកទឹក', assessment: 'ឈឺក្បាល' } };
    run("$('#mf').__m=__f.__m");
    run('printDoc=function(t,h,o){__mdPrint=[t,h,o]}');
    run("pAct('consultation-print')");
    assert.equal(ctx.__mdPrint[0], '');
    assert.ok(ctx.__mdPrint[1].includes('consultation-template-print') && ctx.__mdPrint[1].includes('A4 portrait') && ctx.__mdPrint[1].includes('ទម្រង់ពិគ្រោះជំងឺ') && ctx.__mdPrint[1].includes('Test Patient') && ctx.__mdPrint[1].includes('120/80') && ctx.__mdPrint[1].includes('សម្រាក និងផឹកទឹក') && ctx.__mdPrint[1].includes('✓') && ctx.__mdPrint[1].includes('&lt;b&gt;ឈឺក្បាល&lt;/b&gt;') && (ctx.__mdPrint[1].match(/<tr class="consultation-print-/g) || []).length == 4, 'general consultation print should match the PDF layout and preserve entered/selected values safely');
    assert.ok(ctx.__mdPrint[2].headerHtml.includes('consultation-template-no-clinic-header'), 'general consultation print should use the form logo/title header instead of a duplicate generic banner');
    assert.match(fs.readFileSync(path.join(frontendDir, 'styles.css'), 'utf8'), /\.consultation-print-table th,\s*\.consultation-print-table td\s*\{[^}]*border:\s*0\.25mm solid #111;/s, 'general consultation print table should use the PDF black grid');
    run("pAct('consult-cnf')"); assert.equal(ctx.__title, 'ទម្រង់ពិគ្រោះព្យាបាលជំងឺ(សេវាគាំពារមាតានិងទារក)', 'MD shortcut should open the maternal and child health treatment consultation form');
    for (const field of ['blood_pressure', 'pulse', 'respiratory_rate', 'temperature', 'height', 'weight', 'oxygen_saturation', 'examinations', 'medical_history', 'start_hour', 'start_minute', 'end_hour', 'end_minute']) assert.ok(ctx.__body.includes(`name="${field}"`), 'maternal and child consultation form missing ' + field);
    assert.ok(ctx.__body.includes('md-consultation-intake') && ctx.__body.includes('md-consultation-table') && ctx.__body.includes('name="patient_name"') && ctx.__body.includes('name="md_sections"') && ctx.__body.includes('name="mother_visit_months"') && ctx.__body.includes('name="child_visit_days"') && ctx.__body.includes('md-consultation-exam-grid') && ctx.__opts.cls == 'md-consultation-dialog', 'maternal and child consultation form should match the screenshot sections');
    assert.equal((ctx.__body.match(/<tr(?:\s|>)/g) || []).length, 6, 'maternal and child consultation should use the screenshot six-row table');
    assert.ok(!ctx.__body.includes('md-consultation-plan') && ctx.__body.includes('ប្រវត្តិសុខភាពមុន') && ctx.__body.includes('ការពិនិត្យរាងកាយ'), 'maternal and child consultation should not add panels absent from the screenshot');
    assert.ok(ctx.__opts.extra.includes('data-a="consultation-print"') && ctx.__opts.extra.includes('បោះពុម្ព'), 'MD consultation should provide the screenshot print action');
    const mdCss = fs.readFileSync(path.join(frontendDir, 'styles.css'), 'utf8');
    assert.match(mdCss, /\.md-consultation-table th,\s*\.md-consultation-table td\s*\{[^}]*border:\s*1px solid #222;/s, 'MD section rows should use the screenshot solid table borders');
    assert.match(mdCss, /#md \.md-inline-field\s*\{[^}]*display:\s*inline-flex;[^}]*margin:\s*0;/s, 'MD inline fields should override the global modal label layout');
    ctx.__f = { __m: { consultation_mode: 'md', date: '2026-10-22T17:10', patient_name: 'Test Patient', chief_complaint: '<b>ក្អក</b>', symptoms: ['cough'], conditions: ['adult'], survey_sex: ['female'], visit_type: ['new'], consult_type: ['mother'], md_sections: ['symptoms'], mother_visit_months: '3', start_hour: '08', start_minute: '30', end_hour: '09', end_minute: '15', blood_pressure: '120/80', pulse: '80', respiratory_rate: '18', temperature: '37', height: '165', weight: '60', oxygen_saturation: '98', examinations: ['respiratory_exam'], assessment: 'ផ្តាសាយ', investigations: 'គ្មាន', treatment_plan: 'ព្យាបាលតាមរោគសញ្ញា' } };
    run("$('#mf').__m=__f.__m");
    run('printDoc=function(t,h,o){__mdPrint=[t,h,o]}'); run("pAct('consultation-print')");
    assert.equal(ctx.__mdPrint[0], '');
    assert.ok(ctx.__mdPrint[1].includes('md-consultation-print') && ctx.__mdPrint[1].includes('A4 portrait') && ctx.__mdPrint[1].includes('Test Patient') && ctx.__mdPrint[1].includes('120/80') && ctx.__mdPrint[1].includes('08:30') && ctx.__mdPrint[1].includes('09:15') && ctx.__mdPrint[1].includes('ពិនិត្យថ្មី') && ctx.__mdPrint[1].includes('✓') && ctx.__mdPrint[1].includes('<i class="md-print-box"></i>កុមារតូច') && ctx.__mdPrint[1].includes('&lt;b&gt;ក្អក&lt;/b&gt;') && (ctx.__mdPrint[1].match(/<tr>/g) || []).length == 6, 'maternal and child print should follow the PDF page layout, escape values, and include times/selections');
    assert.ok(ctx.__mdPrint[2].headerHtml.includes('md-print-no-clinic-header'), 'maternal and child print should use the PDF heading instead of the generic clinic banner');
    assert.match(fs.readFileSync(path.join(frontendDir, 'styles.css'), 'utf8'), /\.md-consultation-print th,\s*\.md-consultation-print td\s*\{[^}]*border:\s*0\.25mm solid #111;/s, 'maternal and child print table should use the PDF black grid');
    await run('__save(__f)');
    const savedMdConsultation = run(`recs.find(r=>r.kind=="consultation"&&JSON.parse(r.data).consultation_mode=="md")`);
    assert.ok(savedMdConsultation && savedMdConsultation.title == 'ទម្រង់ពិគ្រោះព្យាបាលជំងឺ(សេវាគាំពារមាតានិងទារក)' && JSON.parse(savedMdConsultation.data).patient_name == 'Test Patient' && JSON.parse(savedMdConsultation.data).conditions.includes('adult') && JSON.parse(savedMdConsultation.data).visit_type.includes('new') && JSON.parse(savedMdConsultation.data).survey_sex.includes('female') && JSON.parse(savedMdConsultation.data).md_sections.includes('symptoms') && JSON.parse(savedMdConsultation.data).mother_visit_months == '3' && JSON.parse(savedMdConsultation.data).start_time == '08:30' && JSON.parse(savedMdConsultation.data).end_time == '09:15' && JSON.parse(savedMdConsultation.data).blood_pressure == '120/80' && JSON.parse(savedMdConsultation.data).assessment == 'ផ្តាសាយ', 'maternal and child consultation should save selected sections, visits, vitals, and existing data');
    run(`pAct('redit','${savedMdConsultation.id}')`);
    assert.equal(ctx.__title, 'ទម្រង់ពិគ្រោះព្យាបាលជំងឺ(សេវាគាំពារមាតានិងទារក)'); assert.ok(ctx.__body.includes('value="120/80"') && ctx.__body.includes('value="3"') && ctx.__body.includes('&lt;b&gt;ក្អក&lt;/b&gt;'), 'editing the maternal and child consultation should restore saved values safely');
    run("pAct('radd')"); assert.equal(ctx.__title, 'ជ្រើសរើសទម្រង់ពិគ្រោះ'); assert.ok(ctx.__body.includes('consult-select:clinic') && ctx.__body.includes('ទម្រង់ពិគ្រោះគ្លីនិក'), 'Add should offer the existing clinic form separately');
    run("pAct('consult-select','clinic')"); assert.equal(ctx.__title, 'Consultation Form (CNF)', 'Clinic form option should retain the existing clinic questionnaire');
    run("pAct('consult-history')"); assert.equal(ctx.__title, 'ប្រវត្តិពិគ្រោះជំងឺ'); assert.ok(ctx.__body.includes('consultation-history-table') && ctx.__body.includes('Medical Record') && ctx.__body.includes('Acne vulgaris') && ctx.__body.includes(`data-a="redit:${cn.id}"`), 'history shortcut should show prior consultation records in a wide table');
    run("ptab='consultation';pAct('consult-documents')"); assert.equal(run('ptab'), 'documents', 'link shortcut should open patient documents');
    run("ptab='consultation';pAct('center-form')"); assert.equal(run('ptab'), 'consultation', 'center form should stay in the patient consultation section');
    assert.equal(ctx.__title, 'ទម្រង់មណ្ឌល');
    let centerHtml = ctx.__body;
    for (const field of ['center_date_0', 'center_register_no_0', 'center_name_0', 'center_identity_0', 'center_age_0', 'center_sex_0', 'center_group_0', 'center_district_0', 'center_address_0', 'center_symptoms_0', 'center_examination_0', 'center_vaccine_0', 'center_contraception_0', 'center_imci_0', 'center_weight_height_0', 'center_weight_head_0', 'center_other_problem_0', 'center_referral_0', 'center_notes_0']) assert.ok(centerHtml.includes(`name="${field}"`), 'center form missing ' + field);
    assert.ok(centerHtml.includes('ថ្ងៃខែ') && centerHtml.includes('IMCI') && centerHtml.includes('ទម្ងន់/កម្ពស់') && centerHtml.includes('data-a="centeraddrow"') && centerHtml.includes('center-form-scroll'), 'center form should match the screenshots and keep the complete table horizontally scrollable');
    const centerCss = fs.readFileSync(path.join(frontendDir, 'styles.css'), 'utf8');
    assert.match(centerCss, /#md \.center-checks \.cb\s*\{[^}]*display:\s*grid;/s, 'center checkbox labels should override the modal label display');
    assert.match(centerCss, /#md \.center-checks \.cb input\s*\{[^}]*width:\s*auto;/s, 'center checkboxes should override the modal full-width input style');
    assert.match(centerCss, /\.center-form-table\s*\{[^}]*font-size:\s*14px;/s, 'center form text should be larger');
    assert.match(centerCss, /#md \.center-checks \.cb\s*\{[^}]*font-size:\s*13px;/s, 'center checkbox text should be larger');
    assert.match(centerCss, /\.center-print-table\s*\{[^}]*table-layout:\s*fixed;/s, 'center form print should use the fixed register table layout');
    assert.match(centerCss, /\.center-print-table th,\s*\.center-print-table td\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/s, 'center form print text should wrap within each column');
    assert.match(centerCss, /\.center-print-table th,\s*\.center-print-table td\s*\{[^}]*border:\s*0\.3mm solid #2563eb;[^}]*background:\s*#fff;[^}]*color:\s*#2563eb;/s, 'center print cells should use a consistent stronger blue border and blue text on white');
    assert.match(centerCss, /\.center-print-table \.center-print-option span\s*\{[^}]*width:\s*20mm;[^}]*overflow:\s*hidden;[^}]*font-size:\s*5pt;[^}]*transform:\s*translate\(-50%, -50%\) rotate\(-90deg\);/s, 'rotated register option labels should stay inside their narrow columns');
    run("pAct('centeraddrow')"); assert.equal(els['#mf'].dataset.centerRowCount, '2');
    run("pAct('centerremoverow','1')"); assert.equal(els['#mf'].dataset.centerRowCount, '1');
    els['#mf'].__m = { center_date_0: '2026-10-23', center_name_0: 'Test Patient', center_age_0: ['១ - ៤ឆ្នាំ'], center_sex_0: ['ស្រី'], center_imci_0: '1', center_weight_height_0: '12kg / 85cm' };
    await run('__save($("#mf"))');
    const centerRecord = run(`recs.find(r=>r.kind=="consultation"&&JSON.parse(r.data).consultation_mode=="center")`), centerData = run(`JSON.parse(recs.find(r=>r.kind=="consultation"&&JSON.parse(r.data).consultation_mode=="center").data)`);
    assert.ok(centerRecord && centerData.rows[0].name == 'Test Patient' && centerData.rows[0].age.includes('១ - ៤ឆ្នាំ') && centerData.rows[0].imci && centerData.rows[0].weight_height == '12kg / 85cm', 'center form should save text, checkboxes, and IMCI');
    run('printDoc=function(t,h,o){__centerPrint=[t,h,o]}'); run(`pAct('centerprint-record','${centerRecord.id}')`);
    assert.equal(ctx.__centerPrint[0], '');
    assert.ok(ctx.__centerPrint[1].includes('center-print-table') && ctx.__centerPrint[1].includes('Test Patient') && ctx.__centerPrint[1].includes('១ - ៤ឆ្នាំ') && ctx.__centerPrint[1].includes('12kg / 85cm') && ctx.__centerPrint[1].includes('A4 landscape') && ctx.__centerPrint[1].includes('rowspan="2"') && ctx.__centerPrint[1].includes('✓'), 'center form print should use the landscape register layout and include saved row details');
    assert.ok(ctx.__centerPrint[2].headerHtml.includes('center-print-header') && ctx.__centerPrint[2].headerHtml.includes('ទម្រង់មណ្ឌល'), 'center form print should use the clinic register letterhead');
    run(`pAct('redit','${centerRecord.id}')`); assert.equal(ctx.__title, 'ទម្រង់មណ្ឌល'); assert.ok(ctx.__body.includes('value="Test Patient"') && ctx.__body.includes('value="12kg / 85cm"'), 'editing a center form should restore its saved row');
    assert.ok(run('recCard(recs.find(r=>r.id==' + centerRecord.id + '))').includes(`data-a="centerprint-record:${centerRecord.id}"`), 'saved center records should provide a print action');
    run("ptab='consultation';pAct('radd')"); assert.equal(ctx.__title, 'ជ្រើសរើសទម្រង់ពិគ្រោះ', 'Add shortcut should open consultation form choices');
    ok('Consultation toolbar opens, edits, prints, and saves the horizontally scrollable center form');
    run(`cnfForm(recs.find(r=>r.kind=="cnf"))`); assert.ok(/value="Teacher"/.test(ctx.__body) && /value="Acne"\s+checked/.test(ctx.__body) && ctx.__body.includes('Edited wording') && ctx.__body.includes('Discussed expectations') && /value="Telegram"\s+checked/.test(ctx.__body) && ctx.__body.includes('data-a="cnfload:')); ok('saved CNF re-opens pre-filled and appears in Form History');
    const cp = run(`cnPrintHtml(JSON.parse(recs.find(r=>r.kind=="cnf").data))`); assert.ok(cp.includes('Acne, Wrinkles') && cp.includes('freckles') && cp.includes('Edited wording') && cp.includes('Acne vulgaris') && cp.includes('Personal Interview') && cp.includes('Telegram, Facebook') && cp.includes('Assessment')); ok('CNF printout contains the answers and assessment');
    run('lang="km"; cnfForm()'); assert.ok(ctx.__title.includes('ទម្រង់ពិគ្រោះគ្លីនិក') && ctx.__body.includes('consultation-form-scroll') && ctx.__body.includes('មុខរបរ (Occupation)') && ctx.__body.includes('១. បញ្ហា និងកង្វល់ (1. Problems & Concerns)') && ctx.__body.includes('មុន (Acne)') && ctx.__body.includes('value="Acne"') && ctx.__body.includes('ខ្ញុំយល់ព្រម និងទទួលយកផែនការព្យាបាល')); assert.ok(ctx.__body.includes('General Form') && ctx.__body.includes('Form History') && ctx.__body.includes('បាទ/ចាស') && !ctx.__body.includes('បាទ/ចាស (Yes)') && ctx.__body.includes('ផលិតផលដែលកំពុងប្រើ (7. Current products)') && !ctx.__body.includes('ហ្វូមលាងមុខ (Cleanser)')); const kmPrint = run(`cnPrintHtml({prob:["Acne"],react:["None"],ag_acc:cnfTexts().acc})`); assert.ok(kmPrint.includes('មុន (Acne)') && kmPrint.includes('៣. តើអ្នកធ្លាប់មានប្រតិកម្មចំពោះចំណុចណាមួយខាងក្រោមនេះដែរឬទេ? (History of Reactions)') && kmPrint.includes('ការវាយតម្លៃ និងផែនការ (Assessment & Plan)') && kmPrint.includes('ការយល់ព្រម និងលទ្ធផល (Acceptance & Results)')); ok('CNF General Form matches screenshot Khmer/bilingual labels and choices, while keeping English tabs and stored values'); run('lang="en"');
    run('D.clinic.cnf_text=JSON.stringify({pay:"Pay at the desk",acc:"Custom English",acc_km:"ខ្លឹមសារផ្ទាល់ខ្លួន"})'); assert.equal(run('cnfTexts().pay'), 'Pay at the desk'); assert.equal(run('cnfTexts().acc'), 'Custom English'); run('lang="km"'); assert.equal(run('cnfTexts().acc'), 'ខ្លឹមសារផ្ទាល់ខ្លួន'); assert.equal(run('cnfTexts().pay'), 'Pay at the desk'); run('lang="en"; cnfForm()'); assert.ok(ctx.__body.includes('Pay at the desk')); ok('English and Khmer agreement wording is independently configurable with legacy-text fallback');
    html = run('R.set()'); assert.ok(html.includes('clinic-settings-page') && html.includes('clinic-settings-assets') && html.includes('pv_banner') && html.includes('clinic-settings-toggles') && html.includes('clinic-settings-fields') && html.includes('name="print_header"') && html.includes('name="print_footer"') && html.includes('data-a="go:dr"') && html.includes('data-a="pwd"') && html.includes('data-a="saveclinic"'), 'Clinic Settings should follow the screenshot groups and retain existing setting actions');
    assert.ok(html.includes('Consultation form agreement text') && html.includes('name="cnf_acc"') && html.includes('name="cnf_acc_km"') && html.includes('name="cnf_pay"') && html.includes('name="cnf_pay_km"')); ok('Clinic Settings has screenshot layout and editable English/Khmer agreement text');
    run(`D.clinic.banner='clinic-banner.jpg';printDoc=__nativePrintDoc;printDoc('Header test','body')`);
    assert.ok(els['#pa'].innerHTML.includes(`${run('API_BASE')}/uploads/clinic-banner.jpg`), 'generic print header should load the clinic banner from the configured API host');
    run("D.clinic.banner=''");
    run(`D.clinic.print_header='<b>Custom heading</b>';D.clinic.print_footer='Custom footer';printDoc('Test print','<p>Report content</p>')`);
    assert.ok(els['#pa'].innerHTML.includes('class="print-config-header">&lt;b&gt;Custom heading&lt;/b&gt;') && els['#pa'].innerHTML.includes('class="print-config-footer">Custom footer</footer>') && els['#pa'].innerHTML.includes('Report content'), 'shared custom header and footer should render safely in generic print documents and reports');
    run(`D.clinic.print_header='';D.clinic.print_footer=''`);
    run('printDoc=function(t,h){}'); run('ptab="medical"');

    // ---- Dashboard links ----
    await run(`api('POST','symptoms',{name:'cough'})`); await run('load()'); run('rt="dash"'); html = run('R.dash()');
    for (const [label, act] of [['Total patients', 'go:pt'], ['Appointments today', 'dashap'], ['Daily revenue', 'go:bill'], ['Admitted patients', 'go:cur'], ['Total Appointments', 'go:ap']]) assert.ok(new RegExp(`data-a="${act}" tabindex="0" role="link"><b[^>]*>${label}<`).test(html), 'dashboard card not linked: ' + label);
    assert.ok(html.includes('data-a="go:an"') && html.includes('data-a="go:da"')); ok('every dashboard card links to its page (Patients, Appointments, Report, Current IPD, Analytics, Doctor Analytics)');
    for (const [act, route] of [['go:pt', 'pt'], ['go:bill', 'bill'], ['go:cur', 'cur'], ['go:ap', 'ap'], ['go:an', 'an'], ['go:da', 'da']]) { const [a, x] = act.split(':'); run(`rt="dash"; rt="${x}"`); const page = run('(R[rt]||(()=>tp(rt)))()'); assert.ok(typeof page == 'string' && page.length > 50, 'page does not render: ' + route); }
    ok('each linked page renders');
    run('rt="dash"; pAct("dashap")'); assert.equal(run('rt'), 'ap'); assert.equal(run('cal.mode'), 'day'); assert.ok(run('R.ap()').includes('Test Patient')); ok('Appointments-today card opens the calendar on today');
    assert.ok(/Common complaints[\s\S]*cough[\s\S]*?>1</.test(run('R.dash()'))); ok('common complaints chart counts real patient complaints');
    ctx.__d = { dfrom: '2030-01-01', dto: '' }; run('rt="dash"; dFrom="2030-01-01"'); assert.ok(!/Patients by address[\s\S]*?Phnom Penh/.test(run('R.dash()'))); run('dFrom=""'); assert.ok(run('R.dash()').includes('Phnom Penh')); ok('date filter narrows the dashboard charts');

    // Excel export
    await run("api('POST','medicines',{name:'=SUM(1,1)',price:500,stock:5})"); await run('load()');
    run('rt="sv"'); await run('exportExcel()'); let exportedBook = new ExcelJS.Workbook(); await exportedBook.xlsx.load(Buffer.from(downloads.blob.p[0]));
    let exportedSheet = exportedBook.worksheets[0], exportedHeaders = exportedSheet.getRow(1).values.slice(1);
    assert.ok(downloads[downloads.length - 1].download.endsWith('.xlsx') && exportedHeaders.includes('description'));
    const descCol = exportedHeaders.indexOf('description') + 1, exportedServiceRow = Array.from({ length: exportedSheet.rowCount - 1 }, (_, i) => exportedSheet.getRow(i + 2)).find(r => r.getCell(1).value == 'Facial care');
    assert.ok(exportedServiceRow && exportedServiceRow.getCell(descCol).value == 'Updated service description'); ok('Excel export downloads a real .xlsx workbook with the service Description column');
    run('rt="med"'); await run('exportExcel()'); exportedBook = new ExcelJS.Workbook(); await exportedBook.xlsx.load(Buffer.from(downloads.blob.p[0]));
    exportedSheet = exportedBook.worksheets[0]; exportedHeaders = exportedSheet.getRow(1).values.slice(1);
    assert.deepEqual(exportedHeaders, ['id', 'name', 'type', 'price', 'stock', 'sold', 'damaged', 'last_stock_date', 'last_stock', 'expiry_date', 'reminder_date', 'units', 'image_url', 'composition']);
    const exportedMedicineRow = Array.from({ length: exportedSheet.rowCount - 1 }, (_, i) => exportedSheet.getRow(i + 2)).find(r => r.getCell(2).value == 'Amoxicillin');
    assert.ok(exportedMedicineRow); assert.equal(exportedMedicineRow.getCell(10).value, '2027-06-30'); assert.equal(exportedMedicineRow.getCell(11).value, '2027-05-30'); assert.equal(exportedMedicineRow.getCell(14).value, '500mg capsule');
    const formulaRow = Array.from({ length: exportedSheet.rowCount - 1 }, (_, i) => exportedSheet.getRow(i + 2)).find(r => r.getCell(2).value == "'=SUM(1,1)");
    assert.ok(formulaRow); ok('Excel cells that start with formula characters are neutralised');
    const posMedicine = run(`D.med.find(m=>m.name=='Amoxicillin')`);
    assert.ok(posMedicine, 'POS print test requires the seeded Amoxicillin medicine');
    run(`cart={['${posMedicine.id}']:2};rt='pos';printDoc=function(t,h,o){__posPrint=[t,h,o]}`);
    html = run('R.pos()');
    assert.ok(html.includes('data-a="posprint"') && html.includes('aria-label="Print total"'), 'POS total should include an accessible print icon');
    assert.ok(/class="pos-checkout-actions"><button[^>]*data-a="co"[^>]*>Checkout<\/button><button[^>]*data-a="posprint"/.test(html), 'POS print icon should appear beside Checkout');
    listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'posprint' } }) }, preventDefault() {} });
    const posPrinted = run('__posPrint'), posTotal = Number(run(`D.med.find(m=>m.id==${posMedicine.id}).price*2`)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    assert.equal(posPrinted[0], ''); assert.ok(posPrinted[1].includes('Amoxicillin') && posPrinted[1].includes('>2</td>') && posPrinted[1].includes('KHR ' + posTotal));
    assert.ok(posPrinted[1].includes('Invoice #: PREVIEW') && posPrinted[1].includes('សរុបរង:') && posPrinted[1].includes('សរុប:') && posPrinted[1].includes('Thank You For Your Business'));
    assert.ok(posPrinted[2].headerHtml.includes('វិក័យប័ត្រ'), 'POS print should use the invoice header layout');
    let printCalls = 0; ctx.window.print = () => { printCalls++; };
    ctx.__nativePrintDoc('', posPrinted[1], { headerHtml: posPrinted[2].headerHtml, printImmediately: true });
    assert.ok(els['#pa'].innerHTML.includes('Invoice #: PREVIEW') && els['#pa'].innerHTML.includes('Amoxicillin') && printCalls == 1, 'POS invoice should be populated before synchronously opening print');
    run('cart={};rt="med";printDoc=__nativePrintDoc'); ok('POS total print icon prints current cart items and total');
    const realFetch = ctx.fetch;
    ctx.fetch = async () => ({ status: 404, ok: false, json: async () => ({ error: 'Not found' }) });
    await run('exportExcel()');
    assert.match(run('__toast'), /Excel export API not found.*Restart the backend server/);
    ctx.fetch = realFetch; ok('missing export route tells the user to restart the backend');

    // patient name is clickable in the list; calendar adds an appointment through the modal
    run('rt="pt"'); assert.ok(run('R.pt()').includes('data-a="open:') && run('R.pt()').includes('data-a="reg"')); ok('patient list opens patient file and registration form');
    html = run('R.pt()'); assert.ok(html.includes(`data-a="ptbed:${p.id}"`), 'patient row is missing the bed information button');
    await run(`api('POST','ipd',{name:'Test Patient',code:'${p.id}',room:'',paid:0,out:0})`); await run('load()');
    const ipdId = run(`D.ipd.find(x=>x.code=='${p.id}').id`), ipdHtml = run(`ipdRow(D.ipd.find(x=>x.code=='${p.id}'))`);
    assert.ok(ipdHtml.includes(`data-a="ipdbill:${p.id}"`), 'Paid status should open billing history');
    assert.ok(ipdHtml.includes(`data-a="ipdtreat:${ipdId}"`), 'IPD treatment should open treatment follow-up');
    run('openForm=__nativeOpenForm');
    await run(`ipdTreat(${ipdId})`);
    assert.ok(els['#mf'].innerHTML.includes('Treatment Follow-up') && els['#mf'].innerHTML.includes('Date / Vital Signs') && els['#mf'].innerHTML.includes('Diagnosis / Evolution'), 'IPD treatment should use the follow-up interface');
    ok('IPD treatment action opens the Treatment Follow-up interface');
    await run(`(async()=>{pAct('ipdbill','${p.id}');await new Promise(r=>setTimeout(r,100))})()`);
    const billingModal = els['#mf'].innerHTML;
    assert.ok(billingModal.includes('Test Patient') && billingModal.includes('Billing history') && billingModal.includes('No unpaid bills found.') && billingModal.includes('Paid History') && billingModal.includes('bill-payment-table') && billingModal.includes('data-a="paidview"') && billingModal.includes('Total Paid') && billingModal.includes(`data-a="payreceipt:${paidId}"`));
    run(`pAct('payreceipt','${paidId}')`);
    assert.equal(ctx.__pd[0], ''); assert.ok(ctx.__pd[1].includes('DETAILED INVOICE') && ctx.__pd[1].includes('KHR 80,000'));
    ok('clicking Paid in IPD opens the billing-history modal with payment receipt actions');
    run('rt="pt"');
    run('openForm=__nativeOpenForm'); run(`pAct('ptbed','${p.id}')`); const bedModal = els['#mf'].innerHTML;
    assert.ok(bedModal.includes('Update Bed Information') && bedModal.includes('Room Number') && bedModal.includes('Bed Number'));
    els['#mf'].__m = { room: 'A-01', bed: 'B-02' }; ctx.__event = { preventDefault() {} };
    await run(`$('#mf').onsubmit(__event)`); await run('load()');
    const savedIpd = run(`D.ipd.find(x=>x.code=='${p.id}')`);
    assert.equal(savedIpd.room, 'A-01'); assert.equal(savedIpd.bed, 'B-02');
    assert.ok(run("tp('ipd')").includes('A-01') && run("tp('ipd')").includes('B-02'));
    ok('patient bed update synchronizes the active IPD record and IPD list');
    console.log('\nAll UI tests passed.'); process.exitCode = 0;
  } catch (e) { console.error('\nFAILED:', e.stack || e.message); process.exitCode = 1; }
  server.close(async () => {
    try { await close(); } catch {}
    process.exit(process.exitCode);
  });
});
