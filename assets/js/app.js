/* =========================================
   Depósito PIX – front (produção)
   - Cria modal do QR por JS
   - Chama backend Efi (/api/pix/cob e /api/pix/status/:txid)
   - Ao confirmar: registra no servidor (/api/pix/confirmar)
     e cai para localStorage se o servidor rejeitar
   ========================================= */

// Usa o mesmo domínio/origem (Render/produção)
const API = window.location.origin;

/* ===== Seletores ===== */
const cpfInput    = document.querySelector('#cpf');
const nomeInput   = document.querySelector('#nome');
const tipoSelect  = document.querySelector('#tipoChave');
const chaveWrap   = document.querySelector('#chaveWrapper');
const chaveInput  = document.querySelector('#chavePix');
const valorInput  = document.querySelector('#valor');
const form        = document.querySelector('#depositoForm');
const toast       = document.querySelector('#toast');

// Resumo
const rCpf     = document.querySelector('#r-cpf');
const rNome    = document.querySelector('#r-nome');
const rTipo    = document.querySelector('#r-tipo');
const rChaveLi = document.querySelector('#r-chave-li');
const rChave   = document.querySelector('#r-chave');
const rValor   = document.querySelector('#r-valor');

/* ===== Utils ===== */
document.querySelector('#ano') && (document.querySelector('#ano').textContent = new Date().getFullYear());

function notify(msg, isError=false, time=3200){
  if(!toast){ alert(msg); return; }
  toast.textContent = msg;
  toast.style.borderColor = isError ? 'rgba(255,92,122,.45)' : 'rgba(0,209,143,.45)';
  toast.classList.add('show');
  setTimeout(()=>toast.classList.remove('show'), time);
}
function centsToBRL(c){ return (c/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); }
function toCentsMasked(str){ return Number((str||'').replace(/\D/g,'')||0); }

/* ===== Persistência ===== */

// 1) Salva UNIVERSAL no servidor (rota pública que valida o TXID e grava)
async function saveOnServer({ txid, nome, valorCentavos, tipo, chave }){
  const res = await fetch(`${API}/api/pix/confirmar`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ txid, nome, valorCentavos, tipo, chave })
  });
  if(!res.ok){
    let msg = '';
    try { const j = await res.json(); msg = j?.error || ''; } catch {}
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json();
}

// 2) Fallback local (visível só neste navegador)
function saveLocal({ nome, valorCentavos, tipo, chave }){
  const registro = {
    id: Date.now().toString(),
    nome,
    depositoCents: valorCentavos,
    pixType: tipo,
    pixKey:  chave,
    createdAt: new Date().toISOString()
  };
  const bancas = JSON.parse(localStorage.getItem('bancas') || '[]');
  bancas.push(registro);
  localStorage.setItem('bancas', JSON.stringify(bancas));
}

/* ===== Máscaras & Resumo ===== */
cpfInput.addEventListener('input', () => {
  let v = cpfInput.value.replace(/\D/g,'').slice(0,11);
  v = v.replace(/(\d{3})(\d)/,'$1.$2')
       .replace(/(\d{3})(\d)/,'$1.$2')
       .replace(/(\d{3})(\d{1,2})$/,'$1-$2');
  cpfInput.value = v;
  rCpf.textContent = v || '—';
});
nomeInput.addEventListener('input', () => rNome.textContent = nomeInput.value.trim() || '—');

tipoSelect.addEventListener('change', () => {
  const t = tipoSelect.value;
  rTipo.textContent = t === 'aleatoria' ? 'Chave aleatória' : (t.charAt(0).toUpperCase()+t.slice(1));
  if (t === 'cpf'){
    chaveWrap.style.display = 'none';
    rChaveLi.style.display = 'none';
    chaveInput.value = '';
  }else{
    chaveWrap.style.display = '';
    rChaveLi.style.display = '';
    chaveInput.placeholder = t === 'telefone' ? '(00) 90000-0000' : (t === 'email' ? 'seu@email.com' : 'Ex.: 2e1a-…)');
  }
});

