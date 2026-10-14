'use strict';
const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* optional */ }
const { initDb, query, queryOne, close, tx } = require('./db');
const { hashPw } = require('./auth');

(async () => {
  await initDb();
  const ins = async (client, t, o) => {
    const keys = Object.keys(o);
    const cols = keys.map((k) => `"${k}"`).join(',');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
    return client.query(`INSERT INTO "${t}"(${cols}) VALUES(${placeholders})`, Object.values(o));
  };

  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && !(await queryOne('SELECT 1 FROM users LIMIT 1'))) {
    await query('INSERT INTO users(email,name,role,pass) VALUES($1,$2,$3,$4)',
      [process.env.ADMIN_EMAIL.toLowerCase(), 'Admin', 'admin', await hashPw(process.env.ADMIN_PASSWORD)]);
    console.log('Admin created:', process.env.ADMIN_EMAIL);
  }

  if ((await queryOne('SELECT 1 FROM patients LIMIT 1')) && !process.argv.includes('--force')) {
    console.log('Data already present; use --force to add sample data anyway.');
    await close();
    return;
  }

  const NM = ['Sok Dara', 'Chan Sreyneang', 'Vann Rithy', 'Keo Sophea', 'Lim Sokha', 'Heng Vuthy', 'Pich Srey', 'Seng Bunthoeun', 'Mao Channary', 'Ouk Samnang', 'Tep Vanna', 'Nguon Sreymom'];
  const AD = ['Phnom Penh', 'Siem Reap', 'Kandal', 'Takeo', 'Battambang'];
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);

  await tx(async (client) => {
    for (const [i, n] of NM.concat(NM).entries()) {
      await ins(client, 'patients', { name: n, age: 6 + (i * 7) % 68, sex: i % 2 ? 'F' : 'M', phone: '012 ' + (300000 + i * 1731), addr: AD[i % 5], type: i % 5 ? 'OPD' : 'IPD', unpaid: i % 4 === 0 ? 1 : 0 });
    }
    for (const [i, [n, s, st]] of [['Sok Dara', 'Consultation', 'Waiting'], ['Chan Sreyneang', 'Echo', 'Confirmed'], ['Keo Sophea', 'Lab', 'Confirmed']].entries()) {
      await ins(client, 'appointments', { name: n, svc: s, date: today, doc: 'Dr. Vanna', phone: '012 30' + i + '000', st });
    }
    for (const [name, code, room, paid, out] of [['Lim Sokha', 'P-0101', 'A-12', 1, 0], ['Heng Vuthy', 'P-0102', 'B-03', 0, 0], ['Pich Srey', 'P-0098', 'A-05', 1, 1]]) {
      await ins(client, 'ipd', { name, code, room, paid, out });
    }
    for (const [name, role, code, phone, av] of [['Dr. Vanna Chea', 'Doctor', 'D01', '010 000 001', 'Mon–Fri'], ['Dr. Rithy Sok', 'Doctor', 'D02', '010 000 002', 'Available'], ['Sreymom Lay', 'Nurse', 'N01', '010 000 003', 'Mon–Fri'], ['Dara Pen', 'Nurse', 'N02', '010 000 004', 'Available']]) {
      await ins(client, 'doctors', { name, role, code, phone, av });
    }
    for (const [name, price, stock] of [['ACEMUC', 1000, 2], ['Adipin 5mg', 2000, 27], ['Advil 400', 10000, 19], ['Albefix 200mg', 10000, 6], ['Amisol', 80000, 50], ['Amlodipine 5mg', 3000, 192], ['Amoxicillin 500mg', 5000, 10], ['Appetine', 8000, 0], ['Ascoril', 8000, 10], ['Azithromycin', 12000, 40], ['Paracetamol 500mg', 500, 300], ['Omeprazole 20mg', 2500, 80]]) {
      await ins(client, 'medicines', { name, price, stock });
    }
    for (const [name, price] of [['General consultation', 10000], ['Dressing', 15000], ['IV infusion', 20000], ['ECG', 30000]]) {
      await ins(client, 'services', { name, price });
    }
    for (const [name, price, cat] of [['Ab HBs', 20000, 'SEROLOGY'], ['AFP', 0, 'TUMOUR MARKER'], ['Albumin', 10000, 'BIOCHEMISTRY'], ['Alkaline Phosphatase', 10000, 'BIOCHEMISTRY'], ['Allergy Panel I', 260000, 'ALLERGY'], ['Amylase', 10000, 'BIOCHEMISTRY'], ['Urine analysis', 0, 'URINE ANALYSIS']]) {
      await ins(client, 'labs', { name, price, cat });
    }
    for (const name of ['Abdominal ultrasound', 'Acute appendicitis', 'Acute cystitis', 'Breast echography', 'Cholecystitis', 'Gall bladder stone', 'Kidney stone', 'Testicular ultrasound']) {
      await ins(client, 'echo', { name, price: 25000, font: 'Moul' });
    }
    for (const name of ['Acute cystitis', 'Acute gastroenteritis', 'Acute pharyngitis', 'Acute tonsillitis', 'Cellulitis', 'Dengue fever', 'DM II', 'HTN', 'Trauma']) {
      await ins(client, 'diagnoses', { name });
    }
    await ins(client, 'prescriptions', { name: 'Acute pharyngitis', meds: 'Amoxicillin 500mg, Paracetamol 500mg' });
    await ins(client, 'prescriptions', { name: 'HTN', meds: 'Amlodipine 5mg' });
    for (const name of ['ឈឺក្បាល', 'ក្អក', 'គ្រុនក្តៅ', 'ឈឺពោះ', 'ក្អួត', 'ចុកពោះ']) {
      await ins(client, 'symptoms', { name });
    }
    for (const name of ['Phnom Penh', 'Siem Reap']) {
      await ins(client, 'addresses', { name });
    }
  });

  console.log('Sample data loaded.');
  await close();
})().catch(async (err) => {
  console.error('Seed error:', err);
  await close();
  process.exit(1);
});
