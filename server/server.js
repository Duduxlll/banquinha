// server/server.js
import 'dotenv/config';
import fs from 'fs';
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
import { Pool } from 'pg';

/* ================= .env (produção) =================
NODE_ENV=production
ORIGIN=https://seu-app.onrender.com
STATIC_ROOT=..                  # raiz do site (pai de /server)
ADMIN_USER=admin
ADMIN_PASSWORD_HASH=<hash_bcrypt>
JWT_SECRET=<64+ chars aleatórios>

# Postgres (Render)
DATABASE_URL=postgres://user:pass@host:5432/dbname

# Efi (PIX)
EFI_CLIENT_ID=...
EFI_CLIENT_SECRET=...
EFI_PIX_KEY=...
EFI_BASE_URL=https://pix-h.api.efipay.com.br
EFI_OAUTH_URL=https://pix-h.api.efipay.com.br/oauth/token
EFI_CERT_PATH=/etc/secrets/client-cert.pem
EFI_KEY_PATH=/etc/secrets/client-key.pem
==================================================== */

const {
  PORT = 3000,
  ORIGIN = `http://localhost:3000`,
  STATIC_ROOT,
  ADMIN_USER = 'admin',
  ADMIN_PASSWORD_HASH,
  JWT_SECRET,
  DATABASE_URL,
  EFI_CLIENT_ID,
  EFI_CLIENT_SECRET,
  EFI_CERT_PATH,
  EFI_KEY_PATH,
  EFI_BASE_URL,
  EFI_OAUTH_URL,
  EFI_PIX_KEY
} = process.env;

const PROD = process.env.NODE_ENV === 'production';

/* ===== valida env ===== */
['ADMIN_USER','ADMIN_PASSWORD_HASH','JWT_SECRET','DATABASE_URL'].forEach(k=>{
  if(!process.env[k]) { console.error(`❌ Falta ${k} no .env`); process.exit(1); }
});
['EFI_CLIENT_ID','EFI_CLIENT_SECRET','EFI_CERT_PATH','EFI_KEY_PATH','EFI_PIX_KEY','EFI_BASE_URL','EFI_OAUTH_URL']
  .forEach(k => { if(!process.env[k]) { console.error(`❌ Falta ${k} no .env (Efi)`); process.exit(1); } });

/* ===== paths ===== */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, STATIC_ROOT || '..');

/* ===== HTTPS agent Efi ===== */
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

/* ===== Postgres ===== */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Render PG
});

