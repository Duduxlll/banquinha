// server/server.js — versão com Extratos (depósitos + pagamentos) e filtros (corrigido ref_id)
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
import pkg from 'pg';
const { Pool } = pkg;

/*
SQL sugerido p/ criar tabela de extratos (apenas referência):
CREATE TABLE IF NOT EXISTS extratos (
  id           text PRIMARY KEY,
  ref_id       text NOT NULL,        -- id de origem (banca.id ou pagamento.id)
  nome         text NOT NULL,
  tipo         text NOT NULL,        -- 'deposito' | 'pagamento'
  valor_cents  integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS extratos_created_at_idx ON extratos (created_at DESC);
CREATE INDEX IF NOT EXISTS extratos_tipo_idx       ON extratos (tipo, created_at DESC);
CREATE INDEX IF NOT EXISTS extratos_ref_idx        ON extratos (ref_id);
*/

const {
  PORT = 3000,
  ORIGIN = `http://localhost:3000`,
  STATIC_ROOT,
  ADMIN_USER = 'admin',
  ADMIN_PASSWORD_HASH,
  JWT_SECRET,
  APP_PUBLIC_KEY,
  EFI_CLIENT_ID,
  EFI_CLIENT_SECRET,
  EFI_CERT_PATH,
  EFI_KEY_PATH,
  EFI_BASE_URL,
  EFI_OAUTH_URL,
  EFI_PIX_KEY,
  DATABASE_URL
} = process.env;

const PROD = process.env.NODE_ENV === 'production';

// ===== valida env do login =====
['ADMIN_USER','ADMIN_PASSWORD_HASH','JWT_SECRET'].forEach(k=>{
  if(!process.env[k]) { console.error(`❌ Falta ${k} no .env (login)`); process.exit(1); }
});
// ===== valida env do Efi =====
['EFI_CLIENT_ID','EFI_CLIENT_SECRET','EFI_CERT_PATH','EFI_KEY_PATH','EFI_PIX_KEY','EFI_BASE_URL','EFI_OAUTH_URL']
  .forEach(k => { if(!process.env[k]) { console.error(`❌ Falta ${k} no .env (Efi)`); process.exit(1); } });
// ===== valida PG =====
if (!DATABASE_URL) { console.error('❌ Falta DATABASE_URL no .env'); process.exit(1); }

// ===== paths =====
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, STATIC_ROOT || '..'); // raiz do site

// ===== PG pool =====
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Render PG usa SSL
});
const q = (text, params) => pool.query(text, params);

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

function brlStrToCents(strOriginal) {
  const n = Number.parseFloat(String(strOriginal).replace(',', '.'));
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}

function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function tok(){ return 'tok_' + crypto.randomBytes(18).toString('hex'); }

// ===== store em memória p/ token -> txid (TTL 15 min) =====
/** tokenStore: token -> { txid, createdAt: ms } */
const tokenStore = new Map();
const TOKEN_TTL_MS = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tokenStore) {
    if (now - v.createdAt > TOKEN_TTL_MS) tokenStore.delete(k);
  }
}, 60_000);

// ===== app base =====
const app = express();
app.set('trust proxy', 1);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: ORIGIN, credentials: true }));

// Servir estáticos (site completo)
app.use(express.static(ROOT, { extensions: ['html'] }));

// ===== helpers de auth =====
const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

function signSession(payload) { return jwt.sign(payload, JWT_SECRET, { expiresIn: '2h' }); }
function verifySession(token) { try { return jwt.verify(token, JWT_SECRET); } catch { return null; } }
function randomHex(n=32){ return crypto.randomBytes(n).toString('hex'); }

