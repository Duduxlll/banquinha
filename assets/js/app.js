const API = window.location.origin;

/* ===== Seletores ===== */
const nomeInput   = document.querySelector('#nome');
const tipoSelect  = document.querySelector('#tipoChave');
const chaveWrap   = document.querySelector('#chaveWrapper');
const chaveInput  = document.querySelector('#chavePix');
const valorInput  = document.querySelector('#valor');
const form        = document.querySelector('#depositoForm');
const toast       = document.querySelector('#toast');
const btnSubmit   = document.querySelector('#btnDepositar');

// [ADD mensagem] seletores da mensagem
const mensagemInput = document.querySelector('#mensagem');

// Resumo (sem r-cpf)
const rNome    = document.querySelector('#r-nome');
const rTipo    = document.querySelector('#r-tipo');
const rChaveLi = document.querySelector('#r-chave-li') || document.querySelector('#resumo li:nth-child(3)');
const rChave   = document.querySelector('#r-chave');
const rValor   = document.querySelector('#r-valor');
// [ADD mensagem] saída no resumo
const rMsg     = document.querySelector('#r-msg');

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
function getMeta(name){
  const el = document.querySelector(`meta[name="${name}"]`);
  return el ? el.content : '';
}


// Salva UNIVERSAL no servidor validando (rota pública segura via TOKEN ou TXID)
// [ADD mensagem] agora aceita { message }
async function saveOnServerConfirmado({ tokenOrTxid, nome, valorCentavos, tipo, chave, message }){
  const APP_KEY = window.APP_PUBLIC_KEY || getMeta('app-key') || '';
  const res = await fetch(`${API}/api/pix/confirmar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(APP_KEY ? { 'X-APP-KEY': APP_KEY } : {})
    },
    body: JSON.stringify({
      token: tokenOrTxid,
      txid: tokenOrTxid,
      nome,
      valorCentavos,
      tipo,
      chave,
      message: message || null // [ADD mensagem]
    })
  });
  if (!res.ok) {
    let msg = `Falha ao confirmar (${res.status})`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// Fallback local (visível só neste navegador)
// [ADD mensagem] persiste message também
function saveLocal({ nome, valorCentavos, tipo, chave, message }){
  const registro = {
    id: Date.now().toString(),
    nome,
    depositoCents: valorCentavos,
    pixType: tipo,
    pixKey:  chave,
    message: message || null, // [ADD mensagem]
    createdAt: new Date().toISOString()
  };
  const bancas = JSON.parse(localStorage.getItem('bancas') || '[]');
  bancas.push(registro);
  localStorage.setItem('bancas', JSON.stringify(bancas));
}

/* ===== Máscaras & Resumo ===== */

// Nome > Resumo
nomeInput?.addEventListener('input', () => rNome && (rNome.textContent = nomeInput.value.trim() || '—'));

// [ADD mensagem] Mensagem > Resumo (preview)
mensagemInput?.addEventListener('input', () => {
  if (!rMsg) return;
  const v = (mensagemInput.value || '').trim();
  rMsg.textContent = v ? (v.length > 100 ? v.slice(0,100)+'…' : v) : '—';
});

// Alterna campo da chave conforme o tipo
function updateTipoUI(){
  if (!tipoSelect) return;
  const t = tipoSelect.value;
  // Sempre mostra o campo da chave (inclusive para CPF)
  if (chaveWrap) chaveWrap.style.display = '';
  if (rChaveLi)  rChaveLi.style.display  = '';
  if (rTipo)     rTipo.textContent = t === 'aleatoria' ? 'Chave aleatória' : (t.charAt(0).toUpperCase()+t.slice(1));

  if (!chaveInput) return;

  if (t === 'cpf'){
    // CPF: placeholder e maxlength “visual”
    chaveInput.placeholder = '000.000.000-00';
    // limpa para evitar sujeira de formatações anteriores
    chaveInput.value = maskCPF(chaveInput.value);
    rChave && (rChave.textContent = chaveInput.value.trim() || '—');
  } else if (t === 'telefone'){
    chaveInput.placeholder = '(00) 90000-0000';
    chaveInput.value = maskPhone(chaveInput.value);
    rChave && (rChave.textContent = chaveInput.value.trim() || '—');
  } else if (t === 'email'){
    chaveInput.placeholder = 'seu@email.com';
    rChave && (rChave.textContent = chaveInput.value.trim() || '—');
  } else {
    // aleatória
    chaveInput.placeholder = 'Ex.: 2e1a-…';
    rChave && (rChave.textContent = chaveInput.value.trim() || '—');
  }
}
tipoSelect?.addEventListener('change', updateTipoUI);
updateTipoUI();

// Máscara dinâmica para o campo da chave (de acordo com o tipo)
function maskCPF(raw){
  let v = String(raw||'').replace(/\D/g,'').slice(0,11);
  v = v.replace(/(\d{3})(\d)/,'$1.$2')
       .replace(/(\d{3})(\d)/,'$1.$2')
       .replace(/(\d{3})(\d{1,2})$/,'$1-$2');
  return v;
}
function maskPhone(raw){
  let v = String(raw||'').replace(/\D/g,'').slice(0,11);
  if(v.length > 2) v = `(${v.slice(0,2)}) ${v.slice(2)}`;
  if(v.length > 10) v = `${v.slice(0,10)}-${v.slice(10)}`;
  return v;
}

chaveInput?.addEventListener('input', () => {
  if (!tipoSelect) return;
  const t = tipoSelect.value;
  if (t === 'cpf'){
    chaveInput.value = maskCPF(chaveInput.value);
  } else if (t === 'telefone'){
    chaveInput.value = maskPhone(chaveInput.value);
  }
  rChave && (rChave.textContent = chaveInput.value.trim() || '—');
});

// Valor com máscara R$
valorInput?.addEventListener('input', () => {
  let v = valorInput.value.replace(/\D/g,'');
  if(!v){ rValor && (rValor.textContent='—'); valorInput.value=''; return; }
  v = v.replace(/^0+/, '');
  if(v.length < 3) v = v.padStart(3,'0');
  const money = centsToBRL(parseInt(v,10));
  valorInput.value = money;
  rValor && (rValor.textContent = money);
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

async function criarCobrancaPIX({ nome, cpf, valorCentavos }){
  // cpf opcional aqui: só enviaremos quando tipo for 'cpf'
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
  // Pode vir { token, emv, qrPng } OU { txid, emv, qrPng }
  return resp.json();
}

/* ===== Submit ===== */
form?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const tipo = tipoSelect.value;
  const chaveVal = (chaveInput?.value || '').trim();
  const messageVal = (mensagemInput?.value || '').trim(); // [ADD mensagem]

  // Validações por tipo
  let chaveOk = true;
  if (tipo === 'cpf')        chaveOk = isCPFValid(chaveVal);
  else if (tipo === 'email') chaveOk = isEmail(chaveVal);
  else if (tipo === 'telefone') chaveOk = chaveVal.replace(/\D/g,'').length === 11;
  else                        chaveOk = chaveVal.length >= 10; // aleatória

  const nomeOk  = nomeInput.value.trim().length > 2;
  const valorCentavos = toCentsMasked(valorInput.value);
  const valorOk       = valorCentavos >= 1000; // R$ 10,00

  // Exibição de erros
  showError('#nomeError', nomeOk);
  showError('#chaveError',chaveOk);
  showError('#valorError',valorOk);
  // Se sua página ainda tiver #cpfError, mantemos oculto
  const cpfErr = document.querySelector('#cpfError'); cpfErr && cpfErr.classList.remove('show');

  if (!(nomeOk && chaveOk && valorOk)){
    notify('Por favor, corrija os campos destacados.', true);
    return;
  }

  const cpfParaEfi = (tipo === 'cpf') ? chaveVal : ''; // se a chave for CPF, enviamos o CPF à Efi

  try{
    btnSubmit && (btnSubmit.disabled = true);

    // 1) criar a cobrança
    const cob = await criarCobrancaPIX({ nome: nomeInput.value.trim(), cpf: cpfParaEfi, valorCentavos });
    const tokenOrTxid = cob.token || cob.txid;
    const { emv, qrPng } = cob;

    // 2) abrir modal com QR
    const dlg = ensurePixModal();
    const img = dlg.querySelector('#pixQr');
    const emvEl = dlg.querySelector('#pixEmv');
    const st = dlg.querySelector('#pixStatus');
    img.src = qrPng;
    emvEl.value = emv;
    st.textContent = 'Aguardando pagamento…';
    if(typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open','');

    // 3) polling /api/pix/status/:tokenOrTxid até CONCLUIDA
    async function check(){
      const s = await fetch(`${API}/api/pix/status/${encodeURIComponent(tokenOrTxid)}`).then(r=>r.json());
      return s.status === 'CONCLUIDA';
    }

    let tries = 36; // 3 min (5s cada)
    const timer = setInterval(async ()=>{
      tries--;
      try{
        const ok = await check();
        if (ok) {
          clearInterval(timer);
          st.textContent = 'Pagamento confirmado! ✅';

          // 4) registra no servidor com validação universal
          try{
            await saveOnServerConfirmado({
              tokenOrTxid,
              nome: nomeInput.value.trim(),
              valorCentavos,
              tipo,
              chave: chaveVal,
              message: messageVal // [ADD mensagem]
            });
          }catch(_err){
            // fallback local se o servidor recusar (não recomendado para produção)
            saveLocal({
              nome: nomeInput.value.trim(),
              valorCentavos,
              tipo,
              chave: chaveVal,
              message: messageVal // [ADD mensagem]
            });
            notify('Servidor não confirmou o registro — salvo localmente.', true, 4200);
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
  } finally {
    btnSubmit && (btnSubmit.disabled = false);
  }
});
