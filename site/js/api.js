// Funções compartilhadas por todas as páginas.
(function () {
  const C = window.PN_CONFIG || {};
  const TOKEN_KEY = "pn_token";

  async function parse(res) {
    let body = {};
    try { body = await res.json(); } catch (_) { /* resposta sem JSON */ }
    if (!res.ok) {
      const err = new Error(body.error || "Não foi possível completar. Confira sua internet e tente de novo.");
      err.status = res.status;
      throw err;
    }
    return body;
  }

  async function send(url, init) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (_) {
      throw new Error("Sem conexão. Confira sua internet e tente de novo.");
    }
    return parse(res);
  }

  const PN = {
    config: C,

    api(action, data, adminPassword) {
      const headers = { "Content-Type": "application/json" };
      if (adminPassword) headers["x-admin-password"] = adminPassword;
      return send(C.API_URL, { method: "POST", headers, body: JSON.stringify({ action, ...(data || {}) }) });
    },

    upload(token, blob) {
      const form = new FormData();
      form.append("token", token);
      form.append("photo", blob, "pet.jpg");
      return send(C.API_URL + "?action=generate", { method: "POST", body: form });
    },

    money(cents) {
      return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    },

    getToken() {
      const fromUrl = new URLSearchParams(location.search).get("t");
      if (fromUrl && /^[0-9a-f]{48}$/.test(fromUrl)) {
        try { localStorage.setItem(TOKEN_KEY, fromUrl); } catch (_) { /* modo privado */ }
        return fromUrl;
      }
      try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; }
    },

    setToken(token) {
      try { localStorage.setItem(TOKEN_KEY, token); } catch (_) { /* modo privado */ }
    },

    clearToken() {
      try { localStorage.removeItem(TOKEN_KEY); } catch (_) { /* modo privado */ }
    },

    whatsappLink(text) {
      if (!C.WHATSAPP) return null;
      return "https://wa.me/" + C.WHATSAPP + (text ? "?text=" + encodeURIComponent(text) : "");
    },

    maskPhone(v) {
      const d = v.replace(/\D/g, "").slice(0, 11);
      if (d.length <= 2) return d;
      if (d.length <= 6) return "(" + d.slice(0, 2) + ") " + d.slice(2);
      if (d.length <= 10) return "(" + d.slice(0, 2) + ") " + d.slice(2, 6) + "-" + d.slice(6);
      return "(" + d.slice(0, 2) + ") " + d.slice(2, 7) + "-" + d.slice(7);
    },

    maskCep(v) {
      const d = v.replace(/\D/g, "").slice(0, 8);
      return d.length > 5 ? d.slice(0, 5) + "-" + d.slice(5) : d;
    },

    // Preenche textos e links que dependem do config.js.
    applyBrand() {
      document.querySelectorAll("[data-marca]").forEach((el) => { el.textContent = C.MARCA || "Patinha de Natal"; });
      document.querySelectorAll("[data-tamanho]").forEach((el) => { el.textContent = C.TAMANHO || ""; });
      document.querySelectorAll("[data-prazo]").forEach((el) => { el.textContent = C.PRAZO_PRODUCAO || ""; });
      document.querySelectorAll("[data-whatsapp]").forEach((el) => {
        const link = PN.whatsappLink(el.dataset.whatsapp || "");
        if (link) { el.href = link; el.hidden = false; } else { el.hidden = true; }
      });
      const legal = [C.RAZAO_SOCIAL, C.CNPJ && "CNPJ " + C.CNPJ, C.EMAIL_CONTATO].filter(Boolean).join(" · ");
      document.querySelectorAll("[data-legal]").forEach((el) => { el.textContent = legal; });
    },
  };

  window.PN = PN;
  document.addEventListener("DOMContentLoaded", PN.applyBrand);
})();
