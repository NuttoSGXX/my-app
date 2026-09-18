// Vercel serverless function: GET = read schedule, POST = edit (PIN checked on the server).
// Storage: any Redis exposing the Upstash REST API (Vercel Marketplace -> Upstash Redis).
const crypto = require('crypto');

const HASH = 'dm-schedule:days';
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const SLOT_KEYS = ['m', 'a', 'e'];
const MAX_TRIES = 10;      // wrong/any PIN attempts per IP...
const TRY_WINDOW = 900;    // ...per 15 minutes (a successful login resets the counter)

function cfg() {
  return {
    base: (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, ''),
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '',
    pin: process.env.ADMIN_PIN || ''
  };
}

async function redis(c, cmd) {
  const r = await fetch(c.base, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || 'redis_' + r.status);
  return j.result;
}

async function pipeline(c, cmds) {
  const r = await fetch(c.base + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  const j = await r.json();
  if (!r.ok || !Array.isArray(j)) throw new Error('redis_pipeline_' + r.status);
  return j;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseDays(raw) {
  const pairs = [];
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([raw[i], raw[i + 1]]);
  } else if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach((k) => pairs.push([k, raw[k]]));
  }
  const days = {};
  pairs.forEach(([date, val]) => {
    if (!DATE_RE.test(date)) return;
    try {
      const obj = typeof val === 'string' ? JSON.parse(val) : val;
      const entry = {};
      SLOT_KEYS.forEach((k) => {
        if (obj && typeof obj[k] === 'string') entry[k] = obj[k];
      });
      if (Object.keys(entry).length) days[date] = entry;
    } catch (e) { /* skip bad row */ }
  });
  return days;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const c = cfg();

  if (req.method === 'GET') {
    if (!c.base || !c.token) return res.status(500).json({ error: 'storage_not_configured' });
    try {
      const raw = await redis(c, ['HGETALL', HASH]);
      return res.status(200).json({ days: parseDays(raw) });
    } catch (e) {
      return res.status(502).json({ error: 'storage_error' });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Fail closed: no PIN configured on the server = nobody can edit.
  if (!c.base || !c.token || !c.pin) return res.status(500).json({ error: 'server_not_configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'bad_request' });

  try {
    const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();
    const rk = 'dm-schedule:try:' + ip;
    const pl = await pipeline(c, [['INCR', rk], ['EXPIRE', rk, TRY_WINDOW]]);
    const count = Number(pl[0] && pl[0].result) || 0;
    if (count > MAX_TRIES) return res.status(429).json({ error: 'too_many_attempts' });

    if (!safeEqual(body.pin === undefined || body.pin === null ? '' : body.pin, c.pin)) {
      return res.status(401).json({ error: 'wrong_pin' });
    }
    await redis(c, ['DEL', rk]);

    if (body.action === 'check') return res.status(200).json({ ok: true });

    if (typeof body.date !== 'string' || !DATE_RE.test(body.date)) {
      return res.status(400).json({ error: 'bad_date' });
    }
    const slots = body.slots;
    if (!slots || typeof slots !== 'object' || Array.isArray(slots)) {
      return res.status(400).json({ error: 'bad_slots' });
    }
    const entry = {};
    for (const k of SLOT_KEYS) {
      const v = slots[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string') return res.status(400).json({ error: 'bad_slots' });
      entry[k] = v.trim().slice(0, 80);
    }
    if (Object.keys(entry).length) {
      await redis(c, ['HSET', HASH, body.date, JSON.stringify(entry)]);
    } else {
      await redis(c, ['HDEL', HASH, body.date]);
    }
    return res.status(200).json({ ok: true, day: Object.keys(entry).length ? entry : null });
  } catch (e) {
    return res.status(502).json({ error: 'storage_error' });
  }
};