function setAuthCookies(res, token) {
  const common = { sameSite: 'strict', secure: PROD, maxAge: 2 * 60 * 60 * 1000, path: '/' };
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

// ===== SSE =====
const sseClients = new Set();
function sseSendAll(event, payload = {}) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const msg = `event: ${event}\ndata: ${data}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch {} }
}

// Stream protegido por sessão
app.get('/api/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  res.flushHeaders?.();
  sseClients.add(res);

  const ping = setInterval(() => { try { res.write(`event: ping\ndata: {}\n\n`); } catch {} }, 25000);

  req.on('close', () => { clearInterval(ping); sseClients.delete(res); try { res.end(); } catch {} });
});

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

app.post('/api/auth/logout', (req, res) => { clearAuthCookies(res); return res.json({ ok:true }); });

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
app.get('/health', async (req, res) => {
  try { fs.accessSync(EFI_CERT_PATH); fs.accessSync(EFI_KEY_PATH); await q('select 1'); return res.json({ ok:true, cert:EFI_CERT_PATH, key:EFI_KEY_PATH, pg:true }); }
  catch (e) { return res.status(500).json({ ok:false, error: e.message }); }
});
app.get('/api/pix/ping', async (req, res) => {
  try { const token = await getAccessToken(); return res.json({ ok:true, token:true }); }
  catch (e) { return res.status(500).json({ ok:false, error: e.response?.data || e.message }); }
});

// ===== API PIX (Efi) — NUNCA devolver txid para o front =====
app.post('/api/pix/cob', async (req, res) => {
  try {
    const { nome, cpf, valorCentavos } = req.body || {};
    if (!nome || typeof valorCentavos !== 'number' || valorCentavos < 1000) {
      return res.status(400).json({ error: 'Dados inválidos (mínimo R$ 10,00)' });
    }
    const access = await getAccessToken();
    const valor = (valorCentavos / 100).toFixed(2);

    const payload = { calendario: { expiracao: 3600 }, valor: { original: valor }, chave: EFI_PIX_KEY, infoAdicionais: [{ nome: 'Nome', valor: nome }] };
    if (cpf) {
      const cpfNum = String(cpf).replace(/\D/g, '');
      if (cpfNum.length !== 11) return res.status(400).json({ error: 'cpf_invalido' });
      payload.devedor = { cpf: cpfNum, nome };
    }

    const { data: cob } = await axios.post(`${EFI_BASE_URL}/v2/cob`, payload, { httpsAgent, headers: { Authorization: `Bearer ${access}` } });
    const { txid, loc } = cob;
    const { data: qr } = await axios.get(`${EFI_BASE_URL}/v2/loc/${loc.id}/qrcode`, { httpsAgent, headers: { Authorization: `Bearer ${access}` } });

    const tokenOpaque = tok();
    tokenStore.set(tokenOpaque, { txid, createdAt: Date.now() });

    const emv = qr.qrcode;
    const qrPng = qr.imagemQrcode || (await QRCode.toDataURL(emv));
    res.json({ token: tokenOpaque, emv, qrPng });
  } catch (err) {
    console.error('Erro /api/pix/cob:', err.response?.data || err.message);
    res.status(500).json({ error: 'Falha ao criar cobrança PIX' });
  }
});

// Status consultado por token opaco (mapeado para txid no back)
app.get('/api/pix/status/:token', async (req, res) => {
  try {
    const rec = tokenStore.get(req.params.token);
    if (!rec) return res.status(404).json({ error: 'token_not_found' });
    const access = await getAccessToken();
    const { data } = await axios.get(`${EFI_BASE_URL}/v2/cob/${encodeURIComponent(rec.txid)}`, { httpsAgent, headers: { Authorization: `Bearer ${access}` } });
    res.json({ status: data.status });
  } catch (err) {
    console.error('Erro status:', err.response?.data || err.message);
    res.status(500).json({ error: 'Falha ao consultar status' });
  }
});

app.post('/api/pix/confirmar', async (req, res) => {
  try{
    if (!APP_PUBLIC_KEY) return res.status(403).json({ error:'public_off' });
    const key = req.get('X-APP-KEY');
    if (!key || key !== APP_PUBLIC_KEY) return res.status(401).json({ error:'unauthorized' });

    const { token, nome, valorCentavos, tipo=null, chave=null } = req.body || {};
    if (!token || !nome || typeof valorCentavos !== 'number' || valorCentavos < 1) {
      return res.status(400).json({ error:'dados_invalidos' });
    }

    const rec = tokenStore.get(token);
    if (!rec) return res.status(404).json({ error:'token_not_found' });

    // 1) consulta na Efi usando o txid associado ao token
    const access = await getAccessToken();
    const { data } = await axios.get(`${EFI_BASE_URL}/v2/cob/${encodeURIComponent(rec.txid)}`, { httpsAgent, headers: { Authorization: `Bearer ${access}` } });

    // 2) valida status + valor
    if (data.status !== 'CONCLUIDA') return res.status(409).json({ error:'pix_nao_concluido' });
    const valorEfiCents = brlStrToCents(data?.valor?.original);
    if (valorEfiCents == null) return res.status(500).json({ error:'valor_invalido_efi' });
    if (valorEfiCents !== valorCentavos) return res.status(409).json({ error:'valor_divergente' });

    // 3) insere em bancas
    const id = uid();
    const { rows } = await q(
      `insert into bancas (id, nome, deposito_cents, banca_cents, pix_type, pix_key, created_at)
       values ($1,$2,$3,$4,$5,$6, now())
       returning id, nome,
                 deposito_cents as "depositoCents",
                 banca_cents    as "bancaCents",
                 pix_type       as "pixType",
                 pix_key        as "pixKey",
                 created_at     as "createdAt"`,
      [id, nome, valorCentavos, null, tipo, chave]
    );

    // 3.1) registra no extrato (DEPÓSITO) com ref_id = id da banca
    await q(
      `insert into extratos (id, ref_id, nome, tipo, valor_cents, created_at)
       values ($1,$2,$3,'deposito',$4, now())`,
      [uid(), rows[0].id, nome, valorCentavos]
    );
    sseSendAll('extratos-changed', { reason: 'deposito' });

    // 4) limpa token e notifica SSE
    tokenStore.delete(token);
    sseSendAll('bancas-changed', { reason: 'insert-confirmed' });

    return res.json({ ok:true, ...rows[0] });
  }catch(e){
    console.error('pix/confirmar:', e.response?.data || e.message);
    return res.status(500).json({ error:'falha_confirmar' });
  }
});

// (Opcional) criar banca pública manual também registra no extrato como depósito manual
app.post('/api/public/bancas', async (req, res) => {
  try{
    if (!APP_PUBLIC_KEY) return res.status(403).json({ error:'public_off' });
    const key = req.get('X-APP-KEY');
    if (!key || key !== APP_PUBLIC_KEY) return res.status(401).json({ error:'unauthorized' });

    const { nome, depositoCents, pixType=null, pixKey=null } = req.body || {};
    if (!nome || typeof depositoCents !== 'number' || depositoCents <= 0) {
      return res.status(400).json({ error: 'dados_invalidos' });
    }

    const id = uid();
    const { rows } = await q(
      `insert into bancas (id, nome, deposito_cents, banca_cents, pix_type, pix_key, created_at)
       values ($1,$2,$3,$4,$5,$6, now())
       returning id, nome, deposito_cents as "depositoCents", banca_cents as "bancaCents",
                 pix_type as "pixType", pix_key as "pixKey", created_at as "createdAt"`,
      [id, nome, depositoCents, null, pixType, pixKey]
    );

    // registra depósito manual no extrato (ref_id = id da banca)
    await q(
      `insert into extratos (id, ref_id, nome, tipo, valor_cents, created_at)
       values ($1,$2,$3,'deposito',$4, now())`,
      [uid(), rows[0].id, nome, depositoCents]
    );
    sseSendAll('extratos-changed', { reason: 'deposito-manual' });

    sseSendAll('bancas-changed', { reason: 'insert-public' });
    return res.json(rows[0]);
  }catch(e){
    console.error('public/bancas:', e.message);
    return res.status(500).json({ error:'falha_public' });
  }
});

const areaAuth = [requireAuth];

// ===== BANCAS =====
app.get('/api/bancas', areaAuth, async (req, res) => {
  const { rows } = await q(
    `select id, nome,
            deposito_cents as "depositoCents",
            banca_cents    as "bancaCents",
            pix_type       as "pixType",
            pix_key        as "pixKey",
            created_at     as "createdAt"
     from bancas
     order by created_at desc`
  );
  res.json(rows);
});

app.post('/api/bancas', areaAuth, async (req, res) => {
  const { nome, depositoCents, pixType=null, pixKey=null } = req.body || {};
  if (!nome || typeof depositoCents !== 'number' || depositoCents <= 0) {
    return res.status(400).json({ error: 'dados_invalidos' });
  }
  const id = uid();
  const { rows } = await q(
    `insert into bancas (id, nome, deposito_cents, banca_cents, pix_type, pix_key, created_at)
     values ($1,$2,$3,$4,$5,$6, now())
     returning id, nome, deposito_cents as "depositoCents", banca_cents as "bancaCents",
               pix_type as "pixType", pix_key as "pixKey", created_at as "createdAt"`,
    [id, nome, depositoCents, null, pixType, pixKey]
  );

  sseSendAll('bancas-changed', { reason: 'insert' });
  res.json(rows[0]);
});

app.patch('/api/bancas/:id', areaAuth, async (req, res) => {
  const { bancaCents } = req.body || {};
  if (typeof bancaCents !== 'number' || bancaCents < 0) {
    return res.status(400).json({ error: 'dados_invalidos' });
  }
  const { rows } = await q(
    `update bancas set banca_cents = $2
     where id = $1
     returning id, nome,
               deposito_cents as "depositoCents",
               banca_cents    as "bancaCents",
               pix_type       as "pixType",
               pix_key        as "pixKey",
               created_at     as "createdAt"`,
    [req.params.id, bancaCents]
  );
  if (!rows.length) return res.status(404).json({ error:'not_found' });

  sseSendAll('bancas-changed', { reason: 'update' });
  res.json(rows[0]);
});

app.post('/api/bancas/:id/to-pagamento', areaAuth, async (req, res) => {
  const { bancaCents } = req.body || {};
  const client = await pool.connect();
  try{
    await client.query('begin');

    const sel = await client.query(
      `select id, nome, deposito_cents, banca_cents, pix_type, pix_key, created_at
       from bancas where id = $1 for update`,
      [req.params.id]
    );
    if (!sel.rows.length) { await client.query('rollback'); return res.status(404).json({ error:'not_found' }); }
    const b = sel.rows[0];

    const bancaFinal = (typeof bancaCents === 'number' && bancaCents >= 0)
      ? bancaCents
      : (typeof b.banca_cents === 'number' && b.banca_cents > 0 ? b.banca_cents : b.deposito_cents);

    await client.query(
      `insert into pagamentos (id, nome, pagamento_cents, pix_type, pix_key, status, created_at, paid_at)
       values ($1,$2,$3,$4,$5,'nao_pago',$6,null)`,
      [b.id, b.nome, bancaFinal, b.pix_type, b.pix_key, b.created_at]
    );
    await client.query(`delete from bancas where id = $1`, [b.id]);

    await client.query('commit');

    sseSendAll('bancas-changed', { reason: 'moved' });
    sseSendAll('pagamentos-changed', { reason: 'moved' });

    res.json({ ok:true });
  }catch(e){
    await client.query('rollback');
    console.error('to-pagamento:', e.message);
    res.status(500).json({ error:'falha_mover' });
  }finally{ client.release(); }
});

// ===== PAGAMENTOS <-> BANCAS (voltar) =====
app.post('/api/pagamentos/:id/to-banca', areaAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const sel = await client.query(
      `select id, nome, pagamento_cents, pix_type, pix_key, created_at
         from pagamentos where id = $1 for update`,
      [req.params.id]
    );
    if (!sel.rows.length) { await client.query('rollback'); return res.status(404).json({ error: 'not_found' }); }
    const p = sel.rows[0];

    await client.query(
      `insert into bancas (id, nome, deposito_cents, banca_cents, pix_type, pix_key, created_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [p.id, p.nome, p.pagamento_cents, p.pagamento_cents, p.pix_type, p.pix_key, p.created_at]
    );
    await client.query(`delete from pagamentos where id = $1`, [p.id]);

    await client.query('commit');

    sseSendAll('bancas-changed', { reason: 'moved-back' });
    sseSendAll('pagamentos-changed', { reason: 'moved-back' });

    return res.json({ ok: true });
  } catch (e) {
    await client.query('rollback');
    console.error('to-banca:', e.message);
    return res.status(500).json({ error: 'falha_mover' });
  } finally { client.release(); }
});

