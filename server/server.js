// server/server.js
import 'dotenv/config';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import axios from 'axios';
import QRCode from 'qrcode';

/* =========================================================
   .env necessários (Render/produção):
   ---------------------------------------------------------
   NODE_ENV=production
   PORT=10000                        # Render injeta, pode omitir
   ORIGIN=https://seu-app.onrender.com
   STATIC_ROOT=..                    # (padrão) raiz do projeto (pai de /server)

   ADMIN_USER=admin
   ADMIN_PASSWORD_HASH=<hash_bcrypt>
   JWT_SECRET=<64+ chars aleatórios>

   EFI_CLIENT_ID=...
   EFI_CLIENT_SECRET=...
   EFI_PIX_KEY=...
   EFI_BASE_URL=https://pix-h.api.efipay.com.br
   EFI_OAUTH_URL=https://pix-h.api.efipay.com.br/oauth/token
   EFI_CERT_PATH=/etc/secrets/client-cert.pem
   EFI_KEY_PATH=/etc/secrets/client-key.pem

   # Persistência por arquivo (Render Disk)
   DATA_DIR=/var/data                # ex.: se você criar um Disk
   ========================================================= */

const {
  PORT = 3000,
  ORIGIN = `http://localhost:3000`,
  STATIC_ROOT, // opcional; default = pai de /server
  ADMIN_USER = 'admin',
  ADMIN_PASSWORD_HASH,
  JWT_SECRET,
  EFI_CLIENT_ID,
  EFI_CLIENT_SECRET,
  EFI_CERT_PATH,
  EFI_KEY_PATH,
  EFI_BASE_URL,
  EFI_OAUTH_URL,
  EFI_PIX_KEY,
  DATA_DIR
} = process.env;

const PROD = process.env.NODE_ENV === 'production';

// ===== valida env do login =====
['ADMIN_USER','ADMIN_PASSWORD_HASH','JWT_SECRET'].forEach(k=>{
  if(!process.env[k]) { console.error(`❌ Falta ${k} no .env (login)`); process.exit(1); }
});
// ===== valida env do Efi =====
['EFI_CLIENT_ID','EFI_CLIENT_SECRET','EFI_CERT_PATH','EFI_KEY_PATH','EFI_PIX_KEY','EFI_BASE_URL','EFI_OAUTH_URL']
  .forEach(k => { if(!process.env[k]) { console.error(`❌ Falta ${k} no .env (Efi)`); process.exit(1); } });

// ===== paths =====
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, STATIC_ROOT || '..'); // raiz do site (index.html, area.html, assets/)

// ===== HTTPS agent APENAS para chamadas ao Efi =====
const httpsAgent = new https.Agent({
  cert: fs.readFileSync(EFI_CERT_PATH),
  key:  fs.readFileSync(EFI_KEY_PATH),
  rejectUnauthorized: true
});

async function getAccessToken() {
  const resp = await axios.post(
    EFI_OAUTH_URL,
    'grant_type=client_credentials',
    {
      httpsAgent,
      auth: { username: EFI_CLIENT_ID, password: EFI_CLIENT_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }
  );
  return resp.data.access_token;
}

// ===== Persistência simples (arquivo JSON) =====
const DATA_DIR_FINAL  = DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE       = path.join(DATA_DIR_FINAL, 'db.json');

async function ensureData(){
  try { await fsp.mkdir(DATA_DIR_FINAL, { recursive: true }); } catch {}
  try { await fsp.access(DATA_FILE); }
  catch { await fsp.writeFile(DATA_FILE, JSON.stringify({ bancas: [], pagamentos: [] }, null, 2)); }
}
async function readDB(){
  await ensureData();
  const raw = await fsp.readFile(DATA_FILE, 'utf8');
  return JSON.parse(raw || '{"bancas":[],"pagamentos":[]}');
}
async function writeDB(db){
  await ensureData();
  await fsp.writeFile(DATA_FILE, JSON.stringify(db, null, 2));
}
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

// ===== app base =====
const app = express();

// Proxies (Render) — cookies secure/samesite corretos
app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(express.json());
app.use(cookieParser());

// Se o front for servido por este mesmo servidor, CORS é pouco usado.
// Mantido para cenários multi-domínio:
app.use(cors({
  origin: ORIGIN,
  credentials: true
}));

// Servir estáticos (site completo)
app.use(express.static(ROOT, { extensions: ['html'] }));

// ===== helpers de auth =====
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

function signSession(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '2h' });
}
function verifySession(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}
function randomHex(n=32){ return crypto.randomBytes(n).toString('hex'); }

