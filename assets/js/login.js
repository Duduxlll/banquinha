const err = document.querySelector('#err');
const form = document.querySelector('#loginForm');
const API  = window.location.origin; 

form.addEventListener('submit', async (e)=>{
  e.preventDefault();
  err.textContent = '';

  const username = document.querySelector('#user').value.trim();
  const password = document.querySelector('#pass').value;

  try{
    const r = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      credentials: 'include', 
      body: JSON.stringify({ username, password })
    });
    if(!r.ok){
      const j = await r.json().catch(()=>({}));
      err.textContent = j.error === 'invalid_credentials' ? 'Usuário ou senha inválidos.' : 'Falha ao entrar.';
      return;
    }
    
    location.href = '/area.html';
  }catch(e){
    err.textContent = 'Erro de rede.';
  }
});
