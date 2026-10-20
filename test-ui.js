'use strict';
// UI logic test: runs the real frontend scripts (app.js + patient.js) in a simulated browser against a live server.
const os = require('os'), path = require('path'), fs = require('fs'), vm = require('vm'), assert = require('assert');
process.env.NODE_ENV = 'test';
process.env.USE_MEM_DB = 'true';
process.env.JWT_SECRET = 'y'.repeat(40);
const { server } = require('./server');
const { close } = require('./db');

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const ok = (n) => console.log('  ✓', n);
  const el = () => new Proxy({ dataset: { mode: 'manual' }, classList: { add() {}, remove() {}, toggle() {} }, style: {}, value: '', hidden: false, innerHTML: '', textContent: '', insertAdjacentHTML() {}, querySelector: () => el(), querySelectorAll: () => [] }, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  const els = {}; const downloads = [];
  const ctx = vm.createContext({
    console, URL, setTimeout, clearTimeout, Promise, Intl, Date,
    document: { querySelector: (s) => (els[s] = els[s] || el()), querySelectorAll: () => [], addEventListener() {}, createElement: () => ({ click() { downloads.push(this); }, style: {} }), createTreeWalker: () => ({ nextNode: () => false }), body: { querySelectorAll: () => [] }, documentElement: { dataset: {}, lang: 'en' } },
    window: { print() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, MutationObserver: class { observe() {} }, NodeFilter: { SHOW_TEXT: 4 },
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
  try {
    await (await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.cc', password: 'password123' }) })).json();
    run(`tok=null`); const lg = await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.cc', password: 'password123' }) })).json();
    ctx.__t = lg.token; run('tok=__t; toast=function(m){__toast=m}'); await run('load()'); ok('app loads data from the API');

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
    let html = run('R.pd()'); for (const must of ['Test Patient', 'Vital signs', 'Medical Record', 'MD History', 'BEU', 'Treatment Schedule', 'Consultation', 'Operation', 'Homecare', 'NSSF ID', 'National ID', 'id="pdd"']) assert.ok(html.includes(must), 'patient file missing ' + must);
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
    run('schForm()'); ctx.__f = { __m: { date: '2026-10-14', amount: '50000', dx: 'Acne', notes: 'Peel session 1', done: null } }; await run('__save(__f)');
    ctx.__f = { __m: { date: '2026-10-21', amount: '30000', dx: 'Acne', notes: 'Peel session 2', done: '1' } }; run('schForm()'); await run('__save(__f)');
    assert.equal(run('schRows().length'), 2); assert.equal(run('schTotal()'), 80000); assert.equal(run(`patientDue(${p.id})`), 80000);
    assert.ok(run(`ipdRow({code:'${p.id}',name:'Test Patient',adm:'2026-10-14'})`).includes(`data-a="ptpay:${p.id}"`));
    html = run('recPanel()'); assert.ok(html.includes('Peel session 1') && html.includes('80,000')); ok('schedule charges calculate the patient balance used by IPD billing status');
    const rid = run('schRows()[0].id'); run(`pAct('schdone','${rid}')`); await new Promise((r) => setTimeout(r, 300)); assert.equal(JSON.parse(run('schRows()[0]').data).done, 1); ok('Done tick can be toggled');
    await run(`api('POST','records',{patient_id:pdId,kind:'schedulenote',title:'Treatment2'})`); await run('loadRecs()'); assert.ok(run('schNames()').includes('Treatment2')); run('sch="Treatment2"'); assert.equal(run('schRows().length'), 0); assert.ok(run('recPanel()').includes('Treatment2')); ok('a second schedule (Treatment2) is a separate tab with its own rows');
    run('sch="Standard"'); ctx.__x = null; run('document.querySelector("#schnote").value="Header for print"'); await run(`(async()=>{pAct('schnotesave');await new Promise(r=>setTimeout(r,300))})()`); assert.equal(run('schNote().notes'), 'Header for print'); ok('schedule header note saved');
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

    // ---- Consultation Form (CNF) ----
    run('cnfForm()'); for (const must of ['General Form', 'Assessment &amp; Plan', 'Form History', '1. Problems &amp; Concerns', 'Acne scars', '2. Skin type', '3. History of reactions', 'Product usage history', 'Medicine usage', 'Treatment history', 'Personal &amp; family history', 'Lifestyle', 'For women', 'Treatment Agreement', 'Acceptance &amp; Results', 'Guarantee of Care', 'Privacy Notice', 'Photo Consent', 'Responsibility', 'Other Notices', 'Payment Policy', 'Customer understanding', 'Warnings &amp; conditions', 'Personal interview', 'Customer name', 'Test Patient', 'No history records yet', 'Occupation', 'Address override']) assert.ok(ctx.__body.replace(/&amp;/g, '&amp;').includes(must) || ctx.__body.includes(must.replace('&amp;', '&')), 'CNF form missing ' + must);
    assert.ok(ctx.__opts.extra.includes('Print Current') && ctx.__opts.ok == 'Save Only'); ok('Consultation Form has every section, Form History and Print Current / Save Only');
    ctx.__f = { __m: { cn_occ: 'Teacher', cnc_prob: ['Acne', 'Wrinkles'], cn_prob_o: 'freckles', cnc_skin: ['Oily'], cnc_react: ['None'], cnc_accept: ['Can accept'], cnc_und: ['Received and understood well'], cn_und_t: 'Understood', cn_as_dx: 'Acne vulgaris', cn_as_plan: 'Peel x6', cn_as_fu: '2026-11-01', cn_ag_acc: 'Edited wording' } };
    await run('__save(__f)'); const cn = run('recs.find(r=>r.kind=="cnf")'); const cd = JSON.parse(cn.data); assert.deepEqual(cd.prob, ['Acne', 'Wrinkles']); assert.equal(cd.prob_o, 'freckles'); assert.equal(cd.as_dx, 'Acne vulgaris'); assert.equal(cd.ag_acc, 'Edited wording'); ok('CNF answers, agreement text and assessment saved together');
    run(`cnfForm(recs.find(r=>r.kind=="cnf"))`); assert.ok(/value="Teacher"/.test(ctx.__body) && /value="Acne"\s+checked/.test(ctx.__body) && ctx.__body.includes('Edited wording') && ctx.__body.includes('Acne vulgaris') && ctx.__body.includes('data-a="cnfload:')); ok('saved CNF re-opens pre-filled and appears in Form History');
    const cp = run(`cnPrintHtml(JSON.parse(recs.find(r=>r.kind=="cnf").data))`); assert.ok(cp.includes('Acne, Wrinkles') && cp.includes('freckles') && cp.includes('Edited wording') && cp.includes('Acne vulgaris') && cp.includes('Assessment')); ok('CNF printout contains the answers and assessment');
    run('D.clinic.cnf_text=JSON.stringify({pay:"Pay at the desk"})'); assert.equal(run('cnfTexts().pay'), 'Pay at the desk'); assert.ok(run('cnfTexts().acc').length > 20); run('cnfForm()'); assert.ok(ctx.__body.includes('Pay at the desk')); ok('agreement wording comes from Clinic Settings (defaults for anything not set)');
    html = run('R.set()'); assert.ok(html.includes('Consultation form agreement text') && html.includes('name="cnf_acc"') && html.includes('name="cnf_pay"')); ok('Clinic Settings can edit the agreement wording');
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

    // CSV export
    await run("api('POST','medicines',{name:'=SUM(1,1)',price:500,stock:5})"); await run('load()');
    run('rt="med"'); run('exportCsv()'); const csv = downloads.blob.p[0]; assert.ok(csv.includes('name') && csv.startsWith('\ufeff') && csv.includes('SUM')); ok('CSV export builds a file'); assert.ok(!csv.includes('"=SUM') && csv.includes("\"'=SUM(1,1)\"")); ok('CSV cells that start with = + - @ are neutralised (Excel formula injection)');

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