async function initDB(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bancas (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      deposito_cents INT NOT NULL,
      banca_cents INT,
      pix_type TEXT,
      pix_key  TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pagamentos (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      pagamento_cents INT NOT NULL,
      pix_type TEXT,
      pix_key  TEXT,
      status TEXT NOT NULL DEFAULT 'nao_pago' CHECK (status IN ('pago','nao_pago')),
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

/* ===== app base ===== */
const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(cors({ origin: ORIGIN, credentials: true }));
app.options('*', cors({ origin: ORIGIN, credentials: true }));

// estáticos do site
app.use(express.static(ROOT, { extensions: ['html'] }));

/* ===== auth helpers ===== */
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
    secure: PROD,
    maxAge: 2 * 60 * 60 * 1000,
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

/* ===== rotas de auth ===== */
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

app.post('/api/auth/logout', requireAuth, (req, res) => {
  clearAuthCookies(res);
  return res.json({ ok:true });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.session;
  const data  = token && verifySession(token);
  if (!data) return res.status(401).json({ error: 'unauthorized' });
  return res.json({ user: { username: data.sub } });
});

// protege a área
app.get('/area.html', (req, res) => {
  const token = req.cookies?.session;
  if (!token || !verifySession(token)) return res.redirect('/login.html');
  return res.sendFile(path.join(ROOT, 'area.html'));
});

/* ===== verificação ===== */
app.get('/health', async (req, res) => {
  try {
    // confere certificados e conexão ao PG
    fs.accessSync(EFI_CERT_PATH); fs.accessSync(EFI_KEY_PATH);
    await pool.query('SELECT 1;');
    return res.json({ ok:true, cert:EFI_CERT_PATH, key:EFI_KEY_PATH, pg:true });
  } catch (e) {
    return res.status(500).json({ ok:false, msg:String(e?.message||e) });
  }
});

/* ===== PIX (Efi) ===== */
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
      `${EFI_BASE_URL}/v2/cob`, payload,
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

/* ===== Área (precisa login) — Postgres ===== */
const areaAuth = [requireAuth];

/* Bancas */
app.get('/api/bancas', areaAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nome, deposito_cents AS "depositoCents", banca_cents AS "bancaCents",
            pix_type AS "pixType", pix_key AS "pixKey", created_at AS "createdAt"
     FROM bancas
     ORDER BY created_at DESC`
  );
  res.json(rows);
});

app.post('/api/bancas', areaAuth, async (req, res) => {
  const { nome, depositoCents, pixType=null, pixKey=null } = req.body || {};
  if (!nome || typeof depositoCents !== 'number' || depositoCents <= 0) {
    return res.status(400).json({ error: 'dados_invalidos' });
  }
  const id = uid();
  const { rows } = await pool.query(
    `INSERT INTO bancas (id, nome, deposito_cents, banca_cents, pix_type, pix_key)
     VALUES ($1,$2,$3,NULL,$4,$5)
     RETURNING id, nome, deposito_cents AS "depositoCents", banca_cents AS "bancaCents",
               pix_type AS "pixType", pix_key AS "pixKey", created_at AS "createdAt"`,
    [id, nome, depositoCents, pixType, pixKey]
  );
  res.json(rows[0]);
});

app.patch('/api/bancas/:id', areaAuth, async (req, res) => {
  const { bancaCents } = req.body || {};
  if (typeof bancaCents !== 'number' || bancaCents < 0) {
    return res.status(400).json({ error: 'dados_invalidos' });
  }
  const { rows } = await pool.query(
    `UPDATE bancas SET banca_cents = $2 WHERE id = $1
     RETURNING id, nome, deposito_cents AS "depositoCents", banca_cents AS "bancaCents",
               pix_type AS "pixType", pix_key AS "pixKey", created_at AS "createdAt"`,
    [req.params.id, bancaCents]
  );
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

app.post('/api/bancas/:id/to-pagamento', areaAuth, async (req, res) => {
  const client = await pool.connect();
  try{
    await client.query('BEGIN');
    const bRes = await client.query(
      `SELECT id, nome, deposito_cents, COALESCE(banca_cents, deposito_cents) AS valor,
              pix_type, pix_key, created_at
       FROM bancas WHERE id = $1 FOR UPDATE`, [req.params.id]
    );
    if (!bRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }
    const b = bRes.rows[0];

    await client.query(`DELETE FROM bancas WHERE id = $1`, [req.params.id]);

    await client.query(
      `INSERT INTO pagamentos (id, nome, pagamento_cents, pix_type, pix_key, status, paid_at, created_at)
       VALUES ($1,$2,$3,$4,$5,'nao_pago',NULL,$6)`,
      [b.id, b.nome, b.valor, b.pix_type, b.pix_key, b.created_at]
    );

    await client.query('COMMIT');
    res.json({ ok:true });
  }catch(e){
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'fail' });
  }finally{
    client.release();
  }
});

app.delete('/api/bancas/:id', areaAuth, async (req, res) => {
  const r = await pool.query(`DELETE FROM bancas WHERE id = $1`, [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok:true });
});

/* Pagamentos */
app.get('/api/pagamentos', areaAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nome, pagamento_cents AS "pagamentoCents", pix_type AS "pixType",
            pix_key AS "pixKey", status, paid_at AS "paidAt", created_at AS "createdAt"
     FROM pagamentos
     ORDER BY created_at DESC`
  );
  res.json(rows);
});


// >>> PUBLIC: confirmar pagamento PIX e registrar na tabela "bancas"
// Recebe { txid, nome, valorCentavos, tipo, chave }
// 1) confere no Efi se o txid está CONCLUIDA
// 2) se estiver, insere em "bancas"
app.post('/api/pix/confirmar', async (req, res) => {
  try {
    const { txid, nome, valorCentavos, tipo=null, chave=null } = req.body || {};
    if (!txid || !nome || !valorCentavos || valorCentavos < 1) {
      return res.status(400).json({ error: 'dados_invalidos' });
    }

    // valida no Efi
    const token = await getAccessToken();
    const { data } = await axios.get(
      `${EFI_BASE_URL}/v2/cob/${encodeURIComponent(txid)}`,
      { httpsAgent, headers: { Authorization: `Bearer ${token}` } }
    );

    if (data.status !== 'CONCLUIDA') {
      return res.status(409).json({ error: 'pix_nao_concluido', status: data.status });
    }

    // grava em "bancas" (Postgres)
    const id = txid; // pode usar o próprio txid como id
    await pool.query(
      `INSERT INTO bancas (id, nome, deposito_cents, banca_cents, pix_type, pix_key, created_at)
       VALUES ($1,$2,$3,NULL,$4,$5, now())
       ON CONFLICT (id) DO NOTHING`,
      [id, nome, valorCentavos, tipo, chave]
    );

    return res.json({ ok:true });
  } catch (err) {
    console.error('Erro /api/pix/confirmar:', err.response?.data || err.message);
    return res.status(500).json({ error: 'falha_confirmar' });
  }
});



app.patch('/api/pagamentos/:id', areaAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!['pago','nao_pago'].includes(status)) return res.status(400).json({ error: 'status_invalido' });

  const paidAt = (status === 'pago') ? new Date() : null;

  const { rows } = await pool.query(
    `UPDATE pagamentos
       SET status = $2, paid_at = $3
     WHERE id = $1
     RETURNING id, nome, pagamento_cents AS "pagamentoCents", pix_type AS "pixType",
               pix_key AS "pixKey", status, paid_at AS "paidAt", created_at AS "createdAt"`,
    [req.params.id, status, paidAt]
  );
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

app.delete('/api/pagamentos/:id', areaAuth, async (req, res) => {
  const r = await pool.query(`DELETE FROM pagamentos WHERE id = $1`, [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok:true });
});

/* start */
initDB().then(()=>{
  app.listen(PORT, () => {
    console.log(`✅ Server rodando em ${ORIGIN} (NODE_ENV=${process.env.NODE_ENV||'dev'})`);
    console.log(`🗂  Servindo estáticos de: ${ROOT}`);
    console.log(`🗄️  Postgres conectado`);
    console.log(`🔒 /area.html protegido por sessão; login em /login.html`);
  });
}).catch((e)=>{
  console.error('❌ Falha ao iniciar DB:', e);
  process.exit(1);
});