function setAuthCookies(res, token) {
  const common = {
    sameSite: 'strict',
    secure: PROD,               // 🔒 em produção: true
    maxAge: 2 * 60 * 60 * 1000, // 2h
    path: '/'
  };
  res.cookie('session', token, { ...common, httpOnly: true });
  res.cookie('csrf',    randomHex(16), { ...common, httpOnly: false });
}
function clearAuthCookies(res){
  const common = { sameSite: 'strict', secure: PROD, path: '/' };
  res.clearCookie('session', { ...common, httpOnly:true });
  res.clearCookie('csrf',    { ...common });
}

function requireAuth(req, res, next){
  const token = req.cookies?.session;
  const data = token && verifySession(token);
  if (!data) return res.status(401).json({ error: 'unauthorized' });

  // CSRF para métodos que alteram estado
  if (['POST','PUT','PATCH','DELETE'].includes(req.method)) {
    const csrfHeader = req.get('X-CSRF-Token');
    const csrfCookie = req.cookies?.csrf;
    if (!csrfHeader || csrfHeader !== csrfCookie) {
      return res.status(403).json({ error: 'invalid_csrf' });
    }
  }
  req.user = data;
  next();
}

// ===== rotas de auth =====
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing_fields' });

  const userOk = username === ADMIN_USER;
  const passOk = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);

  if (!userOk || !passOk) return res.status(401).json({ error: 'invalid_credentials' });

  const token = signSession({ sub: ADMIN_USER, role: 'admin' });
  setAuthCookies(res, token);
  return res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookies(res);
  return res.json({ ok:true });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.session;
  const data  = token && verifySession(token);
  if (!data) return res.status(401).json({ error: 'unauthorized' });
  return res.json({ user: { username: data.sub } });
});

// Protege a área
app.get('/area.html', (req, res) => {
  const token = req.cookies?.session;
  if (!token || !verifySession(token)) return res.redirect('/login.html');
  return res.sendFile(path.join(ROOT, 'area.html'));
});

// ===== endpoints de verificação geral =====
app.get('/health', (req, res) => {
  try {
    fs.accessSync(EFI_CERT_PATH); fs.accessSync(EFI_KEY_PATH);
    return res.json({ ok:true, cert:EFI_CERT_PATH, key:EFI_KEY_PATH, dataDir: DATA_DIR_FINAL });
  } catch {
    return res.status(500).json({ ok:false, msg:'Cert/Key não encontrados' });
  }
});
app.get('/api/pix/ping', async (req, res) => {
  try {
    const token = await getAccessToken();
    return res.json({ ok:true, token:true });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e.response?.data || e.message });
  }
});

// ===== API PIX (Efi) =====
app.post('/api/pix/cob', async (req, res) => {
  try {
    const { nome, cpf, valorCentavos } = req.body || {};
    if (!nome || !valorCentavos || valorCentavos < 1000) {
      return res.status(400).json({ error: 'Dados inválidos (mínimo R$ 10,00)' });
    }
    const token = await getAccessToken();
    const valor = (valorCentavos / 100).toFixed(2);

    const payload = {
      calendario: { expiracao: 3600 },
      devedor: cpf ? { cpf: (cpf||'').replace(/\D/g,''), nome } : { nome },
      valor: { original: valor },
      chave: EFI_PIX_KEY,
      infoAdicionais: [{ nome: 'Nome', valor: nome }]
    };

    const { data: cob } = await axios.post(
      `${EFI_BASE_URL}/v2/cob`,
      payload,
      { httpsAgent, headers: { Authorization: `Bearer ${token}` } }
    );
    const { txid, loc } = cob;

    const { data: qr } = await axios.get(
      `${EFI_BASE_URL}/v2/loc/${loc.id}/qrcode`,
      { httpsAgent, headers: { Authorization: `Bearer ${token}` } }
    );

    const emv = qr.qrcode;
    const qrPng = qr.imagemQrcode || (await QRCode.toDataURL(emv));
    res.json({ txid, emv, qrPng });
  } catch (err) {
    console.error('Erro /api/pix/cob:', err.response?.data || err.message);
    res.status(500).json({ error: 'Falha ao criar cobrança PIX' });
  }
});