chaveInput.addEventListener('input', () => {
  if (tipoSelect.value === 'telefone'){
    let v = chaveInput.value.replace(/\D/g,'').slice(0,11);
    if(v.length > 2) v = `(${v.slice(0,2)}) ${v.slice(2)}`;
    if(v.length > 10) v = `${v.slice(0,10)}-${v.slice(10)}`;
    chaveInput.value = v;
    rChave.textContent = v || '—';
  } else {
    rChave.textContent = chaveInput.value.trim() || '—';
  }
});

valorInput.addEventListener('input', () => {
  let v = valorInput.value.replace(/\D/g,'');
  if(!v){ rValor.textContent='—'; valorInput.value=''; return; }
  v = v.replace(/^0+/, '');
  if(v.length < 3) v = v.padStart(3,'0');
  const money = centsToBRL(parseInt(v,10));
  valorInput.value = money;
  rValor.textContent = money;
});

/* ===== Validações ===== */
function isCPFValid(cpf){
  cpf = (cpf||'').replace(/\D/g,'');
  if(cpf.length !== 11 || /^([0-9])\1+$/.test(cpf)) return false;
  let s=0,r;
  for (let i=1;i<=9;i++) s += parseInt(cpf.substring(i-1,i))*(11-i);
  r = (s*10)%11; if(r===10||r===11) r=0; if(r!==parseInt(cpf.substring(9,10))) return false;
  s=0; for (let i=1;i<=10;i++) s += parseInt(cpf.substring(i-1,i))*(12-i);
  r = (s*10)%11; if(r===10||r===11) r=0; return r===parseInt(cpf.substring(10,11));
}
function isEmail(v){ return /.+@.+\..+/.test(v); }
function showError(sel, ok){ const el = document.querySelector(sel); ok ? el.classList.remove('show') : el.classList.add('show'); }

/* ===== Modal de QR (dinâmico) ===== */
function ensurePixStyles(){
  if (!document.getElementById('pixCss')) {
    const link = document.createElement('link');
    link.id = 'pixCss';
    link.rel = 'stylesheet';
    link.href = 'assets/css/pix.css';
    document.head.appendChild(link);
  }
}
function ensurePixModal(){
  ensurePixStyles();
  let dlg = document.querySelector('#pixModal');
  if (dlg) return dlg;

  dlg = document.createElement('dialog');
  dlg.id = 'pixModal';
  dlg.className = 'pix-modal';

  const card = document.createElement('div');
  card.className = 'pix-card';

  const title = document.createElement('h3');
  title.className = 'pix-title';
  title.textContent = 'Escaneie para pagar';

  const qrWrap = document.createElement('div');
  qrWrap.className = 'pix-qr-wrap';

  const img = document.createElement('img');
  img.id = 'pixQr';
  img.className = 'pix-qr';
  img.alt = 'QR Code do PIX';

  const code = document.createElement('div');
  code.className = 'pix-code';

  const emv = document.createElement('input');
  emv.id = 'pixEmv';
  emv.className = 'pix-emv';
  emv.readOnly = true;

  const copy = document.createElement('button');
  copy.id = 'btnCopy';
  copy.className = 'pix-copy btn cta cta--small';
  copy.textContent = 'Copiar';

  const status = document.createElement('p');
  status.id = 'pixStatus';
  status.className = 'pix-status';
  status.textContent = 'Aguardando pagamento…';

  const actions = document.createElement('div');
  actions.className = 'pix-actions';

  const close = document.createElement('button');
  close.id = 'btnFechar';
  close.className = 'pix-close btn-outline';
  close.textContent = 'Fechar';

  qrWrap.appendChild(img);
  code.appendChild(emv);
  code.appendChild(copy);
  actions.appendChild(close);
  [title, qrWrap, code, status, actions].forEach(n => card.appendChild(n));
  dlg.appendChild(card);
  document.body.appendChild(dlg);

  dlg.addEventListener('cancel', (e)=>{ e.preventDefault(); dlg.close(); });
  dlg.addEventListener('click', (e)=>{ if(e.target === dlg) dlg.close(); });
  copy.onclick = async ()=> {
    const emvEl = dlg.querySelector('#pixEmv');
    if (!emvEl.value) return;
    await navigator.clipboard.writeText(emvEl.value);
    notify('Código copia e cola copiado!');
  };
  close.onclick = ()=> dlg.close();

  return dlg;
}

