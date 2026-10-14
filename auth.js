'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const { queryOne, query } = require('./db');
const scrypt = promisify(crypto.scrypt);

let SECRET = (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32)
  ? process.env.JWT_SECRET
  : crypto.randomBytes(48).toString('hex');

async function initAuth() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) {
    SECRET = process.env.JWT_SECRET;
    return SECRET;
  }
  try {
    const r = await queryOne("SELECT value FROM settings WHERE key='secret'");
    if (r && r.value) {
      SECRET = r.value;
      return SECRET;
    }
    const v = crypto.randomBytes(48).toString('hex');
    await query("INSERT INTO settings(key,value) VALUES('secret',$1) ON CONFLICT (key) DO NOTHING", [v]);
    const finalRow = await queryOne("SELECT value FROM settings WHERE key='secret'");
    SECRET = (finalRow && finalRow.value) || v;
    return SECRET;
  } catch {
    return SECRET;
  }
}

const TTL = 12 * 3600; // token lifetime in seconds

async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + (await scrypt(pw, salt, 64)).toString('hex');
}
async function checkPw(pw, stored) {
  const [s, k] = stored.split(':');
  const key = await scrypt(pw, Buffer.from(s, 'hex'), 64);
  const a = Buffer.from(k, 'hex');
  return a.length === key.length && crypto.timingSafeEqual(a, key);
}
const mac = (b) => crypto.createHmac('sha256', SECRET).update(b).digest();
function sign(p) {
  const body = Buffer.from(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + TTL })).toString('base64url');
  return body + '.' + mac(body).toString('base64url');
}
function verify(t) {
  if (typeof t !== 'string') return null;
  const [b, s] = t.split('.');
  if (!b || !s) return null;
  const g = Buffer.from(s, 'base64url'), e = mac(b);
  if (g.length !== e.length || !crypto.timingSafeEqual(g, e)) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}
module.exports = { hashPw, checkPw, sign, verify, initAuth };