app.delete('/api/bancas/:id', areaAuth, async (req, res) => {
  const r = await q(`delete from bancas where id = $1`, [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error:'not_found' });
  sseSendAll('bancas-changed', { reason: 'delete' });
  res.json({ ok:true });
});

app.get('/api/pagamentos', areaAuth, async (req, res) => {
  const { rows } = await q(
    `select id, nome,
            pagamento_cents as "pagamentoCents",
            pix_type        as "pixType",
            pix_key         as "pixKey",
            status,
            created_at      as "createdAt",
            paid_at         as "paidAt"
     from pagamentos
     order by created_at desc`
  );
  res.json(rows);
});

app.patch('/api/pagamentos/:id', areaAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!['pago','nao_pago'].includes(status)) return res.status(400).json({ error: 'status_invalido' });

  // lê antes para checar transição
  const beforeQ = await q(
    `select id, nome, pagamento_cents, status, paid_at from pagamentos where id = $1`,
    [req.params.id]
  );
  if (!beforeQ.rows.length) return res.status(404).json({ error:'not_found' });
  const before = beforeQ.rows[0];

  const { rows } = await q(
    `update pagamentos
       set status = $2,
           paid_at = case when $2 = 'pago' then now() else null end
     where id = $1
     returning id, nome,
               pagamento_cents as "pagamentoCents",
               pix_type as "PixType",
               pix_key  as "pixKey",
               status, created_at as "createdAt", paid_at as "paidAt"`,
    [req.params.id, status]
  );
  if (!rows.length) return res.status(404).json({ error:'not_found' });

  // se mudou de nao_pago -> pago, registra extrato (ref_id = id do pagamento)
  if (status === 'pago' && before.status !== 'pago') {
    await q(
      `insert into extratos (id, ref_id, nome, tipo, valor_cents, created_at)
       values ($1,$2,$3,'pagamento',$4, coalesce($5, now()))`,
      [uid(), rows[0].id, rows[0].nome, rows[0].pagamentoCents, rows[0].paidAt]
    );
    sseSendAll('extratos-changed', { reason: 'pagamento' });
  }

  sseSendAll('pagamentos-changed', { reason: 'update-status' });
  res.json(rows[0]);
});

