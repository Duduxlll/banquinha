

(function () {
  
  function getCookie(name) {
    return document.cookie.split("; ")
      .find(c => c.startsWith(name + "="))?.split("=")[1] || "";
  }

  async function ensureAuth() {
    try {
      const r = await fetch("/api/auth/me", { credentials: "include" });
      if (!r.ok) throw new Error("unauth");
      
    } catch {
      location.href = "/login.html";
    }
  }

  async function doLogout() {
    try {
      const csrf = getCookie("csrf"); 
      const resp = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        credentials: "include",
      });
      if (resp.ok) {
        
        location.href = "/login.html";
      } else {
        alert("Não foi possível sair. Tente novamente.");
      }
    } catch (e) {
      alert("Erro de rede ao sair.");
    }
  }

  
  function wireLogout() {
    const btn = document.getElementById("logoutBtn");
    if (btn) btn.addEventListener("click", doLogout);
  }

  
  document.addEventListener("DOMContentLoaded", () => {
    ensureAuth();
    wireLogout();
  });
})();
