'use strict';
// Small, dependency-free security helpers: constant-time compare, rate limiter, TOTP (RFC 6238) for
// authenticator-app 2FA, and strict headers for the HTML pages.
const crypto = require('crypto');

// Constant-time string compare (hashes first so lengths never leak).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// In-memory sliding-window limiter. hit(key) -> true while allowed, false once over the limit.
function makeLimiter({ windowMs, max }) {
  const m = new Map();
  const t = setInterval(() => { const now = Date.now(); for (const [k, v] of m) if (now > v.reset) m.delete(k); }, 60000);
  if (t.unref) t.unref();
  return {
    hit(key) {
      const now = Date.now();
      const v = m.get(key);
      if (!v || now > v.reset) { m.set(key, { n: 1, reset: now + windowMs }); return true; }
      v.n++;
      return v.n <= max;
    },
    reset(key) { m.delete(key); },
    // true once the key has already used up its allowance in the current window (does not count as a hit)
    over(key) { const v = m.get(key); return !!v && Date.now() <= v.reset && v.n >= max; },
  };
}

// ---- TOTP ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secretBuf, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1000000).padStart(6, '0');
}
function newTotpSecret() { return base32Encode(crypto.randomBytes(20)); }
function totpCode(secretB32, atMs) { return hotp(base32Decode(secretB32), Math.floor((atMs === undefined ? Date.now() : atMs) / 30000)); }
// Returns the matched time-step counter (so callers can refuse a replay of the same code), or null.
function verifyTotp(secretB32, code, opts) {
  const o = opts || {};
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const secret = base32Decode(secretB32);
  const nowStep = Math.floor((o.atMs === undefined ? Date.now() : o.atMs) / 30000);
  for (let d = -1; d <= 1; d++) {
    const step = nowStep + d;
    if (o.minCounter !== undefined && o.minCounter !== null && step <= Number(o.minCounter)) continue; // replay
    if (safeEqual(hotp(secret, step), c)) return step;
  }
  return null;
}
function otpauthUri(label, secret, issuer) {
  return 'otpauth://totp/' + encodeURIComponent(issuer + ':' + label) + '?secret=' + secret + '&issuer=' + encodeURIComponent(issuer) + '&digits=6&period=30';
}

// ---- headers for the HTML pages (login pages must never be framed, cached, or have injected base tags) ----
function pageHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  next();
}

module.exports = { safeEqual, makeLimiter, newTotpSecret, totpCode, verifyTotp, otpauthUri, base32Encode, base32Decode, pageHeaders };
