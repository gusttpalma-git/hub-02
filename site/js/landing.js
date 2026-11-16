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
    $("#cep-block").hidden = !state.calcShipping;
    document.querySelectorAll("[data-frete]").forEach((el) => { el.textContent = state.calcShipping ? "+ frete para o seu CEP" : "frete incluso"; });
  }).catch(() => { /* mantém os valores padrão do HTML */ });

  // Frete: calculado no servidor assim que o CEP fica completo.
  const state = { price: 4990, calcShipping: false, quotedCep: "" };
  form.cep.addEventListener("input", async (e) => {
    e.target.value = PN.maskCep(e.target.value);
    const cep = e.target.value.replace(/\D/g, "");
    const status = $("#quote-status");
    if (cep.length !== 8) { $("#totals").hidden = true; status.textContent = ""; state.quotedCep = ""; return; }
    status.textContent = "Calculando o frete…";
    try {
      const q = await PN.api("quote", { cep });
      if (form.cep.value.replace(/\D/g, "") !== cep) return;
      state.quotedCep = cep;
      status.textContent = "";
      $("#quote-label").textContent = q.days ? "· cerca de " + q.days + " dias úteis" : "";
      $("#quote-shipping").textContent = q.shipping_cents ? PN.money(q.shipping_cents) : "Grátis";
      $("#quote-total").textContent = PN.money(q.total_cents);
      $("#btn-total").textContent = PN.money(q.total_cents);
      $("#totals").hidden = false;
    } catch (err) {
      $("#totals").hidden = true;
      status.textContent = err.message;
    }
  });

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
      site_url: location.href.split(/[?#]/)[0],
    };
    if (data.name.length < 3) { form.name.focus(); return showError(errorBox, "Digite seu nome completo."); }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) { form.email.focus(); return showError(errorBox, "Confira seu e-mail."); }
    if (data.whatsapp.replace(/\D/g, "").length < 10) { form.whatsapp.focus(); return showError(errorBox, "Confira seu WhatsApp com DDD."); }

    if (state.calcShipping && data.cep.replace(/\D/g, "").length !== 8) { form.cep.focus(); return showError(errorBox, "Digite o CEP de entrega para calcularmos o frete."); }

    btn.disabled = true;
    btn.textContent = "Abrindo o pagamento…";
    PN.track("InitiateCheckout", { value: state.price / 100, currency: "BRL" });
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
