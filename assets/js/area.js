// assets/js/area.js — completo
// Bancas, Pagamentos, Extratos + Mensagens + correções de foco/refresh

const API = window.location.origin;
const qs  = (s, r=document) => r.querySelector(s);
const qsa = (s, r=document) => [...r.querySelectorAll(s)];

function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([$?*|{}\\^])/g, '\\$1') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers||{}) };
  if (['POST','PUT','PATCH','DELETE'].includes((opts.method||'GET').toUpperCase())) {
    const csrf = getCookie('csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const res = await fetch(`${API}${path}`, { credentials:'include', ...opts, headers });
  if (!res.ok) {
    let err;
    try { err = await res.json(); } catch {}
    throw new Error(err?.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

const fmtBRL  = (c)=> (c/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const toCents = (s)=> { const d = (s||'').toString().replace(/\D/g,''); return d ? parseInt(d,10) : 0; };
const esc     = (s='') => s.replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));

function debounce(fn, wait = 300){
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

/* ========== Elementos ========== */
const tabBancasEl     = qs('#tab-bancas');
const tabPagamentosEl = qs('#tab-pagamentos');
const tabExtratosEl   = qs('#tab-extratos');

const tbodyBancas     = qs('#tblBancas tbody');
const tbodyPags       = qs('#tblPagamentos tbody');

const tbodyExtDeps    = qs('#tblExtratosDepositos tbody');
const tbodyExtPags    = qs('#tblExtratosPagamentos tbody');

const buscaInput        = qs('#busca');
const buscaExtratoInput = qs('#busca-extrato');

const filtroTipo  = qs('#filtro-tipo');
const filtroRange = qs('#filtro-range');
const filtroFrom  = qs('#filtro-from');
const filtroTo    = qs('#filtro-to');
const btnFiltrar  = qs('#btn-filtrar');
const btnLimpar   = qs('#btn-limpar');

/* ========== Estado ========== */
let TAB = localStorage.getItem('area_tab') || 'bancas';
const STATE = {
  bancas: [],
  pagamentos: [],
  extratos: { depositos: [], pagamentos: [] },
  timers: new Map(),            // id => timeoutId (auto-delete pagos)
  filtrosExtratos: { tipo:'all', range:'last30', from:null, to:null },
  editingBancaId: null          // evita re-render enquanto editando
};

/* ========== Carregamento ========== */
async function loadBancas() {
  const list = await apiFetch(`/api/bancas`);
  STATE.bancas = list.sort((a,b)=> (a.createdAt||'') < (b.createdAt||'') ? 1 : -1);
  return STATE.bancas;
}
async function loadPagamentos() {
  const list = await apiFetch(`/api/pagamentos`);
  STATE.pagamentos = list.sort((a,b)=> (a.createdAt||'') < (b.createdAt||'') ? 1 : -1);
  return STATE.pagamentos;
}

/* ===== Extratos ===== */
function buildExtratosQuery(){
  const f = STATE.filtrosExtratos || {};
  const params = new URLSearchParams();
  if (f.tipo && f.tipo !== 'all') params.set('tipo', f.tipo);
  if (f.range && f.range !== 'custom') {
    params.set('range', f.range);
  } else if (f.range === 'custom') {
    if (f.from) params.set('from', f.from);
    if (f.to)   params.set('to',   f.to);
  } else {
    params.set('range', 'last30');
  }
  params.set('limit', '500');
  return params.toString();
}

async function loadExtratos(){
  if (!tabExtratosEl) return STATE.extratos;
  const qsBase = buildExtratosQuery();
  const f = STATE.filtrosExtratos || {};
  if (!f.tipo || f.tipo === 'all') {
    const [deps, pags] = await Promise.all([
      apiFetch(`/api/extratos?${qsBase}&tipo=deposito`),
      apiFetch(`/api/extratos?${qsBase}&tipo=pagamento`)
    ]);
    STATE.extratos.depositos  = deps;
    STATE.extratos.pagamentos = pags;
  } else if (f.tipo === 'deposito') {
    STATE.extratos.depositos  = await apiFetch(`/api/extratos?${qsBase}&tipo=deposito`);
    STATE.extratos.pagamentos = [];
  } else if (f.tipo === 'pagamento') {
    STATE.extratos.depositos  = [];
    STATE.extratos.pagamentos = await apiFetch(`/api/extratos?${qsBase}&tipo=pagamento`);
  }
  return STATE.extratos;
}

/* ========== Render ========== */
async function render(){
  if (TAB==='bancas'){
    tabBancasEl?.classList.add('show');
    tabPagamentosEl?.classList.remove('show');
    tabExtratosEl?.classList.remove('show');
    renderBancas();
  } else if (TAB==='pagamentos'){
    tabPagamentosEl?.classList.add('show');
    tabBancasEl?.classList.remove('show');
    tabExtratosEl?.classList.remove('show');
    renderPagamentos();
  } else if (TAB==='extratos'){
    tabExtratosEl?.classList.add('show');
    tabBancasEl?.classList.remove('show');
    tabPagamentosEl?.classList.remove('show');
    renderExtratos();
  }
}

function renderBancas(){
  if (!tbodyBancas) return;

  // Se está editando, não destruir o DOM da linha para preservar foco
  const focused = document.activeElement;
  const isEditing = !!focused?.matches?.('input[data-role="banca"]');
  if (isEditing) return;

  const lista = STATE.bancas;
  tbodyBancas.innerHTML = lista.length ? lista.map(b => {
    const bancaTxt = typeof b.bancaCents === 'number' ? fmtBRL(b.bancaCents) : '';
    const hasMsg = !!(b.message && String(b.message).trim());
    return `
      <tr data-id="${b.id}">
        <td>${esc(b.nome)}</td>
        <td>${fmtBRL(b.depositoCents||0)}</td>
        <td>
          <input type="text"
                 class="input input-money"
                 data-role="banca"
                 data-id="${b.id}"
                 placeholder="R$ 0,00"
                 value="${bancaTxt}">
        </td>
        <td class="col-acoes">
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn--primary" data-action="to-pagamento" data-id="${b.id}">Pagamento</button>
            <button class="btn" data-action="ver-msg" data-id="${b.id}" ${hasMsg?'':'disabled'}>Ver mensagem</button>
            <button class="btn btn--danger"  data-action="del-banca"    data-id="${b.id}">Excluir</button>
          </div>
        </td>
      </tr>`;
  }).join('') : `<tr><td colspan="4" class="muted" style="padding:14px">Sem registros ainda.</td></tr>`;

  filtrarTabela(tbodyBancas, buscaInput?.value || '');
}

function renderPagamentos(){
  if (!tbodyPags) return;
  const lista = STATE.pagamentos;
  tbodyPags.innerHTML = lista.length ? lista.map(p => {
    const isPago = p.status === 'pago';
    const statusTxt = isPago ? 'Pago' : 'Não pago';
    const statusCls = isPago ? 'status--pago' : 'status--nao';
    const hasMsg = !!(p.message && String(p.message).trim());
    return `
      <tr data-id="${p.id}">
        <td>${esc(p.nome)}</td>
        <td>${fmtBRL(p.pagamentoCents||0)}</td>
        <td class="col-acoes">
          <div style="display:flex;gap:8px;align-items:center">
            <button type="button"
                    class="status-btn ${statusCls}"
                    data-action="status-open"
                    data-id="${p.id}"
                    data-status="${p.status}">
              ${statusTxt} <span class="caret"></span>
            </button>
            <button class="btn btn--primary" data-action="to-banca" data-id="${p.id}">Bancas</button>
            <button class="btn btn--primary" data-action="fazer-pix" data-id="${p.id}">Fazer PIX</button>
            <button class="btn" data-action="ver-msg" data-id="${p.id}" ${hasMsg?'':'disabled'}>Ver mensagem</button>
            <button class="btn btn--danger"  data-action="del-pag"   data-id="${p.id}">Excluir</button>
          </div>
        </td>
      </tr>`;
  }).join('') : `<tr><td colspan="3" class="muted" style="padding:14px">Sem registros ainda.</td></tr>`;

  filtrarTabela(tbodyPags, buscaInput?.value || '');
}

function renderExtratos(){
  if (!tabExtratosEl) return;

  if (tbodyExtDeps) {
    const L1 = STATE.extratos.depositos;
    tbodyExtDeps.innerHTML = L1.length ? L1.map(x => `
      <tr>
        <td>${esc(x.nome)}</td>
        <td>${fmtBRL(x.valorCents||0)}</td>
        <td>${new Date(x.createdAt).toLocaleString('pt-BR')}</td>
      </tr>
    `).join('') : `<tr><td colspan="3" class="muted" style="padding:14px">Sem depósitos ainda.</td></tr>`;
  }

  if (tbodyExtPags) {
    const L2 = STATE.extratos.pagamentos;
    tbodyExtPags.innerHTML = L2.length ? L2.map(x => `
      <tr>
        <td>${esc(x.nome)}</td>
        <td>${fmtBRL(x.valorCents||0)}</td>
        <td>${new Date(x.createdAt).toLocaleString('pt-BR')}</td>
      </tr>
    `).join('') : `<tr><td colspan="3" class="muted" style="padding:14px">Sem pagamentos ainda.</td></tr>`;
  }

  const q = (buscaExtratoInput?.value || '').trim().toLowerCase();
  if (q) {
    if (tbodyExtDeps) filtrarTabela(tbodyExtDeps, q);
    if (tbodyExtPags) filtrarTabela(tbodyExtPags, q);
  }

  if (filtroTipo && tabExtratosEl) {
    const t = (filtroTipo.value||'all');
    const cardDeps = tabExtratosEl.querySelector('[data-card="deps"]') || tabExtratosEl.querySelector('#tblExtratosDepositos')?.closest('.card');
    const cardPags = tabExtratosEl.querySelector('[data-card="pags"]') || tabExtratosEl.querySelector('#tblExtratosPagamentos')?.closest('.card');
    if (cardDeps && cardPags) {
      cardDeps.style.display = (t==='all' || t==='deposito') ? '' : 'none';
      cardPags.style.display = (t==='all' || t==='pagamento') ? '' : 'none';
    }
  }
}

/* ========== AÇÕES ========== */
async function setTab(tab){
  TAB = tab;
  localStorage.setItem('area_tab', tab);
  qsa('.nav-btn').forEach(btn=> btn.classList.toggle('active', btn.dataset.tab === tab));
  await refresh();
}

async function refresh(){
  if (TAB==='bancas'){
    await loadBancas();
  } else if (TAB==='pagamentos'){
    await loadPagamentos();
  } else if (TAB==='extratos'){
    await loadExtratos();
  }
  render();
}

function getBancaInputById(id){
  return document.querySelector(`input[data-role="banca"][data-id="${CSS.escape(id)}"]`);
}

async function toPagamento(id){
  const inp = getBancaInputById(id);
  if (inp) {
    const cents = toCents(inp.value);
    await apiFetch(`/api/bancas/${encodeURIComponent(id)}`, {
      method:'PATCH',
      body: JSON.stringify({ bancaCents: cents })
    });
  }
  await apiFetch(`/api/bancas/${encodeURIComponent(id)}/to-pagamento`, { method:'POST' });
  await Promise.all([loadBancas(), loadPagamentos()]);
  render();
  setupAutoDeleteTimers();
}

async function toBanca(id){
  await apiFetch(`/api/pagamentos/${encodeURIComponent(id)}/to-banca`, { method:'POST' });
  await Promise.all([loadPagamentos(), loadBancas()]);
  render();
  const t = STATE.timers.get(id);
  if (t){ clearTimeout(t); STATE.timers.delete(id); }
}

async function deleteBanca(id){
  await apiFetch(`/api/bancas/${encodeURIComponent(id)}`, { method:'DELETE' });
  await loadBancas();
  render();
}

async function deletePagamento(id){
  await apiFetch(`/api/pagamentos/${encodeURIComponent(id)}`, { method:'DELETE' });
  await loadPagamentos();
  render();
  const t = STATE.timers.get(id);
  if (t){ clearTimeout(t); STATE.timers.delete(id); }
}

async function setStatus(id, value){
  const body = JSON.stringify({ status: value });
  await apiFetch(`/api/pagamentos/${encodeURIComponent(id)}`, { method:'PATCH', body });
  await loadPagamentos();
  render();

  const item = STATE.pagamentos.find(x=>x.id===id);
  if (!item) return;
  if (value === 'pago') {
    scheduleAutoDelete(item);
  } else {
    const t = STATE.timers.get(id);
    if (t){ clearTimeout(t); STATE.timers.delete(id); }
  }
}

/* ========== Auto delete 3 min ========== */
function scheduleAutoDelete(item){
  const { id, paidAt } = item;
  if (!paidAt) return;
  const left = (new Date(paidAt).getTime() + 3*60*1000) - Date.now();
  const prev = STATE.timers.get(id);
  if (prev) clearTimeout(prev);
  if (left <= 0) { deletePagamento(id).catch(()=>{}); return; }
  const tid = setTimeout(()=> deletePagamento(id).catch(()=>{}), left);
  STATE.timers.set(id, tid);
}

function setupAutoDeleteTimers(){
  STATE.timers.forEach(t=> clearTimeout(t));
  STATE.timers.clear();
  STATE.pagamentos.forEach(p=>{
    if (p.status === 'pago' && p.paidAt) scheduleAutoDelete(p);
  });
}

/* ========== Modal “Fazer PIX” ========== */
function abrirPixModal(id){
  const p = STATE.pagamentos.find(x=>x.id===id);
  if(!p) return;
  let dlg = qs('#payModal');
  if(!dlg){
    dlg = document.createElement('dialog');
    dlg.id = 'payModal';
    dlg.style.border='0'; dlg.style.padding='0'; dlg.style.background='transparent';

    // Backdrop suave
    injectOnce('payModalBackdropCSS', `
      #payModal::backdrop{ background: rgba(8,12,26,.65); backdrop-filter: blur(6px) saturate(.9); }
    `);

    const box = document.createElement('div');
    box.style.width='min(94vw,520px)';
    box.style.background='linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03))';
    box.style.border='1px solid rgba(255,255,255,.12)';
    box.style.borderRadius='14px';
    box.style.boxShadow='0 28px 80px rgba(0,0,0,.55)';
    box.style.padding='16px'; box.style.color='#e7e9f3';
    box.innerHTML = `
      <h3 style="margin:0 0 6px">Fazer PIX para <span data-field="nome"></span></h3>
      <p class="muted" style="margin:0 0 10px">Chave (<span data-field="tipo"></span>)</p>
      <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center">
        <input class="input" data-field="key" readonly>
        <button class="btn btn--primary" data-action="copy">Copiar</button>
      </div>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:10px">
        <button class="btn btn--ghost" data-action="close">Fechar</button>
      </div>
    `;
    dlg.appendChild(box);
    document.body.appendChild(dlg);

    dlg.addEventListener('click', (e)=>{
      const b = e.target.closest('[data-action]');
      if(!b) return;
      if(b.dataset.action==='close') dlg.close();
      if(b.dataset.action==='copy'){
        const input = dlg.querySelector('[data-field="key"]');
        if(input?.value) navigator.clipboard.writeText(input.value);
      }
    });
  }
  qs('[data-field="nome"]', dlg).textContent = p.nome;
  qs('[data-field="tipo"]', dlg).textContent = (p.pixType||'—').toUpperCase();
  qs('[data-field="key"]',  dlg).value      = p.pixKey || '—';
  dlg.showModal();
}

/* ========== Modal “Ver mensagem” (com backdrop blur) ========== */
let msgModalEl = null;
function injectOnce(id, css){
  if (document.getElementById(id)) return;
  const st = document.createElement('style');
  st.id = id;
  st.textContent = css;
  document.head.appendChild(st);
}
function ensureMsgModal(){
  if (msgModalEl) return msgModalEl;

  injectOnce('msgModalBackdropCSS', `
    #msgModal::backdrop{ background: rgba(8,12,26,.65); backdrop-filter: blur(6px) saturate(.9); }
    #msgModal .box h3{ margin:0 0 8px; font-weight:800 }
    #msgModal .box p{ margin:0 0 12px; color:#cfd2e8; white-space:pre-wrap; line-height:1.5 }
  `);

  const dlg = document.createElement('dialog');
  dlg.id = 'msgModal';
  dlg.style.border='0'; dlg.style.padding='0'; dlg.style.background='transparent';

  const box = document.createElement('div');
  box.className = 'box';
  box.style.width='min(94vw,560px)';
  box.style.background='linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.05))';
  box.style.border='1px solid rgba(255,255,255,.18)';
  box.style.borderRadius='16px';
  box.style.boxShadow='0 30px 90px rgba(0,0,0,.65), 0 0 0 1px rgba(255,255,255,.04)';
  box.style.padding='18px';
  box.style.color='#e7e9f3';
  box.innerHTML = `
    <h3>Mensagem</h3>
    <p id="msgText"></p>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn--ghost" data-action="close-msg">Fechar</button>
    </div>
  `;
  dlg.appendChild(box);
  document.body.appendChild(dlg);

  dlg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action="close-msg"]');
    if (b) dlg.close();
  });

  msgModalEl = dlg;
  return dlg;
}
function abrirMensagem(texto){
  const dlg = ensureMsgModal();
  const p = dlg.querySelector('#msgText');
  p.textContent = (texto && String(texto).trim()) ? String(texto) : '(sem mensagem)';
  dlg.showModal();
}

/* ========== Menu flutuante status ========== */
let statusMenuEl = null;
let statusMenuId = null;

function ensureStatusMenu(){
  if(statusMenuEl) return statusMenuEl;
  const el = document.createElement('div');
  el.className = 'status-float';
  el.innerHTML = `
    <button class="status-item pago" data-value="pago">Pago</button>
    <button class="status-item nao"  data-value="nao_pago">Não pago</button>
  `;
  document.body.appendChild(el);

  el.addEventListener('click', (e)=>{
    const btn = e.target.closest('button.status-item');
    if(!btn) return;
    if(statusMenuId){
      setStatus(statusMenuId, btn.dataset.value).catch(console.error);
    }
    hideStatusMenu();
  });

  statusMenuEl = el;
  return el;
}

function showStatusMenu(anchorBtn, id, current){
  const m = ensureStatusMenu();
  statusMenuId = id;

  qsa('.status-item', m).forEach(b=> b.classList.toggle('active', b.dataset.value === current));

  const r = anchorBtn.getBoundingClientRect();
  m.style.display = 'block';
  m.style.visibility = 'hidden';
  const mh = m.getBoundingClientRect().height;
  const mw = m.getBoundingClientRect().width;
  m.style.visibility = '';

  const spaceBelow = window.innerHeight - r.bottom;
  let top = r.bottom + 6;
  if(spaceBelow < mh + 8){ top = r.top - mh - 6; }
  const left = Math.min(Math.max(8, r.left), window.innerWidth - mw - 8);

  m.style.top  = `${Math.round(top)}px`;
  m.style.left = `${Math.round(left)}px`;
  m.classList.add('show');
}

function hideStatusMenu(){
  if(statusMenuEl){
    statusMenuEl.classList.remove('show');
    statusMenuEl.style.display = 'none';
  }
  statusMenuId = null;
}

/* ========== Listeners globais ========== */
document.addEventListener('click', (e)=>{
  // status menu
  const openBtn = e.target.closest('button[data-action="status-open"]');
  if(openBtn){
    const id = openBtn.dataset.id;
    const current = openBtn.dataset.status || 'nao_pago';
    hideStatusMenu();
    showStatusMenu(openBtn, id, current);
    e.stopPropagation();
    return;
  }
  if(!e.target.closest('.status-float')) hideStatusMenu();
});

// Abrir mensagem
document.addEventListener('click', (e)=>{
  const btn = e.target.closest('button[data-action="ver-msg"]');
  if(!btn) return;
  const id = btn.dataset.id;
  const b = STATE.bancas.find(x=>x.id===id);
  const p = STATE.pagamentos.find(x=>x.id===id);
  const msg = (b?.message ?? p?.message) || '';
  abrirMensagem(msg);
});

// Ações
document.addEventListener('click', (e)=>{
  const btn = e.target.closest('button[data-action]');
  if(!btn) return;
  const {action, id} = btn.dataset;
  if(action==='to-pagamento') return toPagamento(id).catch(console.error);
  if(action==='del-banca')    return deleteBanca(id).catch(console.error);
  if(action==='fazer-pix')    return abrirPixModal(id);
  if(action==='del-pag')      return deletePagamento(id).catch(console.error);
  if(action==='to-banca')     return toBanca(id).catch(console.error);
});

/* ========== Input de Banca (máscara + salvar sem quebrar foco) ========== */
document.addEventListener('focusin', (e)=>{
  const inp = e.target.closest('input[data-role="banca"]');
  if(!inp) return;
  STATE.editingBancaId = inp.dataset.id || null;
});
document.addEventListener('focusout', (e)=>{
  const inp = e.target.closest('input[data-role="banca"]');
  if(!inp) return;
  // se o foco foi para outro controle de ação na mesma linha, ainda assim salvamos,
  // mas NÃO fazemos render imediato para não "expulsar" o foco.
  saveBancaInline(inp).catch(console.error).finally(()=>{
    // mantém STATE.editingBancaId somente se ainda estiver focado em outro input de banca
    const still = document.activeElement?.closest?.('input[data-role="banca"]');
    STATE.editingBancaId = still ? still.dataset.id : null;
  });
}, true);

async function saveBancaInline(inp){
  const id = inp.dataset.id;
  const cents = toCents(inp.value);
  // Atualiza estado local
  const item = STATE.bancas.find(x=>x.id===id);
  if (item) item.bancaCents = cents;

  // PATCH sem re-render imediato
  try{
    await apiFetch(`/api/bancas/${encodeURIComponent(id)}`, {
      method:'PATCH',
      body: JSON.stringify({ bancaCents: cents })
    });
  }catch(err){ console.error(err); }
}

document.addEventListener('input', (e)=>{
  const inp = e.target.closest('input[data-role="banca"]');
  if(!inp) return;
  let v = inp.value.replace(/\D/g,'');
  if(!v){ inp.value=''; return; }
  v = v.replace(/^0+/, '');
  if(v.length<3) v = v.padStart(3,'0');
  inp.value = fmtBRL(parseInt(v,10));
  // não dispara render aqui
});

document.addEventListener('keydown', (e)=>{
  const inp = e.target.closest('input[data-role="banca"]');
  if(!inp) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    inp.blur(); // dispara o saveBancaInline
  }
});

