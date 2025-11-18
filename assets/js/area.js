// area.js — Bancas, Pagamentos e Extratos (com filtros por período)
// Funciona mesmo se a aba Extratos ainda não existir no HTML (o script não quebra).

const API = window.location.origin; // mesma origem
const qs  = (s, r=document) => r.querySelector(s);
const qsa = (s, r=document) => [...r.querySelectorAll(s)];

function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([$?*|{}\\^])/g, '\\$1') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers||{}) };
  // Envia CSRF em métodos que alteram estado
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

/* debounce simples p/ evitar excesso de refresh */
function debounce(fn, wait = 300){
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

/* ========== Elementos ========== */
const tabBancasEl     = qs('#tab-bancas');
const tabPagamentosEl = qs('#tab-pagamentos');
const tabExtratosEl   = qs('#tab-extratos'); // pode não existir ainda

const tbodyBancas     = qs('#tblBancas tbody');
const tbodyPags       = qs('#tblPagamentos tbody');

// Extratos (podem não existir no HTML ainda)
const tbodyExtDeps    = qs('#tblExtratosDepositos tbody');
const tbodyExtPags    = qs('#tblExtratosPagamentos tbody');

// Buscas
const buscaInput        = qs('#busca');
const buscaExtratoInput = qs('#busca-extrato');

// Filtros da aba Extratos (se existirem no HTML)
const filtroTipo  = qs('#filtro-tipo');    // all | deposito | pagamento
const filtroRange = qs('#filtro-range');   // today | last7 | last30 | custom
const filtroFrom  = qs('#filtro-from');    // date (YYYY-MM-DD)
const filtroTo    = qs('#filtro-to');      // date (YYYY-MM-DD)
const btnFiltrar  = qs('#btn-filtrar');
const btnLimpar   = qs('#btn-limpar');

let TAB = localStorage.getItem('area_tab') || 'bancas';
const STATE = {
  bancas: [],
  pagamentos: [],
  extratos: { depositos: [], pagamentos: [] },
  timers: new Map(), // id => timeoutId (auto-delete pagos)
  filtrosExtratos: { tipo:'all', range:'last30', from:null, to:null },
};

/* ========== Carregamento (preenche STATE) ========== */
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
    params.set('range', f.range); // today | last7 | last30
  } else if (f.range === 'custom') {
    if (f.from) params.set('from', f.from);
    if (f.to)   params.set('to',   f.to);
  } else {
    params.set('range', 'last30'); // padrão
  }

  params.set('limit', '500');
  return params.toString();
}

