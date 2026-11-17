// Página de vendas: preço, formulário de compra e "Já comprei".
(function () {
  const $ = (s) => document.querySelector(s);
  const form = $("#checkout");
  const errorBox = $("#checkout-error");
  const btn = $("#checkout-btn");
  const recover = $("#recover");
  const btnLabel = btn.innerHTML;

  function showError(box, msg) {
    box.textContent = msg;
    box.hidden = !msg;
    if (msg) box.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // Preço e nº de tentativas vêm do servidor (o que vale é o que será cobrado).
  PN.ready.then((c) => {
    if (!c) return;
    document.querySelectorAll("[data-price]").forEach((el) => { el.textContent = PN.money(c.price_cents); });
    document.querySelectorAll("[data-credits]").forEach((el) => { el.textContent = c.credits; });
    $("#testbar").hidden = !c.test_mode;
    state.price = c.price_cents;
    state.calcShipping = c.shipping_mode === "calculado";
    renderDeadlines(c.regions || []);
    state.extraPrices = c.extra_prices || [];
    renderExtras();
    if (c.pickup) {
      $("#delivery").hidden = false;
      $("#pickup-label").textContent = "Sem frete · " + c.pickup.name + ", " + c.pickup.address;
    }
    document.querySelectorAll("[data-frete]").forEach((el) => { el.textContent = state.calcShipping ? "+ frete para o seu CEP" : "frete incluso"; });
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

  // ───────── valor do pedido: enfeite + adicionais + frete ─────────

  const state = { price: 4990, calcShipping: false, quotedCep: "", cepError: "", extras: 0, extraPrices: [], shipping: 0, days: null };
  const delivery = () => (form.querySelector("input[name=delivery]:checked") || {}).value || "correios";
  const extrasCents = () => state.extraPrices.slice(0, state.extras).reduce((a, b) => a + b, 0);

  function updateTotals() {
    const pickup = delivery() === "retirada";
    const ship = pickup ? 0 : state.shipping;
    const total = state.price + extrasCents() + ship;
    const showShip = !pickup && state.calcShipping && state.quotedCep;
    $("#row-extras").hidden = !state.extras;
    $("#quote-extras").textContent = PN.money(extrasCents());
    $("#extras-label").textContent = state.extras === 1 ? "1 enfeite adicional" : state.extras + " enfeites adicionais";
    $("#row-ship").hidden = !showShip;
    $("#quote-label").textContent = state.days ? "· cerca de " + state.days + " dias úteis" : "";
    $("#quote-shipping").textContent = ship ? PN.money(ship) : "Grátis";
    $("#quote-total").textContent = PN.money(total);
    $("#totals").hidden = !(state.extras || showShip);
    $("#btn-total").textContent = PN.money(total);
  }

  // Enfeites adicionais (outro pet ou mais um igual), com preço menor a cada um.
  function renderExtras() {
    const box = $("#extras");
    if (!state.extraPrices.length) { box.hidden = true; return; }
    box.hidden = false;
    $("#extras-count").textContent = state.extras;
    $("#extras-minus").disabled = state.extras === 0;
    $("#extras-plus").disabled = state.extras >= state.extraPrices.length;
    $("#extras-prices").textContent = state.extraPrices.map((c, i) => `${i + 2}º enfeite ${PN.money(c)}`).join("  ·  ");
    updateTotals();
  }
  $("#extras-minus").addEventListener("click", () => { state.extras = Math.max(0, state.extras - 1); renderExtras(); requote(); });
  $("#extras-plus").addEventListener("click", () => { state.extras = Math.min(state.extraPrices.length, state.extras + 1); renderExtras(); requote(); });

  // Entrega pelos Correios ou retirada no ponto.
  form.querySelectorAll("input[name=delivery]").forEach((r) => r.addEventListener("change", () => {
    const pickup = delivery() === "retirada";
    $("#cep-field").hidden = pickup;
    $("#quote-status").hidden = pickup;
    updateTotals();
    if (!pickup) requote();
  }));

  // Frete e região: conferidos no servidor assim que o CEP fica completo.
  let quoteSeq = 0;
  async function requote() {
    const cep = form.cep.value.replace(/\D/g, "");
    const status = $("#quote-status");
    if (delivery() === "retirada") return;
    if (cep.length !== 8) { status.textContent = ""; state.quotedCep = ""; state.cepError = ""; state.shipping = 0; updateTotals(); return; }
    const seq = ++quoteSeq;
    status.textContent = state.calcShipping ? "Calculando o frete…" : "Conferindo o CEP…";
    try {
      const q = await PN.api("quote", { cep, extras: state.extras });
      if (seq !== quoteSeq) return;
      state.quotedCep = cep;
      state.cepError = "";
      state.shipping = q.shipping_cents || 0;
      state.days = q.days;
      status.textContent = state.calcShipping ? "" : "✓ Entregamos no seu endereço. Frete incluso.";
    } catch (err) {
      if (seq !== quoteSeq) return;
      state.cepError = err.message;
      state.shipping = 0;
      status.textContent = err.message;
    }
    updateTotals();
  }
  form.cep.addEventListener("input", (e) => { e.target.value = PN.maskCep(e.target.value); requote(); });

  // Quem já tem pedido neste aparelho vê um atalho no lugar de "Já comprei".
  const saved = PN.getToken();
  if (saved) {
    const link = $("#open-recover");
    link.textContent = "Continuar meu pedido →";
    link.addEventListener("click", (e) => { e.stopImmediatePropagation(); location.href = "criar.html"; }, true);
  }

  if (new URLSearchParams(location.search).get("pagamento") === "falhou") {
    showError(errorBox, "O pagamento não foi concluído. Você pode tentar de novo aqui embaixo.");
  }

  form.whatsapp.addEventListener("input", (e) => { e.target.value = PN.maskPhone(e.target.value); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError(errorBox, "");
    const data = {
      name: form.name.value.trim(),
      email: form.email.value.trim(),
      whatsapp: form.whatsapp.value,
      cep: form.cep.value,
      delivery: delivery(),
      extras: state.extras,
      site_url: location.href.split(/[?#]/)[0],
    };
    if (data.name.length < 3) { form.name.focus(); return showError(errorBox, "Digite seu nome completo."); }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) { form.email.focus(); return showError(errorBox, "Confira seu e-mail."); }
    if (data.whatsapp.replace(/\D/g, "").length < 10) { form.whatsapp.focus(); return showError(errorBox, "Confira seu WhatsApp com DDD."); }

    if (data.delivery !== "retirada") {
      if (data.cep.replace(/\D/g, "").length !== 8) { form.cep.focus(); return showError(errorBox, "Digite o CEP de entrega."); }
      if (state.cepError) { form.cep.focus(); return showError(errorBox, state.cepError); }
    }

    btn.disabled = true;
    btn.textContent = "Abrindo o pagamento…";
    PN.track("InitiateCheckout", { value: (state.price + extrasCents()) / 100, currency: "BRL" });
    try {
      const out = await PN.api("checkout", data);
      PN.setToken(out.token);
      location.href = out.redirect;
    } catch (err) {
      showError(errorBox, err.message);
      btn.disabled = false;
      btn.innerHTML = btnLabel;
    }
  });

  // "Já comprei"
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

  // Botão fixo no celular: aparece depois do topo e some quando o formulário está na tela.
  const sticky = $("#sticky");
  let formVisible = false;
  new IntersectionObserver(([en]) => { formVisible = en.isIntersecting; update(); }, { threshold: 0.15 }).observe($("#comprar"));
  function update() { sticky.classList.toggle("show", window.scrollY > 500 && !formVisible); }
  window.addEventListener("scroll", update, { passive: true });
})();
