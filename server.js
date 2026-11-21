// Plain Node server (Render, VPS, local). On Vercel this file is not used; api/pair.js runs as a function.
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import pair from './api/pair.js';
import { startKeepAlive } from './keepAlive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.post('/api/pair', pair);
app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(parseInt(process.env.PORT || '3000'), () => {
  startKeepAlive();
  const ver = (n) => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'node_modules', n, 'package.json'), 'utf8')).version; } catch { return 'missing'; } };
  console.log(`ADEZ NEXUS pair site running (baileys-latest ${ver('baileys-latest')}, gifted-baileys ${ver('gifted-baileys')}, node ${process.version})`);
});
