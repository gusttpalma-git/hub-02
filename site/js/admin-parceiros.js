// Painel: aba "Parceiros" — lojas que divulgam o site no balcão e ganham comissão.
(function () {
  const $ = (s, root) => (root || document).querySelector(s);
  const BASE = location.href.split(/[?#]/)[0].replace(/[^/]*$/, "");
  let partners = [];
  let loaded = false;

  const call = (a, d) => window.PNAdmin.call(a, d);
  const money = (c) => PN.money(c || 0);
  const date = (iso) => iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "—";
  const siteLink = (p) => BASE + "?p=" + p.code;
  const pageLink = (p) => BASE + "parceiro.html?k=" + p.secret;
  const materialLink = (p) => BASE + "material.html?c=" + encodeURIComponent(p.code) + "&n=" + encodeURIComponent(p.name);

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : v);
    });
    children.flat().forEach((c) => { if (c !== null && c !== undefined && c !== false) node.append(c); });
    return node;
  }

  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = "✓ Copiado";
      setTimeout(() => { btn.textContent = old; }, 1800);
    } catch (_) {
      prompt("Copie:", text);
    }
  }

  // Mensagem pronta para mandar ao dono da loja (com o link da página dele).
  function inviteText(p) {
    const first = (p.contact_name || "").split(" ")[0];
    return `Oi${first ? " " + first : ""}! Aqui é da Patinha de Natal 🐾🎄\n\n` +
      `Tá tudo pronto para a parceria com a ${p.name}:\n` +
      `• O display com o QR Code fica no balcão. O cliente aponta a câmera, manda a foto do pet e vê na hora, de graça, o pet virando enfeite de Natal.\n` +
      `• Se ele comprar (agora ou em até 30 dias), vocês ganham ${String(p.commission_pct).replace(".", ",")}% do valor dos enfeites. Não precisa fazer nada no caixa.\n` +
      `• Eu pago a comissão por Pix todo começo de mês.\n\n` +
      `Por esta página vocês acompanham testes, vendas e quanto têm a receber:\n${pageLink(p)}\n\n` +
      `Link de vocês (se quiserem postar no Instagram/WhatsApp): ${siteLink(p)}`;
  }

  function waLink(p, text) {
    const n = (p.whatsapp || "").replace(/\D/g, "");
    return "https://wa.me/" + (n ? n : "") + "?text=" + encodeURIComponent(text);
  }

  async function load() {
    try {
      const out = await call("admin-partners", {});
      partners = out.partners || [];
      loaded = true;
      render();
    } catch (err) {
      $("#p-list").replaceChildren(el("div", { class: "alert error" }, err.message));
    }
  }

  function render() {
    const active = partners.filter((p) => p.active);
    const sum = (k) => partners.reduce((a, p) => a + (p.stats[k] || 0), 0);
    const due = partners.reduce((a, p) => a + Math.max(0, p.stats.balance_cents), 0);
    const stat = (v, l) => el("div", { class: "stat" }, el("b", {}, String(v)), el("span", {}, l));
    $("#p-stats").replaceChildren(
      stat(active.length, "lojas ativas"),
      stat(partners.reduce((a, p) => a + (p.hits || 0), 0), "visitas pelo QR"),
      stat(sum("tests"), "testes iniciados"),
      stat(sum("sales"), "vendas pagas"),
      stat(money(due), "comissão a pagar"),
    );
    if (!partners.length) {
      $("#p-list").replaceChildren(el("p", { class: "muted" }, "Nenhuma loja ainda. Cadastre a primeira acima 👆"));
      return;
    }
    $("#p-list").replaceChildren(...partners.map(card));
  }

  function card(p) {
    const s = p.stats;
    const num = (v, l, cls) => el("div", { class: cls || "" }, el("b", {}, String(v)), el("span", {}, l));
    const conv = s.tests ? Math.round((s.sales / s.tests) * 100) + "%" : "—";
    const btn = (label, fn, cls) => el("button", { class: "btn " + (cls || "ghost"), type: "button", onclick: fn }, label);

    const sales = s.sales_list.length
      ? el("table", {}, el("tr", {}, el("th", {}, "Pedido"), el("th", {}, "Pago em"), el("th", {}, "Enfeites"), el("th", {}, "Comissão")),
        ...s.sales_list.map((r) => el("tr", {}, el("td", {}, r.order), el("td", {}, date(r.paid_at)), el("td", {}, String(r.ornaments)),
          el("td", {}, r.status === "pago" ? money(r.commission_cents) : "estornado"))))
      : el("p", { class: "muted" }, "Nenhuma venda ainda.");
    const pays = s.payouts.length
      ? el("table", {}, el("tr", {}, el("th", {}, "Data"), el("th", {}, "Valor"), el("th", {}, "Obs.")),
        ...s.payouts.map((r) => el("tr", {}, el("td", {}, date(r.paid_at)), el("td", {}, money(r.amount_cents)), el("td", {}, r.note || ""))))
      : el("p", { class: "muted" }, "Nenhum Pix registrado.");

    return el("article", { class: "partner" + (p.active ? "" : " off") },
      el("header", {},
        el("strong", {}, p.name),
        el("span", { class: "code" }, p.code),
        el("span", { class: "badge" }, String(p.commission_pct).replace(".", ",") + "%"),
        !p.active && el("span", { class: "badge aguardando" }, "pausada"),
      ),
      el("p", { class: "meta" }, [p.contact_name, p.city, p.whatsapp && "WhatsApp " + p.whatsapp, p.pix_key ? "Pix: " + p.pix_key : "⚠️ sem chave Pix", p.notes].filter(Boolean).join(" · ")),
      el("div", { class: "nums" },
        num(p.hits || 0, "visitas"),
        num(s.tests, "testes"),
        num(s.sales, "vendas (" + conv + ")"),
        num(s.ornaments, "enfeites"),
        num(money(s.earned_cents), "comissão total"),
        num(money(s.paid_out_cents), "já pago"),
        num(money(s.balance_cents), "a pagar", s.balance_cents > 0 ? "due" : ""),
      ),
      el("div", { class: "btns" },
        btn("🖨️ Material", () => window.open(materialLink(p), "_blank")),
        btn("📋 Link do site", (e) => copy(siteLink(p), e.currentTarget)),
        btn("📊 Página da loja", (e) => copy(pageLink(p), e.currentTarget)),
        btn("💬 Convite no WhatsApp", () => window.open(waLink(p, inviteText(p)), "_blank")),
        btn("✅ Registrar Pix", () => payout(p), s.balance_cents > 0 ? "green" : "ghost"),
        btn("✏️ Editar", () => edit(p)),
      ),
      el("details", {}, el("summary", {}, "Vendas e Pix pagos"), el("h4", {}, "Vendas"), sales, el("h4", {}, "Pix de comissão"), pays,
        el("p", { class: "muted" }, "Link da página da loja vazou? ",
          el("button", { class: "linklike", type: "button", onclick: () => newSecret(p) }, "Gerar link novo"), " (o antigo para de funcionar)."))
    );
  }

  async function payout(p) {
    const bal = p.stats.balance_cents;
    const suggestion = bal > 0 ? (bal / 100).toFixed(2).replace(".", ",") : "";
    const v = prompt(`Valor do Pix pago para ${p.name} (R$)${p.pix_key ? "\nChave Pix: " + p.pix_key : ""}\nSaldo a pagar: ${money(bal)}`, suggestion);
    if (v === null) return;
    const cents = Math.round(parseFloat(v.replace(/\./g, "").replace(",", ".")) * 100);
    if (!cents) { alert("Valor inválido."); return; }
    const note = prompt("Observação (opcional), ex.: comissão de novembro", "Comissão " + new Date().toLocaleDateString("pt-BR", { month: "long" })) || "";
    try {
      const out = await call("admin-partner-payout", { partner_id: p.id, amount_cents: cents, note });
      partners = out.partners;
      render();
    } catch (err) { alert(err.message); }
  }

  async function newSecret(p) {
    if (!confirm(`Gerar um link novo para a página da ${p.name}? O link antigo deixa de funcionar.`)) return;
    try {
      const out = await call("admin-save-partner", { ...p, new_secret: true });
      partners = out.partners;
      render();
      const np = partners.find((x) => x.id === p.id);
      if (np) prompt("Link novo da página da loja:", pageLink(np));
    } catch (err) { alert(err.message); }
  }

  // ───────── formulário ─────────

  const form = $("#p-form");
  function resetForm() {
    form.reset();
    form.id.value = "";
    form.code.disabled = false;
    $("#p-form-title").textContent = "➕ Cadastrar loja parceira";
    $("#p-save").textContent = "Cadastrar loja";
    $("#p-cancel").hidden = true;
    $("#p-active-wrap").hidden = true;
    $("#p-error").hidden = true;
  }
  function edit(p) {
    form.id.value = p.id;
    ["name", "contact_name", "pix_key", "city", "notes"].forEach((k) => { form[k].value = p[k] || ""; });
    form.whatsapp.value = (p.whatsapp || "").replace(/^55/, "");
    form.code.value = p.code;
    form.code.disabled = true; // o código está impresso no QR: não muda
    form.commission_pct.value = String(p.commission_pct).replace(".", ",");
    form.active.checked = p.active;
    $("#p-form-title").textContent = "✏️ Editar " + p.name;
    $("#p-save").textContent = "Salvar alterações";
    $("#p-cancel").hidden = false;
    $("#p-active-wrap").hidden = false;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("#p-cancel").addEventListener("click", resetForm);
  form.whatsapp.addEventListener("input", (e) => { e.target.value = PN.maskPhone(e.target.value); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const box = $("#p-error");
    box.hidden = true;
    const b = $("#p-save");
    b.disabled = true;
    try {
      const out = await call("admin-save-partner", {
        id: form.id.value || undefined,
        name: form.name.value, code: form.id.value ? undefined : form.code.value || undefined,
        contact_name: form.contact_name.value, whatsapp: form.whatsapp.value, pix_key: form.pix_key.value,
        city: form.city.value, commission_pct: form.commission_pct.value, notes: form.notes.value,
        active: form.id.value ? form.active.checked : true,
      });
      partners = out.partners;
      resetForm();
      render();
    } catch (err) {
      box.textContent = err.message;
      box.hidden = false;
    } finally {
      b.disabled = false;
    }
  });

  document.addEventListener("pn-admin-tab", (e) => { if (e.detail === "partners") load(); });
  $("#refresh").addEventListener("click", () => { if (loaded) load(); });
})();
