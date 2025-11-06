

(function () {
  // Util: ler cookie
  function getCookie(name) {
    return document.cookie.split("; ")
      .find(c => c.startsWith(name + "="))?.split("=")[1] || "";
  }

  // Protege a página: se não estiver logado, manda para login
  async function ensureAuth() {
    try {
      const r = await fetch("/api/auth/me", { credentials: "include" });
      if (!r.ok) throw new Error("unauth");
      // ok, segue
    } catch {
      location.href = "/login.html";
    }
  }

  // Logout seguro (envia CSRF + cookies)
  async function doLogout() {
    try {
      const csrf = getCookie("csrf"); // mesmo nome que o servidor setou
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

  // Bind do botão Sair
  function wireLogout() {
    const btn = document.getElementById("logoutBtn");
    if (btn) btn.addEventListener("click", doLogout);
  }

  // Start
  document.addEventListener("DOMContentLoaded", () => {
    ensureAuth();
    wireLogout();
  });
})();
