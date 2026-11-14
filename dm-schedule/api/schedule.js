// Vercel serverless function for the DM session schedule.
// GET  -> public schedule (players shown only if the admin allows it; private notes never)
// POST -> admin actions, PIN checked on the server: check | load | save | settings
// Storage: Redis with the Upstash REST API (Vercel Marketplace -> Upstash Redis).
const crypto = require('crypto');

const HASH = 'dm-schedule:days';
const SETTINGS_KEY = 'dm-schedule:settings';
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TYPES = ['oneshot', 'mini', 'campaign', 'block'];
const MAX_SESSIONS_PER_DAY = 8;
const MAX_PLAYERS = 12;
const MAX_TRIES = 10;     // PIN attempts per IP...
const TRY_WINDOW = 900;   // ...per 15 minutes (a correct PIN resets the counter)
// Old fixed slots from the previous version, used to convert old data.
const OLD_SLOTS = { m: ['06:00', '12:00'], a: ['13:00', '18:00'], e: ['19:00', '00:00'] };

function cfg() {
  return {
    base: (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, ''),
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '',
    pin: process.env.ADMIN_PIN || ''
  };
}

async function pipeline(c, cmds) {
  const r = await fetch(c.base + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  const j = await r.json();
  if (!r.ok || !Array.isArray(j)) throw new Error('redis_' + r.status);
  j.forEach((x) => { if (x && x.error) throw new Error(x.error); });
  return j.map((x) => x && x.result);
}
async function redis(c, cmd) { return (await pipeline(c, [cmd]))[0]; }

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function str(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}
function toMin(t) { const p = t.split(':'); return Number(p[0]) * 60 + Number(p[1]); }

function cleanSession(s) {
  if (!s || typeof s !== 'object') return null;
  if (!TIME_RE.test(s.start) || !TIME_RE.test(s.end)) return null;
  const type = TYPES.includes(s.type) ? s.type : 'campaign';
  const players = (Array.isArray(s.players) ? s.players : [])
    .map((p) => str(p, 40)).filter(Boolean).slice(0, MAX_PLAYERS);
  return {
    id: str(s.id, 32) || crypto.randomBytes(6).toString('hex'),
    start: s.start,
    end: s.end,
    type,
    ss: type === 'block' ? '' : str(s.ss, 16),
    campaign: type === 'block' ? '' : str(s.campaign, 60),
    players: type === 'block' ? [] : players,
    note: str(s.note, 160)
  };
}
function sortSessions(list) { return list.sort((a, b) => toMin(a.start) - toMin(b.start)); }

// Accepts the new format (array of sessions) and the old one ({m,a,e}).
function toSessions(val) {
  let obj = val;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch (e) { return []; } }
  if (Array.isArray(obj)) return sortSessions(obj.map(cleanSession).filter(Boolean));
  if (obj && typeof obj === 'object') {
    const out = [];
    Object.keys(OLD_SLOTS).forEach((k) => {
      if (typeof obj[k] !== 'string') return;
      const [start, end] = OLD_SLOTS[k];
      const name = obj[k].trim();
      out.push(cleanSession({ id: 'old-' + k, start, end, type: name ? 'campaign' : 'block', campaign: name }));
    });
    return sortSessions(out.filter(Boolean));
  }
  return [];
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
    const list = toSessions(val);
    if (list.length) days[date] = list;
  });
  return days;
}
function parseSettings(raw) {
  let s = {};
  try { s = raw ? JSON.parse(raw) : {}; } catch (e) { s = {}; }
  return { showPlayers: s && s.showPlayers === true };
}

function publicDays(days, settings) {
  const out = {};
  Object.keys(days).forEach((dk) => {
    out[dk] = days[dk].map((s) => (s.type === 'block'
      ? { id: s.id, start: s.start, end: s.end, type: 'block' }
      : {
          id: s.id, start: s.start, end: s.end, type: s.type, ss: s.ss, campaign: s.campaign,
          players: settings.showPlayers ? s.players : []
        }));
  });
  return out;
}

async function readAll(c) {
  const [raw, set] = await pipeline(c, [['HGETALL', HASH], ['GET', SETTINGS_KEY]]);
  return { days: parseDays(raw), settings: parseSettings(set) };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const c = cfg();

  if (req.method === 'GET') {
    if (!c.base || !c.token) return res.status(500).json({ error: 'storage_not_configured' });
    try {
      const all = await readAll(c);
      return res.status(200).json({ days: publicDays(all.days, all.settings) });
    } catch (e) {
      return res.status(502).json({ error: 'storage_error' });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Fail closed: no PIN configured on the server means nobody can edit.
  if (!c.base || !c.token || !c.pin) return res.status(500).json({ error: 'server_not_configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'bad_request' });

  try {
    const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();
    const rk = 'dm-schedule:try:' + ip;
    const [count] = await pipeline(c, [['INCR', rk], ['EXPIRE', rk, TRY_WINDOW]]);
    if (Number(count) > MAX_TRIES) return res.status(429).json({ error: 'too_many_attempts' });

    if (!safeEqual(body.pin == null ? '' : body.pin, c.pin)) {
      return res.status(401).json({ error: 'wrong_pin' });
    }
    await redis(c, ['DEL', rk]);

    const action = body.action || 'save';

    if (action === 'check') return res.status(200).json({ ok: true });

    if (action === 'load') {
      const all = await readAll(c);
      return res.status(200).json({ days: all.days, settings: all.settings });
    }

    if (action === 'settings') {
      const settings = { showPlayers: body.showPlayers === true };
      await redis(c, ['SET', SETTINGS_KEY, JSON.stringify(settings)]);
      return res.status(200).json({ ok: true, settings });
    }

    if (action === 'save') {
      if (typeof body.date !== 'string' || !DATE_RE.test(body.date)) {
        return res.status(400).json({ error: 'bad_date' });
      }
      if (!Array.isArray(body.sessions) || body.sessions.length > MAX_SESSIONS_PER_DAY) {
        return res.status(400).json({ error: 'bad_sessions' });
      }
      const list = [];
      for (const s of body.sessions) {
        const cs = cleanSession(s);
        if (!cs) return res.status(400).json({ error: 'bad_session' });
        list.push(cs);
      }
      sortSessions(list);
      if (list.length) await redis(c, ['HSET', HASH, body.date, JSON.stringify(list)]);
      else await redis(c, ['HDEL', HASH, body.date]);
      return res.status(200).json({ ok: true, sessions: list });
    }

    return res.status(400).json({ error: 'bad_action' });
  } catch (e) {
    return res.status(502).json({ error: 'storage_error' });
  }
};
