// One request does the whole pairing and streams progress back (NDJSON):
//   {type:'code', code}  ->  {type:'linked'}  ->  {type:'session', session}  |  {type:'error', message}
// Works on Vercel (single long-running function) and on a normal Node server (see server.js).
//
// Two WhatsApp libraries are installed (see package.json): the latest official Baileys
// ("baileys-latest") and gifted-baileys. If WhatsApp refuses one (405), the next is tried.
import pino from 'pino';
import zlib from 'zlib';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const logger = pino({ level: 'silent' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TOTAL_TIMEOUT = 270_000;     // stay under Vercel's 300s function limit
const RESTART_REQUIRED = 515;      // WhatsApp asks for a restart right after the code is accepted
const LOGGED_OUT = 401;

const BROWSERS = {
  safari: ['Mac OS', 'Safari', '17.5.1'],
  chrome: ['Ubuntu', 'Chrome', '22.04.4'],
  macchrome: ['Mac OS', 'Chrome', '14.4.1']
};
const BROWSER = BROWSERS[(process.env.PAIR_BROWSER || 'safari').toLowerCase()] || BROWSERS.safari;

// Tried in order until WhatsApp hands out a pairing code.
// ver: 'builtin' = library's own version, 'web' = latest WhatsApp Web, 'baileys' = latest Baileys-recommended
const CONFIGS = [
  { lib: 'baileys-latest', browser: BROWSER,            ver: 'web'     },
  { lib: 'baileys-latest', browser: BROWSERS.chrome,    ver: 'web'     },
  { lib: 'baileys-latest', browser: BROWSER,            ver: 'builtin' },
  { lib: 'gifted-baileys', browser: BROWSER,            ver: 'builtin' },
  { lib: 'gifted-baileys', browser: BROWSERS.chrome,    ver: 'baileys' },
  { lib: 'gifted-baileys', browser: BROWSERS.macchrome, ver: 'web'     }
];

const libs = {};
async function loadLib(name) {
  if (libs[name]) return libs[name];
  const m = await import(name);
  const d = m.default;
  const make = typeof d === 'function' ? d : (typeof d?.default === 'function' ? d.default : m.makeWASocket);
  if (typeof make !== 'function') throw new Error(`${name}: no socket factory found`);
  const pick = (k) => m[k] ?? d?.[k] ?? d?.default?.[k];
  libs[name] = {
    make,
    useMultiFileAuthState: pick('useMultiFileAuthState'),
    makeCacheableSignalKeyStore: pick('makeCacheableSignalKeyStore'),
    fetchLatestWaWebVersion: pick('fetchLatestWaWebVersion'),
    fetchLatestBaileysVersion: pick('fetchLatestBaileysVersion')
  };
  return libs[name];
}

const _cache = {};
async function getVersion(L, lib, kind) {
  if (kind === 'builtin') return undefined;
  const key = lib + ':' + kind;
  const c = _cache[key];
  if (c && Date.now() - c.at < 3_600_000) return c.v;
  try {
    const fn = kind === 'baileys' ? L.fetchLatestBaileysVersion : L.fetchLatestWaWebVersion;
    const r = fn ? await Promise.race([fn(), sleep(4000).then(() => null)]) : null;
    if (r?.version) { _cache[key] = { v: r.version, at: Date.now() }; return r.version; }
  } catch {}
  return undefined;                // fall back to the library's built-in version
}

const hits = new Map();            // per-instance rate limit
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 10 * 60_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 10;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.socket?.remoteAddress || 'x';
  if (rateLimited(ip)) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const number = String(body?.number || '').replace(/\D/g, '');
  if (number.length < 8 || number.length > 15) {
    return res.status(400).json({ error: 'Enter your number with country code, digits only. Example: 254111783552' });
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  const emit = (o) => { try { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); } catch {} };
  emit({ type: 'start' });

  const id = crypto.randomBytes(6).toString('hex');
  const dir = path.join(os.tmpdir(), 'nexus-pair-' + id);   // /tmp is the only writable place on Vercel
  fs.mkdirSync(dir, { recursive: true });

  let sock = null, over = false, hasCode = false, linked = false;
  let finish;
  const finished = new Promise(r => { finish = r; });
  const stop = (message) => {
    if (over) return;
    over = true;
    if (message) emit({ type: 'error', message });
    finish();
  };

  res.on('close', () => { if (!res.writableFinished) { over = true; finish(); } });   // visitor left
  const timer = setTimeout(() => stop('Pairing timed out. Start again for a new code.'), TOTAL_TIMEOUT);

  async function complete(s) {
    try {
      await sleep(2500);                                   // let creds.json finish writing
      const raw = fs.readFileSync(path.join(dir, 'creds.json'));
      const session = 'ADEZ~' + zlib.gzipSync(raw).toString('base64');
      emit({ type: 'session', session });
      const me = s.user?.id?.split(':')[0]?.split('@')[0] || number;
      try {
        const jid = me + '@s.whatsapp.net';
        await s.sendMessage(jid, { text: session });
        await s.sendMessage(jid, { text: '✅ *ADEZ NEXUS session created*\n\nCopy the message above and set it as SESSION_ID for your bot.\n\n⚠️ Never share this code. Anyone with it controls your WhatsApp.' });
      } catch (e) { console.error('DM failed:', e.message); }
      await sleep(2500);
      over = true; finish();                               // no logout: that would kill the session
    } catch (e) {
      stop('Linked, but the session could not be created. Please try again.');
    }
  }

  // Start config #idx; if its library can't even load, move on to the next one.
  async function startFrom(first, idx) {
    for (let i = idx; i < CONFIGS.length; i++) {
      try { await start(first, i); return; }
      catch (e) { console.error(`[${id}] config ${i + 1} could not start: ${e.message}`); }
    }
    stop('Could not start pairing. Please try again.');
  }

  async function start(first, idx) {
    const cfg = CONFIGS[idx];
    const L = await loadLib(cfg.lib);
    const { state, saveCreds } = await L.useMultiFileAuthState(dir);
    const version = await getVersion(L, cfg.lib, cfg.ver);
    console.log(`[${id}] try ${idx + 1}/${CONFIGS.length} lib=${cfg.lib} browser=${cfg.browser.join('/')} version=${version ? cfg.ver + ':' + version.join('.') : 'built-in'}`);
    const opts = {
      auth: { creds: state.creds, keys: L.makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false,
      syncFullHistory: false,
      logger,
      browser: cfg.browser,
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 25_000
    };
    if (version) opts.version = version;   // never pass version: undefined, it overrides the library default and crashes
    const s = L.make(opts);
    sock = s;
    s.ev.on('creds.update', saveCreds);

    let asked = false;
    const ask = async () => {
      if (!first || asked || hasCode || over || s.authState.creds.registered) return;
      asked = true;
      try {
        const raw = await s.requestPairingCode(number);
        hasCode = true;
        emit({ type: 'code', code: raw.replace(/(.{4})(?=.)/, '$1-') });
      } catch (e) {
        console.error('requestPairingCode failed:', e.message);
        stop('Could not get a pairing code from WhatsApp. Check the number (country code, digits only) and try again.');
      }
    };
    const fallback = setTimeout(ask, 6000);                // in case no qr event arrives

    s.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) ask();
      if (connection === 'open') {
        clearTimeout(fallback);
        if (linked) return;
        linked = true;
        emit({ type: 'linked' });
        await complete(s);
      } else if (connection === 'close') {
        clearTimeout(fallback);
        if (over || linked) return;
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log(`[${id}] closed code=${code} hasCode=${hasCode} reason=${lastDisconnect?.error?.message || 'none'}`);
        if (code === RESTART_REQUIRED) {
          try { await start(false, idx); } catch { stop('Connection failed after linking. Please try again.'); }
        } else if (!hasCode && idx + 1 < CONFIGS.length) {
          // refused before we had a code (usually 405): wipe and retry with the next config
          try { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); } catch {}
          await startFrom(true, idx + 1);
        } else if (code === 405) {
          stop('WhatsApp refused the connection (405) on every attempt. Wait a minute and try again. If it keeps happening, this host\'s IP is probably being blocked.');
        } else if (code === LOGGED_OUT) {
          stop('WhatsApp rejected the link (code 401). Wait a minute, then try again.');
        } else {
          stop(`The connection dropped (code ${code ?? 'unknown'}). Start again for a new code.`);
        }
      }
    });
  }

  try {
    await startFrom(true, 0);
    await finished;
  } catch (e) {
    console.error('pair error:', e.message);
    stop('Could not start pairing. Please try again.');
  }

  clearTimeout(timer);
  try { sock?.ev.removeAllListeners(); sock?.end(undefined); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  try { res.end(); } catch {}
         }