app.get('/api/pix/status/:txid', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { data } = await axios.get(
      `${EFI_BASE_URL}/v2/cob/${encodeURIComponent(req.params.txid)}`,
      { httpsAgent, headers: { Authorization: `Bearer ${token}` } }
    );
    res.json({ status: data.status });
  } catch (err) {
    console.error('Erro status:', err.response?.data || err.message);
    res.status(500).json({ error: 'Falha ao consultar status' });
  }
});

// ====== MIDDLEWARE: todas as rotas da Área exigem login ======
const areaAuth = [requireAuth];

// ====== BANCAS ======
app.get('/api/bancas', areaAuth, async (req, res) => {
  const db = await readDB();
  const list = [...db.bancas].sort((a,b) => (a.createdAt||'') < (b.createdAt||'') ? 1 : -1);
  res.json(list);
});

app.post('/api/bancas', areaAuth, async (req, res) => {
  const { nome, depositoCents, pixType=null, pixKey=null } = req.body || {};
  if (!nome || typeof depositoCents !== 'number' || depositoCents <= 0) {
    return res.status(400).json({ error: 'dados_invalidos' });
  }
  const db = await readDB();
  const item = { id: uid(), nome, depositoCents, pixType, pixKey, createdAt: new Date().toISOString() };
  db.bancas.push(item);
  await writeDB(db);
  res.json(item);
});

app.patch('/api/bancas/:id', areaAuth, async (req, res) => {
  const { bancaCents } = req.body || {};
  const db = await readDB();
  const item = db.bancas.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  if (typeof bancaCents === 'number' && bancaCents >= 0) item.bancaCents = bancaCents;
  await writeDB(db);
  res.json(item);
});

app.post('/api/bancas/:id/to-pagamento', areaAuth, async (req, res) => {
  const db = await readDB();
  const ix = db.bancas.findIndex(x => x.id === req.params.id);
  if (ix < 0) return res.status(404).json({ error: 'not_found' });
  const b = db.bancas[ix];
  db.bancas.splice(ix,1);

  const valor = (typeof b.bancaCents === 'number' && b.bancaCents>0) ? b.bancaCents : b.depositoCents;

  db.pagamentos.push({
    id: b.id,
    nome: b.nome,
    pagamentoCents: valor,
    pixType: b.pixType || null,
    pixKey:  b.pixKey  || null,
    status: 'nao_pago',
    createdAt: b.createdAt
  });

  await writeDB(db);
  res.json({ ok:true });
});

app.delete('/api/bancas/:id', areaAuth, async (req, res) => {
  const db = await readDB();
  const before = db.bancas.length;
  db.bancas = db.bancas.filter(x => x.id !== req.params.id);
  if (db.bancas.length === before) return res.status(404).json({ error: 'not_found' });
  await writeDB(db);
  res.json({ ok:true });
});

// ====== PAGAMENTOS ======
app.get('/api/pagamentos', areaAuth, async (req, res) => {
  const db = await readDB();
  const list = [...db.pagamentos].sort((a,b) => (a.createdAt||'') < (b.createdAt||'') ? 1 : -1);
  res.json(list);
});

app.patch('/api/pagamentos/:id', areaAuth, async (req, res) => {
  const { status } = req.body || {}; // 'pago' | 'nao_pago'
  if (!['pago','nao_pago'].includes(status)) return res.status(400).json({ error: 'status_invalido' });
  const db = await readDB();
  const p = db.pagamentos.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  p.status = status;
  p.paidAt = (status === 'pago') ? new Date().toISOString() : undefined;
  await writeDB(db);
  res.json(p);
});

app.delete('/api/pagamentos/:id', areaAuth, async (req, res) => {
  const db = await readDB();
  const before = db.pagamentos.length;
  db.pagamentos = db.pagamentos.filter(x => x.id !== req.params.id);
  if (db.pagamentos.length === before) return res.status(404).json({ error: 'not_found' });
  await writeDB(db);
  res.json({ ok:true });
});

// ===== start =====
app.listen(PORT, () => {
  console.log(`✅ Server rodando em ${ORIGIN} (NODE_ENV=${process.env.NODE_ENV||'dev'})`);
  console.log(`🗂  Servindo estáticos de: ${ROOT}`);
  console.log(`💾 DATA_DIR: ${DATA_DIR_FINAL}`);
  console.log(`🔒 /area.html protegido por sessão; login em /login.html`);
});