async function loadExtratos(){
  if (!tabExtratosEl) return STATE.extratos; // se aba não existe no HTML, não busca
  const qsBase = buildExtratosQuery();
  const f = STATE.filtrosExtratos || {};

  if (!f.tipo || f.tipo === 'all') {
    const [deps, pags] = await Promise.all([
      apiFetch(`/api/extratos?${qsBase}&tipo=deposito`),
      apiFetch(`/api/extratos?${qsBase}&tipo=pagamento`),
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
  const lista = STATE.bancas;

  tbodyBancas.innerHTML = lista.length ? lista.map(b => {
    const bancaTxt = typeof b.bancaCents === 'number' ? fmtBRL(b.bancaCents) : '';
    // [ADD mensagem] checa se há message
    const hasMsg = !!(b.message && String(b.message).trim());
    return `
      <tr data-id="${b.id}">
        <td>${esc(b.nome)}</td>
        <td>${fmtBRL(b.depositoCents||0)}</td>
        <td>
          <input type="text" class="input input-money" data-role="banca" data-id="${b.id}" placeholder="R$ 0,00" value="${bancaTxt}">
        </td>
        <td class="col-acoes">
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn--primary" data-action="to-pagamento" data-id="${b.id}">Pagamento</button>
            <!-- [ADD mensagem] botão Ver mensagem -->
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
    // [ADD mensagem] checa se há message
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

            <!-- Voltar para Bancas -->
            <button class="btn btn--primary" data-action="to-banca" data-id="${p.id}">Bancas</button>

            <button class="btn btn--primary" data-action="fazer-pix" data-id="${p.id}">Fazer PIX</button>
            <!-- [ADD mensagem] botão Ver mensagem -->
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

  // Depósitos
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

  // Pagamentos
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

  // filtro local por nome (input da aba extratos)
  const q = (buscaExtratoInput?.value || '').trim().toLowerCase();
  if (q) {
    if (tbodyExtDeps) filtrarTabela(tbodyExtDeps, q);
    if (tbodyExtPags) filtrarTabela(tbodyExtPags, q);
  }

  // se existir select de tipo, oculta/mostra seções
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

/* ========== AÇÕES PRINCIPAIS (API) ========== */
async function setTab(tab){
  TAB = tab;
  localStorage.setItem('area_tab', tab);
  qsa('.nav-btn').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  await refresh(); // carrega listas atualizadas ao trocar de aba
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
  // 1) Se houver edição no input, salva via PATCH antes de mover
  const inp = getBancaInputById(id);
  if (inp) {
    const cents = toCents(inp.value);
    await apiFetch(`/api/bancas/${encodeURIComponent(id)}`, {
      method:'PATCH',
      body: JSON.stringify({ bancaCents: cents })
    });
  }

  // 2) Agora move para pagamentos
  await apiFetch(`/api/bancas/${encodeURIComponent(id)}/to-pagamento`, { method:'POST' });

  // 3) NÃO muda de aba — recarrega silenciosamente as listas
  await Promise.all([loadBancas(), loadPagamentos()]);
  render();
  setupAutoDeleteTimers();
}

// mover de Pagamentos -> Bancas (preserva valor manual como bancaCents)
async function toBanca(id){
  await apiFetch(`/api/pagamentos/${encodeURIComponent(id)}/to-banca`, { method:'POST' });
  await Promise.all([loadPagamentos(), loadBancas()]);
  render();
  // se havia timer de auto-delete, cancela
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
    // agenda auto delete em 3 minutos (considerando paidAt do servidor)
    scheduleAutoDelete(item);
  } else {
    const t = STATE.timers.get(id);
    if (t){ clearTimeout(t); STATE.timers.delete(id); }
  }
}

/* ========== Auto delete de "pago" em 3 minutos ========== */
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

/* ========== Modal simples “Fazer PIX” ========== */
function abrirPixModal(id){
  const p = STATE.pagamentos.find(x=>x.id===id);
  if(!p) return;
  let dlg = qs('#payModal');
  if(!dlg){
    dlg = document.createElement('dialog');
    dlg.id = 'payModal';
    dlg.style.border='0'; dlg.style.padding='0'; dlg.style.background='transparent';
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

/* ========== [ADD mensagem] Modal “Ver mensagem” ========== */
let msgModalEl = null;
function ensureMsgModal(){
  if (msgModalEl) return msgModalEl;
  const dlg = document.createElement('dialog');
  dlg.id = 'msgModal';
  dlg.style.border='0'; dlg.style.padding='0'; dlg.style.background='transparent';
  const box = document.createElement('div');
  box.style.width='min(94vw,520px)';
  box.style.background='linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03))';
  box.style.border='1px solid rgba(255,255,255,.12)';
  box.style.borderRadius='14px';
  box.style.boxShadow='0 28px 80px rgba(0,0,0,.55)';
  box.style.padding='16px'; box.style.color='#e7e9f3';
  box.innerHTML = `
    <h3 style="margin:0 0 8px;font-weight:800">Mensagem</h3>
    <p id="msgText" style="white-space:pre-wrap;margin:0 0 12px;color:#cfd2e8"></p>
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

/* ========== MENU FLUTUANTE (PORTAL) — Pago / Não pago ========== */
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

  // marca a atual
  qsa('.status-item', m).forEach(b=>{
    b.classList.toggle('active', b.dataset.value === current);
  });

  // posiciona (abre pra cima se faltar espaço)
  const r = anchorBtn.getBoundingClientRect();
  m.style.display = 'block';
  m.style.visibility = 'hidden';
  const mh = m.getBoundingClientRect().height;
  const mw = m.getBoundingClientRect().width;
  m.style.visibility = '';

  const spaceBelow = window.innerHeight - r.bottom;
  let top = r.bottom + 6;
  if(spaceBelow < mh + 8){
    top = r.top - mh - 6;  // dropup
  }
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

// abre/fecha via clique
document.addEventListener('click', (e)=>{
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

// [ADD mensagem] handler global para abrir o modal de mensagem
document.addEventListener('click', (e)=>{
  const btn = e.target.closest('button[data-action="ver-msg"]');
  if(!btn) return;
  const id = btn.dataset.id;
  // tenta achar primeiro em bancas, depois em pagamentos
  const b = STATE.bancas.find(x=>x.id===id);
  const p = STATE.pagamentos.find(x=>x.id===id);
  const msg = (b?.message ?? p?.message) || '';
  abrirMensagem(msg);
});

// rolar/resize fecha menu
['scroll','resize'].forEach(ev=>{
  window.addEventListener(ev, hideStatusMenu, {passive:true});
});
qsa('.table-wrap').forEach(w=> w.addEventListener('scroll', hideStatusMenu, {passive:true}));

/* ========== EVENTOS GLOBAIS ========== */
qsa('.nav-btn').forEach(btn=>{
  btn.addEventListener('click', ()=> setTab(btn.dataset.tab));
});

document.addEventListener('click', (e)=>{
  const btn = e.target.closest('button[data-action]');
  if(!btn) return;

  const {action, id} = btn.dataset;
  if(action==='to-pagamento') return toPagamento(id).catch(console.error);
  if(action==='del-banca')    return deleteBanca(id).catch(console.error);
  if(action==='fazer-pix')    return abrirPixModal(id);
  if(action==='del-pag')      return deletePagamento(id).catch(console.error);
  if(action==='to-banca')     return toBanca(id).catch(console.error); // novo
});

// edição da Banca (R$)
document.addEventListener('input', (e)=>{
  const inp = e.target.closest('input[data-role="banca"]');
  if(!inp) return;
  let v = inp.value.replace(/\D/g,'');
  if(!v){ inp.value=''; return; }
  v = v.replace(/^0+/, '');
  if(v.length<3) v = v.padStart(3,'0');
  inp.value = fmtBRL(parseInt(v,10));
});

// salvar PATCH ao sair do campo
document.addEventListener('blur', async (e)=>{
  const inp = e.target.closest('input[data-role="banca"]');
  if(!inp) return;
  const id = inp.dataset.id;
  const cents = toCents(inp.value);
  try{
    await apiFetch(`/api/bancas/${encodeURIComponent(id)}`, {
      method:'PATCH',
      body: JSON.stringify({ bancaCents: cents })
    });
    await loadBancas();
    render();
  }catch(err){
    console.error(err);
  }
}, true);

// busca (bancas/pagamentos)
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

// ===== Filtros da aba Extratos =====
function readExtratoFiltersFromDOM(){
  const f = STATE.filtrosExtratos;
  if (filtroTipo)  f.tipo  = filtroTipo.value || 'all';
  if (filtroRange) f.range = filtroRange.value || 'last30';
  if (filtroFrom)  f.from  = filtroFrom.value || null;  // YYYY-MM-DD
  if (filtroTo)    f.to    = filtroTo.value   || null;  // YYYY-MM-DD
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
  // mesma origem; cookies inclusos automaticamente em mesma origem
  es = new EventSource(`${API}/api/stream`);

  const softRefreshBancas = debounce(async () => {
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
  es.addEventListener('ping', () => {}); // keepalive

  es.onerror = () => {
    try { es.close(); } catch {}
    setTimeout(startStream, 3000); // backoff simples
  };
}

/* ========== start ========== */
document.addEventListener('DOMContentLoaded', async ()=>{
  qsa('.nav-btn').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.tab === TAB);
  });

  // Ajusta UI dos filtros (se existir)
  applyExtratoFiltersUIRules();
  readExtratoFiltersFromDOM();

  // carrega as listas inicialmente (as 3, se a aba extratos existir)
  const loaders = [loadBancas(), loadPagamentos()];
  if (tabExtratosEl) loaders.push(loadExtratos());
  await Promise.all(loaders);

  setupAutoDeleteTimers();
  render();

  // liga o “ao vivo”
  startStream();
});
