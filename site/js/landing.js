// Página de vendas: preços, kits, "Meu pedido" e o convite para o teste grátis.
(function () {
  const $ = (s) => document.querySelector(s);
  const recover = $("#recover");

  // Preço, kits e nº de artes vêm do servidor (o que vale é o que será cobrado).
  PN.ready.then((c) => {
    if (!c) return;
    document.querySelectorAll("[data-price]").forEach((el) => { el.textContent = PN.money(c.price_cents); });
    document.querySelectorAll("[data-credits]").forEach((el) => { el.textContent = c.credits; });
    document.querySelectorAll("[data-trial]").forEach((el) => { el.textContent = c.trial_credits || 2; });
    $("#testbar").hidden = !c.test_mode;
    renderDeadlines(c.regions || []);

    // Escada de kits: total de n+1 enfeites = preço + soma dos n primeiros adicionais.
    const extras = (c.extra_max > 0 && c.extra_prices) ? c.extra_prices : [];
    const kitTotal = (n) => c.price_cents + extras.slice(0, n).reduce((a, b) => a + b, 0);
    document.querySelectorAll("[data-kit]").forEach((el) => {
      const n = parseInt(el.dataset.kit, 10) - 1;
      el.textContent = n <= extras.length ? PN.money(kitTotal(n)) : "";
      const row = el.closest("[data-kit-row]");
      if (row) row.hidden = n > extras.length;
    });
    if (extras.length) $("#hero-kit").textContent = ` · 2 por ${PN.money(kitTotal(1))}`;
    $("#price-cards").replaceChildren(...Array.from({ length: extras.length + 1 }, (_, n) => {
      const card = document.createElement("div");
      card.className = "price-card" + (n === 1 ? " best" : "");
      if (n === 1) { const tag = document.createElement("i"); tag.textContent = "💚 melhor custo"; card.appendChild(tag); }
      const b = document.createElement("b"); b.textContent = (n + 1) + (n ? " enfeites" : " enfeite");
      const st = document.createElement("strong"); st.textContent = PN.money(kitTotal(n));
      const sm = document.createElement("small"); sm.textContent = n ? PN.money(Math.round(kitTotal(n) / (n + 1))) + " cada" : "com nome no verso";
      card.append(b, st, sm);
      return card;
    }));

    if (c.free_shipping_up_to_cents) document.querySelectorAll("[data-free-up]").forEach((el) => { el.textContent = PN.money(c.free_shipping_up_to_cents); });
    // Frete: "incluso" e "gratis_ate" são vendidos como frete grátis; os outros, calculados pelo CEP.
    const free = c.shipping_mode === "incluso" || c.shipping_mode === "gratis_ate";
    document.querySelectorAll("[data-frete]").forEach((el) => { el.textContent = free ? "Frete grátis" : "Frete calculado pelo CEP"; });
    document.querySelectorAll("[data-frete-sub]").forEach((el) => { el.textContent = c.shipping_mode === "incluso" ? "para todo o Brasil" : c.shipping_mode === "gratis_ate" ? "para quase todo o Brasil" : ""; });
  }).catch(() => { /* mantém os valores padrão do HTML */ });

  // Últimos dias para pedir, por região (definidos no painel).
  function renderDeadlines(regions) {
    const list = $("#deadline-list");
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    const fmt = (d) => d.split("-").reverse().slice(0, 2).join("/");
    const rows = regions.filter((r) => !r.on || r.until);
    list.replaceChildren(...rows.map((r) => {
      const li = document.createElement("li");
      const a = document.createElement("span");
      const b = document.createElement("span");
      a.textContent = r.label;
      if (!r.on) { li.className = "off"; b.textContent = "não entregamos"; }
      else if (r.until < today) { li.className = "closed"; b.textContent = "encerrado"; }
      else b.textContent = "até " + fmt(r.until);
      li.append(a, b);
      return li;
    }));
    $("#deadlines").hidden = !rows.length;
  }

  // Quem já tem teste ou pedido neste aparelho: "Meu pedido" abre direto e, embaixo,
  // um aviso discreto do que falta (ex.: viu a arte e ainda não pediu).
  const saved = PN.getToken();
  if (saved) {
    $("#open-recover").addEventListener("click", (e) => { e.stopImmediatePropagation(); location.href = "criar.html"; }, true);
    PN.api("order", { token: saved }).then(({ order: o }) => {
      let text = "", go = "";
      const arts = o.generations.filter((g) => g.status === "done").length;
      // Só avisa do que falta fazer (pedido concluído fica no botão "Meu pedido").
      if (o.trial && o.payment_status === "pending") {
        if (!arts) return;
        text = "A arte do seu pet está pronta";
        go = "Ver";
      } else if (o.payment_status === "paid" && !o.confirmed) {
        text = o.generations.length ? "Falta finalizar o pedido" : "Falta enviar a foto";
        go = "Continuar";
      }
      if (!text) return;
      $("#resume-text").textContent = text;
      $("#resume-go").textContent = go + " →";
      try { if (sessionStorage.getItem("pn_resume_x") === o.code) return; } catch (_) { /* modo privado */ }
      $("#resume").hidden = false;
      document.body.classList.add("has-resume");
      $("#resume-x").onclick = () => {
        $("#resume").hidden = true;
        document.body.classList.remove("has-resume");
        try { sessionStorage.setItem("pn_resume_x", o.code); } catch (_) { /* modo privado */ }
      };
    }).catch((err) => { if (err.status === 404) PN.clearToken(); });
  }

  // "Meu pedido" em outro aparelho: e-mail + WhatsApp
  $("#open-recover").addEventListener("click", () => recover.showModal());
  recover.querySelector("[data-close]").addEventListener("click", () => recover.close());
  const rf = $("#recover-form");
  rf.whatsapp.addEventListener("input", (e) => { e.target.value = PN.maskPhone(e.target.value); });
  rf.addEventListener("submit", async (e) => {
    e.preventDefault();
    const box = $("#recover-error");
    box.hidden = true;
    const b = rf.querySelector("button[type=submit]");
    b.disabled = true;
    try {
      const out = await PN.api("recover", { email: rf.email.value.trim(), whatsapp: rf.whatsapp.value });
      PN.setToken(out.token);
      location.href = "criar.html";
    } catch (err) {
      box.textContent = err.message;
      box.hidden = false;
      b.disabled = false;
    }
  });

  // Vídeo da criação: toca sozinho (sem som) quando aparece na tela.
  const video = $("#demo-video");
  if (video) {
    const play = $("#video-play");
    const start = () => { video.play().then(() => { play.hidden = true; }).catch(() => { play.hidden = false; }); };
    play.addEventListener("click", () => { video.controls = true; start(); });
    if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      new IntersectionObserver(([en]) => { if (en.isIntersecting) start(); else video.pause(); }, { threshold: 0.4 }).observe(video);
    }
  }

  // Vitrine do topo: a foto do pet e o enfeite pronto, trocando sozinhos.
  const show = $("#h-show");
  if (show) {
    const slides = [...show.querySelectorAll(".h-slide")];
    const dots = [...show.querySelectorAll(".h-dots button")];
    let at = 0, timer = null;
    const go = (i) => {
      at = (i + slides.length) % slides.length;
      slides.forEach((s, k) => s.classList.toggle("on", k === at));
      dots.forEach((d, k) => d.classList.toggle("on", k === at));
      $("#h-name").textContent = slides[at].dataset.name;
    };
    const play = () => { clearInterval(timer); if (!matchMedia("(prefers-reduced-motion: reduce)").matches) timer = setInterval(() => go(at + 1), 3200); };
    dots.forEach((d, k) => d.addEventListener("click", () => { go(k); play(); }));
    let x0 = null;
    show.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    show.addEventListener("touchend", (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 40) { go(at + (dx < 0 ? 1 : -1)); play(); }
    });
    play();
  }

  // Botão fixo no celular: aparece depois que o botão do topo sai da tela.
  const sticky = $("#sticky");
  let heroCta = true;
  new IntersectionObserver(([en]) => { heroCta = en.isIntersecting; update(); }).observe($("#h-cta"));
  function update() { sticky.classList.toggle("show", !heroCta && window.scrollY > 300); }
  window.addEventListener("scroll", update, { passive: true });
})();
