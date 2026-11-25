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

    upload(token, blob, species, item) {
      const form = new FormData();
      form.append("token", token);
      form.append("species", species || "");
      form.append("item", String(item || 0));
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

    store: {},

    whatsappLink(text) {
      const number = PN.store.whatsapp || C.WHATSAPP;
      if (!number) return null;
      return "https://wa.me/" + number + (text ? "?text=" + encodeURIComponent(text) : "");
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

    // Eventos de conversão para anúncios (Meta, Google e TikTok). Só dispara se houver ID no painel ou no config.js.
    track(event, data) {
      try {
        if (window.fbq) window.fbq("track", event, data || {});
        if (window.gtag) {
          const map = { InitiateCheckout: "begin_checkout", Purchase: "purchase", PageView: "page_view", Lead: "generate_lead", StartTrial: "start_trial" };
          window.gtag("event", map[event] || event, data || {});
        }
        if (window.ttq && event !== "PageView") {
          const map = { InitiateCheckout: "InitiateCheckout", Purchase: "CompletePayment", Lead: "SubmitForm", StartTrial: "ClickButton" };
          const d = data || {};
          const props = { value: d.value, currency: d.currency || "BRL", content_type: "product", content_id: "enfeite-pet" };
          if (!d.transaction_id) window.ttq.track(map[event] || event, props);
          else window.ttq.track(map[event] || event, Object.assign(props, { order_id: d.transaction_id }), { event_id: event + "_" + d.transaction_id });
        }
      } catch (_) { /* bloqueador de anúncios */ }
    },

    // Preenche textos e links que dependem do config.js.
    applyBrand() {
      document.querySelectorAll("[data-marca]").forEach((el) => { el.textContent = C.MARCA || "Patinha de Natal"; });
      const S = PN.store;
      // Tamanho: o do painel; senão, o diâmetro do modelo 3D (o que é de fato impresso).
      const d = PN.publicConfig && PN.publicConfig.model && PN.publicConfig.model.diameter;
      const size = S.size || (d ? String(d / 10).replace(".", ",") + " cm" : C.TAMANHO || "7 cm");
      document.querySelectorAll("[data-tamanho]").forEach((el) => { el.textContent = size; });
      if (PN.publicConfig && PN.publicConfig.credits) document.querySelectorAll("[data-credits]").forEach((el) => { el.textContent = PN.publicConfig.credits; });
      document.querySelectorAll("[data-prazo]").forEach((el) => { el.textContent = S.lead_time || C.PRAZO_PRODUCAO || "5 dias úteis"; });
      document.querySelectorAll("[data-aviso]").forEach((el) => { el.textContent = S.notice || ""; el.hidden = !S.notice; });
      document.querySelectorAll("[data-whatsapp]").forEach((el) => {
        const link = PN.whatsappLink(el.dataset.whatsapp || "");
        if (link) { el.href = link; el.hidden = false; } else { el.hidden = true; }
      });
      document.querySelectorAll("[data-whatsapp-wrap]").forEach((el) => { el.hidden = !PN.whatsappLink(""); });
      const company = S.company || C.RAZAO_SOCIAL, cnpj = S.cnpj || C.CNPJ, mail = S.email || C.EMAIL_CONTATO;
      const legal = [company, cnpj && "CNPJ " + cnpj, mail].filter(Boolean).join(" · ");
      document.querySelectorAll("[data-legal]").forEach((el) => { el.textContent = legal; });
    },
  };

  let tracking = false;
  function initTracking(metaId, googleId, tiktokId) {
    if (tracking) return;
    tracking = true;
    if (metaId) {
      /* eslint-disable */
      !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version="2.0";n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,"script","https://connect.facebook.net/en_US/fbevents.js");
      /* eslint-enable */
      window.fbq("init", metaId);
      window.fbq("track", "PageView");
    }
    if (googleId) {
      const g = document.createElement("script");
      g.async = true;
      g.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(googleId);
      document.head.appendChild(g);
      window.dataLayer = window.dataLayer || [];
      window.gtag = function () { window.dataLayer.push(arguments); };
      window.gtag("js", new Date());
      window.gtag("config", googleId);
    }
    if (tiktokId) {
      // Código oficial do TikTok Pixel (analytics.tiktok.com).
      /* eslint-disable */
      !function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js",o=n&&n.partner;ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=r,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};n=d.createElement("script");n.type="text/javascript",n.async=!0,n.src=r+"?sdkid="+e+"&lib="+t;e=d.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};}(window,document,"ttq");
      /* eslint-enable */
      window.ttq.load(tiktokId);
      window.ttq.page();
    }
  }

  // Configuração pública da loja (preço, contato, avisos). Todas as páginas esperam por ela.
  PN.ready = PN.api("config").then((c) => {
    PN.store = c.store || {};
    PN.publicConfig = c;
    return c;
  }).catch(() => null).then((c) => {
    initTracking(PN.store.meta_pixel_id || C.META_PIXEL_ID, PN.store.google_tag_id || C.GOOGLE_TAG_ID, PN.store.tiktok_pixel_id || C.TIKTOK_PIXEL_ID);
    if (document.readyState !== "loading") PN.applyBrand();
    return c;
  });

  // Loja parceira (pet shop): o QR do balcão abre o site com ?p=CODIGO. Guarda o código por 30 dias
  // (vale a primeira loja) e manda junto quando o teste grátis começa.
  const PARTNER_KEY = "pn_partner";
  const PARTNER_DAYS = 30;
  PN.partner = function () {
    try {
      const v = JSON.parse(localStorage.getItem(PARTNER_KEY) || "null");
      if (v && v.code && Date.now() - v.at < PARTNER_DAYS * 864e5) return v.code;
    } catch (_) { /* modo privado */ }
    return null;
  };
  (function capturePartner() {
    const raw = new URLSearchParams(location.search).get("p");
    const code = raw ? raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) : "";
    const current = PN.partner();
    let fresh = false;
    if (code.length >= 3 && !current) {
      try { localStorage.setItem(PARTNER_KEY, JSON.stringify({ code, at: Date.now() })); fresh = true; } catch (_) { /* modo privado */ }
    }
    const use = current || (code.length >= 3 ? code : null);
    if (!use) return;
    // conta a visita uma vez por navegador e mostra "Indicado por <loja>" onde a página tiver espaço
    PN.partnerInfo = PN.api("partner-hit", { code: use, count: fresh }).catch(() => ({}));
    // A página só fica "pronta" depois de saber da loja: preço de balcão e retirada nela.
    PN.ready = Promise.all([PN.ready, PN.partnerInfo]).then(([c, info]) => {
      if (c && info && info.name) {
        c.partner = info;
        c.normal_price_cents = c.price_cents;
        c.price_cents = info.price_cents || c.price_cents;
        if (Array.isArray(info.extra_prices)) c.extra_prices = info.extra_prices;
        if (info.pickup) c.pickup = info.pickup;
      }
      return c;
    });
    PN.partnerInfo.then((info) => {
      if (!info || !info.name) return;
      const show = () => document.querySelectorAll("[data-partner]").forEach((el) => {
        const name = el.querySelector("[data-partner-name]") || el;
        name.textContent = info.name;
        const extra = el.querySelector("[data-partner-extra]");
        if (extra) extra.textContent = info.pickup ? " · retire lá, sem frete" : "";
        el.hidden = false;
      });
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", show); else show();
    });
  })();

  window.PN = PN;
  document.addEventListener("DOMContentLoaded", PN.applyBrand);
})();