/* ========== Busca tabelas ========== */
function filtrarTabela(tbody, q){
  if(!tbody) return;
  const query = (q||'').trim().toLowerCase();
  [...tbody.querySelectorAll('tr')].forEach(tr=>{
    tr.style.display = tr.textContent.toLowerCase().includes(query) ? '' : 'none';
  });
}
buscaInput?.addEventListener('input', ()=>{
  const q = buscaInput.value || '';
  if (TAB==='bancas') filtrarTabela(tbodyBancas, q);
  else                filtrarTabela(tbodyPags,   q);
});

/* ========== Filtros Extratos ========== */
function readExtratoFiltersFromDOM(){
  const f = STATE.filtrosExtratos;
  if (filtroTipo)  f.tipo  = filtroTipo.value || 'all';
  if (filtroRange) f.range = filtroRange.value || 'last30';
  if (filtroFrom)  f.from  = filtroFrom.value || null;
  if (filtroTo)    f.to    = filtroTo.value   || null;
}
function applyExtratoFiltersUIRules(){
  if (!filtroRange) return;
  const isCustom = filtroRange.value === 'custom';
  if (filtroFrom) filtroFrom.disabled = !isCustom;
  if (filtroTo)   filtroTo.disabled   = !isCustom;
}

buscaExtratoInput?.addEventListener('input', ()=>{ if (TAB==='extratos') renderExtratos(); });
filtroTipo?.addEventListener('change',  async ()=>{ readExtratoFiltersFromDOM(); await loadExtratos(); renderExtratos(); });
filtroRange?.addEventListener('change', async ()=>{ applyExtratoFiltersUIRules(); readExtratoFiltersFromDOM(); await loadExtratos(); renderExtratos(); });
btnFiltrar?.addEventListener('click',   async ()=>{ readExtratoFiltersFromDOM(); await loadExtratos(); renderExtratos(); });
btnLimpar?.addEventListener('click',    async ()=>{
  if (filtroTipo)  filtroTipo.value  = 'all';
  if (filtroRange) filtroRange.value = 'last30';
  if (filtroFrom)  filtroFrom.value  = '';
  if (filtroTo)    filtroTo.value    = '';
  applyExtratoFiltersUIRules();
  readExtratoFiltersFromDOM();
  await loadExtratos();
  renderExtratos();
});

