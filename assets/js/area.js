/* =========================================
   area.js — Bancas & Pagamentos (via API) suave
   - Fade entre abas SEM “piscadas”
   - Mostra próxima aba só depois dos dados
   - Mantém seus recursos: status pago/nao, auto-delete, fazer PIX etc.
   ========================================= */

/* ========== Utils base ========== */
const API = window.location.origin;
const qs  = (s, r=document) => r.querySelector(s);
const qsa = (s, r=document) => [...r.querySelectorAll(s)];

function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([$?*|{}\]\\^])/g, '\\$1') + '=([^;]*)'));
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
    let err; try { err = await res.json(); } catch {}
    throw new Error(err?.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

const fmtBRL  = (c)=> (c/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const toCents = (s)=> { const d = (s||'').toString().replace(/\D/g,''); return d ? parseInt(d,10) : 0; };
const esc     = (s='') => s.replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));

/* ========== Elementos ========== */
const tabBancasEl     = qs('#tab-bancas');
const tabPagamentosEl = qs('#tab-pagamentos');
const tbodyBancas     = qs('#tblBancas tbody');
const tbodyPags       = qs('#tblPagamentos tbody');
const buscaInput      = qs('#busca');

let TAB = localStorage.getItem('area_tab') || 'bancas';
const STATE = {
  bancas: [],
  pagamentos: [],
  timers: new Map(), // id => timeoutId (auto-delete pagos)
};

/* ========== Helpers visuais ========== */
function waitTransition(el, timeout=260){
  return new Promise(resolve=>{
    if(!el) return resolve();
    let done = false;
    const end = (e)=>{ if(done) return; done=true; el.removeEventListener('transitionend', end); clearTimeout(tid); resolve(); };
    const tid = setTimeout(end, timeout);
    el.addEventListener('transitionend', end);
  });
}

/* ========== Carregamento (STATE) ========== */
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

/* ========== Render ========== */
function render(){
  if (TAB==='bancas'){
    tabBancasEl.classList.add('show');
    tabPagamentosEl.classList.remove('show');
    renderBancas();
  } else {
    tabPagamentosEl.classList.add('show');
    tabBancasEl.classList.remove('show');
    renderPagamentos();
  }
}

function renderBancas(){
  const lista = STATE.bancas;
  tbodyBancas.innerHTML = lista.length ? lista.map(b => {
    const bancaTxt = typeof b.bancaCents === 'number' ? fmtBRL(b.bancaCents) : '';
    return `
      <tr data-id="${b.id}">
        <td>${esc(b.nome)}</td>
        <td>${fmtBRL(b.depositoCents||0)}</td>
        <td>
          <input type="text" class="input input-money" data-role="banca" data-id="${b.id}" placeholder="R$ 0,00" value="${bancaTxt}">
        </td>
        <td class="col-acoes">
          <div style="display:flex;gap:8px">
            <button class="btn btn--primary" data-action="to-pagamento" data-id="${b.id}">Pagamento</button>
            <button class="btn btn--danger"  data-action="del-banca"    data-id="${b.id}">Excluir</button>
          </div>
        </td>
      </tr>`;
  }).join('') : `<tr><td colspan="4" class="muted" style="padding:14px">Sem registros ainda.</td></tr>`;

  filtrarTabela(tbodyBancas, buscaInput?.value || '');
}

function renderPagamentos(){
  const lista = STATE.pagamentos;
  tbodyPags.innerHTML = lista.length ? lista.map(p => {
    const isPago = p.status === 'pago';
    const statusTxt = isPago ? 'Pago' : 'Não pago';
    const statusCls = isPago ? 'status--pago' : 'status--nao';
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
            <button class="btn btn--primary" data-action="fazer-pix" data-id="${p.id}">Fazer PIX</button>
            <button class="btn btn--danger"  data-action="del-pag"   data-id="${p.id}">Excluir</button>
          </div>
        </td>
      </tr>`;
  }).join('') : `<tr><td colspan="3" class="muted" style="padding:14px">Sem registros ainda.</td></tr>`;

  filtrarTabela(tbodyPags, buscaInput?.value || '');
}

/* ========== Troca de abas (sem flicker) ========== */
async function setTab(tab){
  if (TAB === tab) return;

  const vB = tabBancasEl;
  const vP = tabPagamentosEl;
  const toShow = (tab === 'bancas') ? vB : vP;
  const toHide = (tab === 'bancas') ? vP : vB;

  // ativa botão
  qsa('.nav-btn').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // trava altura do conteúdo pra não “pular”
  const content = qs('.content');
  if (content) content.style.minHeight = content.offsetHeight + 'px';

  // fade de saída da aba atual
  toHide?.classList.add('hiding');
  await waitTransition(toHide, 260);
  toHide?.classList.remove('hiding','show');

  // atualiza estado e carrega dados da próxima ABA
  TAB = tab;
  localStorage.setItem('area_tab', tab);
  if (TAB==='bancas') await loadBancas();
  else                await loadPagamentos();

  // renderiza já com dados prontos (evita tela “vazia”)
  render();

  // libera o lock de altura no próximo frame
  requestAnimationFrame(()=>{ if(content) content.style.minHeight = ''; });
}

/* ========== Refresh (aba atual) ========== */
async function refresh(){
  if (TAB==='bancas') await loadBancas();
  else                await loadPagamentos();
  render();
}

/* ========== AÇÕES ==========\ */
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
  TAB = 'pagamentos';
  localStorage.setItem('area_tab', TAB);
  await Promise.all([loadBancas(), loadPagamentos()]);
  render();
  setupAutoDeleteTimers();
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
  if (value === 'pago') scheduleAutoDelete(item);
  else {
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

/* ========== Modal “Fazer PIX” ========== */
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

/* ========== MENU FLUTUANTE Pago/Não pago ========== */
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
  qsa('.status-item', m).forEach(b=>{
    b.classList.toggle('active', b.dataset.value === current);
  });

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
['scroll','resize'].forEach(ev=>{
  window.addEventListener(ev, hideStatusMenu, {passive:true});
});
qsa('.table-wrap').forEach(w=> w.addEventListener('scroll', hideStatusMenu, {passive:true}));

/* ========== Eventos globais ========== */
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
});

/* edição inline da Banca (R$) */
document.addEventListener('input', (e)=>{
  const inp = e.target.closest('input[data-role="banca"]');
  if(!inp) return;
  let v = inp.value.replace(/\D/g,'');
  if(!v){ inp.value=''; return; }
  v = v.replace(/^0+/, '');
  if(v.length<3) v = v.padStart(3,'0');
  inp.value = fmtBRL(parseInt(v,10));
});

/* salvar PATCH ao sair do campo */
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

/* busca */
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

/* ========== start ========== */
document.addEventListener('DOMContentLoaded', async ()=>{
  // habilita transições no CSS
  tabBancasEl?.classList.add('tab-view', 'show');
  tabPagamentosEl?.classList.add('tab-view');
  qsa('.nav-btn').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.tab === TAB);
  });

  // pré-carrega as duas listas (aquecimento)
  await Promise.allSettled([loadBancas(), loadPagamentos()]);
  render();
  setupAutoDeleteTimers();
});
