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
  const els = {}; const downloads = []; const listeners = {};
  const sessionValues = {};
  const ctx = vm.createContext({
    console, URL, setTimeout, clearTimeout, Promise, Intl, Date,
    document: { querySelector: (s) => (els[s] = els[s] || el()), querySelectorAll: () => [], addEventListener: (type, fn) => (listeners[type] = [...(listeners[type] || []), fn]), createElement: () => ({ click() { downloads.push(this); }, style: {} }), createTreeWalker: () => ({ nextNode: () => false }), body: { querySelectorAll: () => [] }, documentElement: { dataset: {}, lang: 'en' } },
    window: { print() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: (key) => sessionValues[key] || null, setItem: (key, value) => { sessionValues[key] = String(value); }, removeItem: (key) => { delete sessionValues[key]; } }, MutationObserver: class { observe() {} }, NodeFilter: { SHOW_TEXT: 4 },
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
    for (const page of ['ap', 'ipd', 'cur', 'med', 'set']) {
      listeners.click[0]({ target: { closest: () => ({ dataset: { a: 'go:' + page } }) }, preventDefault() {} });
      assert.equal(sessionValues.currentPage, page);
      run(`rt='dash';restorePage()`);
      assert.equal(run('rt'), page);
    }
    run(`rt='dash';pAct('dashap')`);
    assert.equal(sessionValues.currentPage, 'ap', 'dashboard appointment shortcut should persist the appointments page');
    for (const page of ['ap', 'ipd', 'cur']) {
      sessionValues.currentPage = page;
      run(`rt='dash';restorePage()`);
      assert.equal(run('rt'), page, `${page} must be accepted as a valid saved route despite using the generic table renderer`);
    }
    run(`cal.mode='month';rt='dash'`);
    sessionValues.currentPage = 'unknown'; run(`rt='dash';restorePage()`); assert.equal(run('rt'), 'dash');
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
    let html = run('R.pd()'); for (const must of ['Test Patient', 'Vital signs', 'Medical Record', 'MD History', 'BEU', 'Treatment Schedule', 'Consultation', 'Operation', 'Homecare', 'Allergy History', 'Vaccination', 'Referral', 'Diagnosis History', 'Lab Orders', 'Imaging Orders', 'NSSF ID', 'National ID', 'id="pdd"']) assert.ok(html.includes(must), 'patient file missing ' + must);
    assert.equal(run('PT.length'), 23, 'Patient Management should show exactly 23 sections');
    ok('patient file displays all 23 Patient Management sections');
    assert.ok(html.includes('37.2') && html.includes('110/70'), 'vitals entered at registration should show'); ok('patient file shows header, menu and the vital signs entered at registration');

    // vital signs
    run('vsForm()'); ctx.__f = { __m: { v_t: '38.1', v_hr: '90', date: '2026-10-14T09:00' } }; await run('__save(__f)'); assert.equal(run('recs.filter(r=>r.kind=="vitals").length'), 2); ok('vital signs added');

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
    run('openForm=function(t,b,s,o){__body=b;__save=s;__opts=o}');

    const newPatientModules = [
      ['allergy', { allergen: 'Penicillin', reaction: 'Rash', severity: 'Severe', status: 'Active', date: '2026-10-14', notes: 'Avoid penicillin' }, 'Penicillin'],
      ['vaccination', { vaccine: 'Influenza', dose: 'Annual', lot: 'LOT-88', next_due: '2027-10-14', date: '2026-10-14', notes: 'No reaction' }, 'Influenza'],
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
    assert.ok(!run('mrPrintHtml({head:"HEADTEXT",cc:"CCTEXT"})').includes('HEADTEXT') && run('mrPrintHtml({head:"HEADTEXT",cc:"CCTEXT"})').includes('CCTEXT')); ok('hidden sections are left out of the printout');
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
    assert.ok(els['#mf'].innerHTML.includes('Record payment') && /name="amount"[^>]*readonly/.test(els['#mf'].innerHTML) && els['#mf'].innerHTML.includes('name="method"'));
    els['#mf'].__m = { amount: '80000', method: 'Bank' }; await run('$("#mf").onsubmit({preventDefault(){}})');
    assert.equal(run('billTotals(recs).bal'), 0); assert.equal(run('jd(recs.find(r=>r.kind=="payment")).method'), 'Bank');
    html = run('billPanel()'); const paidId = run('recs.find(r=>r.kind=="payment").id');
    assert.ok(html.includes('KHR 80,000') && /data-a="payall" disabled/.test(html) && /data-a="recpay" disabled/.test(html));
    assert.ok(html.includes(`data-a="payreceipt:${paidId}"`)); run(`pAct('payreceipt','${paidId}')`);
    assert.equal(ctx.__pd[0], 'Payment Receipt'); assert.ok(ctx.__pd[1].includes('Test Patient') && ctx.__pd[1].includes('PAY-' + paidId) && ctx.__pd[1].includes('Bank') && ctx.__pd[1].includes('KHR 80,000'));
    ok('paid billing history can print payment receipts; payment actions are disabled when no balance remains');
    run('openForm=function(t,b,s,o){__body=b;__save=s;__opts=o;__title=t}');

    // ---- Medicines list and Add Medicine form ----
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
    assert.ok(medicineHtml.includes('data-a="medqrbulk"') && medicineHtml.includes('data-a="medbarcodebulk"'), 'medicine page should expose bulk code exports outside row actions');
    assert.ok(!medicineHtml.includes('medqrdownload') && !medicineHtml.includes('medbarcodedownload'), 'bulk code exports should not be in row actions');
    assert.ok(medicineHtml.includes('500mg capsule') && medicineHtml.includes('Tablet:') && medicineHtml.includes('2027-06-30') && medicineHtml.includes(`data-a="mededit:${medicineIndex}"`));
    run(`viewMedicineComposition(${medicineIndex})`); assert.ok(els['#mf'].innerHTML.includes('500mg capsule') && !els['#mf'].innerHTML.includes('<textarea'));
    run(`updateMedicineStock(${medicineIndex})`); assert.ok(els['#mf'].innerHTML.includes('Update Stock') && els['#mf'].innerHTML.includes('value="30"'));
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

    // ---- Consultation Form (CNF) ----
    run('cnfForm()'); for (const must of ['General Form', 'Assessment &amp; Plan', 'Form History', '1. Problems &amp; Concerns', 'Acne scars', '2. Skin type', '3. History of reactions', 'Product usage history', 'Medicine usage', 'Treatment history', 'Personal &amp; family history', 'Lifestyle', 'For women', 'Treatment Agreement', 'Acceptance &amp; Results', 'Guarantee of Care', 'Privacy Notice', 'Photo Consent', 'Responsibility', 'Other Notices', 'Payment Policy', 'Customer understanding', 'Warnings &amp; conditions', 'Personal interview', 'Customer name', 'Test Patient', 'No history records yet', 'Occupation', 'Address override', 'Personal Interview', 'Doctor’s Assessment', 'Doctor’s Treatment Plan', 'Special Notes - Image 5', 'Have you visited our clinic before?', 'TikTok', 'Telegram', 'Facebook', 'Current address', 'Additional notes']) assert.ok(ctx.__body.replace(/&amp;/g, '&amp;').includes(must) || ctx.__body.includes(must.replace('&amp;', '&')), 'CNF form missing ' + must);
    assert.ok(ctx.__opts.extra.includes('Print Current') && ctx.__opts.ok == 'Save Only'); ok('Consultation Form has every section, Form History and Print Current / Save Only');
    ctx.__f = { __m: { cn_occ: 'Teacher', cnc_prob: ['Acne', 'Wrinkles'], cn_prob_o: 'freckles', cnc_skin: ['Oily'], cnc_react: ['None'], cnc_accept: ['Can accept'], cnc_und: ['Received and understood well'], cn_und_t: 'Understood', cn_as_interview: 'Discussed expectations', cn_as_ass: 'Acne vulgaris', cn_as_plan: 'Peel x6', cnc_as_previous: ['បាទ/ចាស'], cnc_as_source: ['Telegram', 'Facebook'], cn_as_reason: 'Acne treatment', cn_as_address: 'Phnom Penh', cn_as_note: 'Edited wording', cn_ag_acc: 'Edited wording' } };
    await run('__save(__f)'); const cn = run('recs.find(r=>r.kind=="cnf")'); const cd = JSON.parse(cn.data); assert.deepEqual(cd.prob, ['Acne', 'Wrinkles']); assert.equal(cd.prob_o, 'freckles'); assert.equal(cd.as_interview, 'Discussed expectations'); assert.equal(cd.as_ass, 'Acne vulgaris'); assert.equal(cd.as_plan, 'Peel x6'); assert.deepEqual(cd.as_previous, ['បាទ/ចាស']); assert.deepEqual(cd.as_source, ['Telegram', 'Facebook']); assert.equal(cd.as_note, 'Edited wording'); assert.equal(cd.ag_acc, 'Edited wording'); ok('CNF answers, agreement text and assessment saved together');
    run(`cnfForm(recs.find(r=>r.kind=="cnf"))`); assert.ok(/value="Teacher"/.test(ctx.__body) && /value="Acne"\s+checked/.test(ctx.__body) && ctx.__body.includes('Edited wording') && ctx.__body.includes('Discussed expectations') && /value="Telegram"\s+checked/.test(ctx.__body) && ctx.__body.includes('data-a="cnfload:')); ok('saved CNF re-opens pre-filled and appears in Form History');
    const cp = run(`cnPrintHtml(JSON.parse(recs.find(r=>r.kind=="cnf").data))`); assert.ok(cp.includes('Acne, Wrinkles') && cp.includes('freckles') && cp.includes('Edited wording') && cp.includes('Acne vulgaris') && cp.includes('Personal Interview') && cp.includes('Telegram, Facebook') && cp.includes('Assessment')); ok('CNF printout contains the answers and assessment');
    run('lang="km"; cnfForm()'); assert.ok(ctx.__body.includes('មុខរបរ (Occupation)') && ctx.__body.includes('១. បញ្ហា និងកង្វល់ (1. Problems & Concerns)') && ctx.__body.includes('មុន (Acne)') && ctx.__body.includes('value="Acne"') && ctx.__body.includes('ខ្ញុំយល់ព្រម និងទទួលយកផែនការព្យាបាល')); assert.ok(ctx.__body.includes('General Form') && ctx.__body.includes('Form History') && ctx.__body.includes('បាទ/ចាស') && !ctx.__body.includes('បាទ/ចាស (Yes)') && ctx.__body.includes('ផលិតផលដែលកំពុងប្រើ (7. Current products)') && !ctx.__body.includes('ហ្វូមលាងមុខ (Cleanser)')); const kmPrint = run(`cnPrintHtml({prob:["Acne"],react:["None"],ag_acc:cnfTexts().acc})`); assert.ok(kmPrint.includes('មុន (Acne)') && kmPrint.includes('៣. តើអ្នកធ្លាប់មានប្រតិកម្មចំពោះចំណុចណាមួយខាងក្រោមនេះដែរឬទេ? (History of Reactions)') && kmPrint.includes('ការវាយតម្លៃ និងផែនការ (Assessment & Plan)') && kmPrint.includes('ការយល់ព្រម និងលទ្ធផល (Acceptance & Results)')); ok('CNF General Form matches screenshot Khmer/bilingual labels and choices, while keeping English tabs and stored values'); run('lang="en"');
    run('D.clinic.cnf_text=JSON.stringify({pay:"Pay at the desk",acc:"Custom English",acc_km:"ខ្លឹមសារផ្ទាល់ខ្លួន"})'); assert.equal(run('cnfTexts().pay'), 'Pay at the desk'); assert.equal(run('cnfTexts().acc'), 'Custom English'); run('lang="km"'); assert.equal(run('cnfTexts().acc'), 'ខ្លឹមសារផ្ទាល់ខ្លួន'); assert.equal(run('cnfTexts().pay'), 'Pay at the desk'); run('lang="en"; cnfForm()'); assert.ok(ctx.__body.includes('Pay at the desk')); ok('English and Khmer agreement wording is independently configurable with legacy-text fallback');
    html = run('R.set()'); assert.ok(html.includes('Consultation form agreement text') && html.includes('name="cnf_acc"') && html.includes('name="cnf_acc_km"') && html.includes('name="cnf_pay"') && html.includes('name="cnf_pay_km"')); ok('Clinic Settings can edit agreement wording in English and Khmer');
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
    assert.ok(billingModal.includes('Test Patient') && billingModal.includes('Billing history') && billingModal.includes('No unpaid bills found.') && billingModal.includes('Paid History') && billingModal.includes(`data-a="payreceipt:${paidId}"`));
    run(`pAct('payreceipt','${paidId}')`);
    assert.equal(ctx.__pd[0], 'Payment Receipt'); assert.ok(ctx.__pd[1].includes('KHR 80,000'));
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