/* ========== SSE (ao vivo) ========== */
let es = null;
function startStream(){
  if (es) try { es.close(); } catch {}
  es = new EventSource(`${API}/api/stream`);

  const softRefreshBancas = debounce(async () => {
    // Se estou editando uma banca, não destrua a linha
    const focused = document.activeElement;
    const isEditing = !!focused?.matches?.('input[data-role="banca"]');
    if (isEditing) return;
    await loadBancas();
    if (TAB === 'bancas') render();
  }, 200);

  const softRefreshPags = debounce(async () => {
    await loadPagamentos();
    if (TAB === 'pagamentos') {
      render();
      setupAutoDeleteTimers();
    }
  }, 200);

  const softRefreshExt = debounce(async () => {
    await loadExtratos();
    if (TAB === 'extratos') renderExtratos();
  }, 200);

  es.addEventListener('bancas-changed',     softRefreshBancas);
  es.addEventListener('pagamentos-changed', softRefreshPags);
  es.addEventListener('extratos-changed',   softRefreshExt);
  es.addEventListener('ping', () => {});

  es.onerror = () => {
    try { es.close(); } catch {}
    setTimeout(startStream, 3000);
  };
}

/* ========== start ========== */
document.addEventListener('DOMContentLoaded', async ()=>{
  // ativa o botão atual
  qsa('.nav-btn').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.tab === TAB);
    // garante que o clique troque de aba
    btn.addEventListener('click', ()=> setTab(btn.dataset.tab));
  });

  applyExtratoFiltersUIRules();
  readExtratoFiltersFromDOM();

  const loaders = [loadBancas(), loadPagamentos()];
  if (tabExtratosEl) loaders.push(loadExtratos());
  await Promise.all(loaders);

  setupAutoDeleteTimers();
  render();

  startStream();
});