/* ===== Backend Efi: criar cobrança ===== */
async function criarCobrancaPIX({ nome, cpf, valorCentavos }){
  const resp = await fetch(`${API}/api/pix/cob`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ nome, cpf, valorCentavos })
  });
  if(!resp.ok){
    let err = 'Falha ao criar PIX';
    try{ const j = await resp.json(); if(j.error) err = j.error; }catch{}
    throw new Error(err);
  }
  return resp.json(); // { txid, emv, qrPng }
}

/* ===== Submit ===== */
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const cpfOk   = isCPFValid(cpfInput.value);
  const nomeOk  = nomeInput.value.trim().length > 2;
  const tipo    = tipoSelect.value;
  let chaveOk   = true;
  if (tipo !== 'cpf'){
    const v = chaveInput.value.trim();
    if (tipo === 'email')         chaveOk = isEmail(v);
    else if (tipo === 'telefone') chaveOk = v.replace(/\D/g,'').length === 11;
    else                          chaveOk = v.length >= 10; // aleatória
  }
  const valorCentavos = toCentsMasked(valorInput.value);
  const valorOk       = valorCentavos >= 1000; // R$10,00

  showError('#cpfError',  cpfOk);
  showError('#nomeError', nomeOk);
  showError('#chaveError',chaveOk);
  showError('#valorError',valorOk);

  if (!(cpfOk && nomeOk && chaveOk && valorOk)){
    notify('Por favor, corrija os campos destacados.', true);
    return;
  }

  const dados = {
    nome:  nomeInput.value.trim(),
    cpf:   cpfInput.value,
    tipo:  tipoSelect.value,
    chave: (tipoSelect.value === 'cpf' ? cpfInput.value : (chaveInput.value || '').trim()),
    valorCentavos
  };

  try{
    // 1) criar a cobrança
    const { txid, emv, qrPng } = await criarCobrancaPIX({
      nome: dados.nome, cpf: dados.cpf, valorCentavos: dados.valorCentavos
    });

    // 2) abrir modal com QR
    const dlg = ensurePixModal();
    const img = dlg.querySelector('#pixQr');
    const emvEl = dlg.querySelector('#pixEmv');
    const st = dlg.querySelector('#pixStatus');
    img.src = qrPng;
    emvEl.value = emv;
    st.textContent = 'Aguardando pagamento…';
    if(typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open','');

    // 3) polling /api/pix/status/:txid até CONCLUIDA
    async function check(){
      const s = await fetch(`${API}/api/pix/status/${encodeURIComponent(txid)}`).then(r=>r.json());
      return s.status === 'CONCLUIDA';
    }

    let tries = 36; // 3 min (5s)
    const timer = setInterval(async ()=>{
      tries--;
      try{
        const ok = await check();
        if (ok) {
          clearInterval(timer);
          st.textContent = 'Pagamento confirmado! ✅';

          // 4) registra de forma universal
          try{
            await saveOnServer({
              txid,
              nome: dados.nome,
              valorCentavos: dados.valorCentavos,
              tipo: dados.tipo,
              chave: dados.chave
            });
          }catch(_err){
            // fallback local se o servidor não aceitar
            saveLocal({
              nome: dados.nome,
              valorCentavos: dados.valorCentavos,
              tipo: dados.tipo,
              chave: dados.chave
            });
          }

          setTimeout(()=>{
            dlg.close();
            notify('Pagamento confirmado! Registro salvo.', false, 4500);
          }, 900);
        } else if (tries <= 0) {
          clearInterval(timer);
          st.textContent = 'Tempo esgotado. Se já pagou, a confirmação aparecerá na Área.';
        }
      }catch(loopErr){
        console.error(loopErr);
      }
    }, 5000);

  }catch(e){
    console.error(e);
    notify('Não foi possível iniciar o PIX. Tente novamente.', true);
  }
});