app.delete('/api/pagamentos/:id', areaAuth, async (req, res) => {
  const r = await q(`delete from pagamentos where id = $1`, [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error:'not_found' });
  sseSendAll('pagamentos-changed', { reason: 'delete' });
  res.json({ ok:true });
});

// ===== EXTRATOS (com filtros) =====
// Suporta: ?tipo=deposito|pagamento  &nome=  &from=YYYY-MM-DD  &to=YYYY-MM-DD
//          &range=today|last7|last30  &limit=200
app.get('/api/extratos', areaAuth, async (req, res) => {
  let { tipo, nome, from, to, range, limit = 200 } = req.query || {};

  const conds = [];
  const params = [];
  let i = 1;

  if (tipo && ['deposito','pagamento'].includes(tipo)) { conds.push(`tipo = $${i++}`); params.push(tipo); }
  if (nome) { conds.push(`lower(nome) LIKE $${i++}`); params.push(`%${String(nome).toLowerCase()}%`); }

  // atalhos de período
  const now = new Date();
  const startOfDay = (d)=>{ const x = new Date(d); x.setHours(0,0,0,0); return x; };
  const addDays = (d,n)=>{ const x = new Date(d); x.setDate(x.getDate()+n); return x; };

  if (range) {
    if (range === 'today') { from = startOfDay(now).toISOString(); to = addDays(startOfDay(now), 1).toISOString(); }
    if (range === 'last7') { from = addDays(startOfDay(now), -6).toISOString(); to = addDays(startOfDay(now), 1).toISOString(); }
    if (range === 'last30'){ from = addDays(startOfDay(now), -29).toISOString(); to = addDays(startOfDay(now), 1).toISOString(); }
  }

  if (from) { conds.push(`created_at >= $${i++}`); params.push(new Date(from)); }
  if (to)   { conds.push(`created_at <  $${i++}`); params.push(new Date(to)); }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const sql = `
    SELECT
      id,
      ref_id        AS "refId",
      nome,
      tipo,
      valor_cents   AS "valorCents",
      created_at    AS "createdAt"
    FROM extratos
    ${where}
    ORDER BY created_at DESC
    LIMIT ${Math.min(parseInt(limit,10)||200, 1000)}
  `;
  const { rows } = await q(sql, params);
  res.json(rows);
});

app.listen(PORT, async () => {
  try{ await q('select 1'); console.log('🗄️  Postgres conectado'); }
  catch(e){ console.error('❌ Postgres falhou:', e.message); }
  console.log(`✅ Server rodando em ${ORIGIN} (NODE_ENV=${process.env.NODE_ENV||'dev'})`);
  console.log(`🗂  Servindo estáticos de: ${ROOT}`);
  console.log(`🔒 /area.html protegido por sessão; login em /login.html`);
});
