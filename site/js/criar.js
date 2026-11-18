// Estúdio do cliente: foto → artes → escolha → endereço → acompanhamento.
(function () {
  const $ = (s) => document.querySelector(s);
  const views = ["loading", "login", "pending", "studio", "upsell", "extras", "address", "done"];
  // Voltou do pagamento de um enfeite adicional (Mercado Pago → criar.html?…&mais=1)?
  const fromUpsell = new URLSearchParams(location.search).has("mais");

  const state = {
    token: PN.getToken(),
    order: null,
    photo: null,        // Blob já reduzido, pronto para enviar
    photoUrl: null,
    mode: "idle",       // idle | pick | preview | working
    step: "studio",     // studio | upsell | extras | address
    upsellReturn: fromUpsell,
    upQty: 1,
    item: 0,            // enfeite em que a pessoa está trabalhando (0 = principal, 1..3 = adicionais)
    nameViewer: null,
    species: null,      // gato | cachorro | ave | roedor
    viewer: null,
    viewerFor: null,
    watching: null,     // id da geração em andamento
    uploading: false,
    timer: null,
    barTimer: null,
  };

  function show(view) {
    views.forEach((v) => { $("#view-" + v).hidden = v !== view; });
  }

  function setError(id, msg) {
    const box = $(id);
    box.textContent = msg || "";
    box.hidden = !msg;
    if (msg) box.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // ───────── enfeites do pedido (principal + adicionais) ─────────
  const itemsOf = (o) => o.items || [];
  const extraOf = (i) => itemsOf(state.order).find((it) => it.position === i);
  // tentativas e arte escolhida do enfeite em que a pessoa está
  function cur() {
    const o = state.order;
    if (state.item === 0) return { credits_total: o.credits_total, credits_left: o.credits_left, chosen_generation: o.chosen_generation };
    const it = extraOf(state.item) || { credits_total: 0, credits_left: 0, chosen_generation: null };
    return it;
  }
  // arte usada em cada enfeite ("mais um igual" usa a do principal)
  function chosenIdOf(i) {
    const o = state.order;
    if (i === 0) return o.chosen_generation;
    const it = extraOf(i);
    return it && it.kind === "copia" ? o.chosen_generation : it && it.chosen_generation;
  }
  const genById = (id) => state.order.generations.find((g) => g.id === id);
  // Nome no verso de cada enfeite: digitado logo depois de escolher a arte e guardado no aparelho.
  const namesKey = () => "pn_names_" + state.order.code;
  function nameOf(i) {
    if (!state.names) {
      try { state.names = JSON.parse(localStorage.getItem(namesKey()) || "{}"); } catch (_) { state.names = {}; }
    }
    if (state.names[i] !== undefined) return state.names[i];
    return (i === 0 ? state.order.pet_name : (extraOf(i) || {}).pet_name) || "";
  }
  function setName(i, v) {
    nameOf(i);
    state.names[i] = v;
    try { localStorage.setItem(namesKey(), JSON.stringify(state.names)); } catch (_) { /* modo privado */ }
  }
  const pieces = () => [0, ...itemsOf(state.order).map((it) => it.position)];
  const pendingExtras = () => itemsOf(state.order).filter((it) => !it.kind || (it.kind === "novo" && !it.chosen_generation));

  const doneArts = () => state.order.generations.filter((g) => g.status === "done" && g.url && (g.item || 0) === state.item);
  const processing = () => state.order.generations.find((g) => g.status === "processing");
  const chosenArt = () => genById(cur().chosen_generation);

  // ───────── carregar pedido ─────────

  const speciesKey = (item) => "pn_species_" + state.token + (item ? "_" + item : "");
  function loadSpecies(item) {
    try { return localStorage.getItem(speciesKey(item)) || null; } catch (_) { return null; }
  }
  state.species = loadSpecies(0);
  state.speciesFor = 0;

  async function load() {
    if (!state.token) return show("login");
    try {
      const out = await PN.api("order", { token: state.token });
      state.order = out.order;
      render();
    } catch (err) {
      if (err.status === 404) { PN.clearToken(); state.token = null; return show("login"); }
      // Falha de rede: tenta de novo em instantes, sem assustar.
      clearTimeout(state.timer);
      state.timer = setTimeout(load, 4000);
    }
  }

  function schedule(ms) {
    clearTimeout(state.timer);
    state.timer = setTimeout(load, ms);
  }

  // ───────── desenhar a tela ─────────

  // Botões de suporte: a mensagem já leva o código do pedido e o link de cada arte criada.
  function updateSupport() {
    const o = state.order;
    if (!o) return;
    const lines = ["Olá! Preciso de ajuda com o meu pedido " + o.code + "."];
    const arts = o.generations.filter((g) => g.status === "done" && g.share_url);
    if (arts.length) {
      lines.push("", arts.length === 1 ? "Arte que eu criei:" : "Artes que eu criei:");
      const chosen = pieces().map(chosenIdOf);
      arts.forEach((g, i) => lines.push((i + 1) + ") " + g.share_url + (chosen.includes(g.id) ? "  (escolhida)" : "")));
    }
    const link = PN.whatsappLink(lines.join("\n"));
    document.querySelectorAll("[data-support]").forEach((el) => {
      if (link) { el.href = link; el.hidden = false; } else { el.hidden = true; }
    });
  }
  PN.ready.then(updateSupport);

  // Resumo do pedido pronto para mandar no WhatsApp da loja (o dono controla tudo por lá).
  function summaryText(o) {
    const a = o.address || {};
    const pickup = o.delivery_method === "retirada";
    const lines = ["Olá! Acabei de fazer o pedido " + o.code + " 🎄", ""];
    pieces().forEach((i) => {
      const art = genById(chosenIdOf(i));
      const name = i === 0 ? o.pet_name : (extraOf(i) || {}).pet_name;
      const tag = pieces().length > 1 ? `Enfeite ${i + 1}` + (i > 0 && (extraOf(i) || {}).kind === "copia" ? " (igual ao 1)" : "") + ": " : "";
      lines.push(tag + "Pet: " + (name || "(sem nome no verso)"));
      if (art && art.share_url) lines.push("Arte: " + art.share_url);
      lines.push("");
    });
    if (pickup) {
      const p = (PN.publicConfig && PN.publicConfig.pickup) || {};
      lines.push("Retirada: " + [p.name, p.address].filter(Boolean).join(", "), "Quem retira: " + (a.recipient || o.name || ""));
    } else {
      lines.push("Entrega para: " + (a.recipient || ""),
        [a.street && a.street + ", " + a.number, a.complement].filter(Boolean).join(" — "),
        [a.district, a.city && a.city + "/" + a.state].filter(Boolean).join(" · "),
        a.cep ? "CEP " + PN.maskCep(a.cep) : "");
    }
    if (o.customer_notes) lines.push("", "Observações: " + o.customer_notes);
    if (o.amount_cents) lines.push("", "Valor pago: " + PN.money(o.amount_cents));
    return lines.filter((l) => l !== undefined).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function updateSummary() {
    const o = state.order;
    const btn = $("#wa-summary");
    const link = o && o.confirmed ? PN.whatsappLink(summaryText(o)) : null;
    btn.hidden = !link;
    if (link) btn.href = link;
    return link;
  }

  // Logo depois de confirmar: convida e leva para o WhatsApp em alguns segundos.
  function offerWhatsApp() {
    const link = updateSummary();
    if (!link) return;
    const key = "pn_wa_" + state.order.code;
    try { if (localStorage.getItem(key)) return; localStorage.setItem(key, "1"); } catch (_) { /* modo privado */ }
    const dlg = $("#wa-dialog");
    const go = $("#wa-go");
    go.href = link;
    let left = 5;
    const tick = () => {
      $("#wa-count").textContent = left > 0 ? `Abrindo o WhatsApp em ${left}…` : "Abrindo o WhatsApp…";
      if (left <= 0) { clearInterval(t); dlg.close(); location.href = link; }
      left--;
    };
    const t = setInterval(tick, 1000);
    tick();
    const stop = () => { clearInterval(t); $("#wa-count").textContent = ""; };
    go.addEventListener("click", () => { stop(); dlg.close(); }, { once: true });
    $("#wa-later").onclick = () => { stop(); dlg.close(); };
    dlg.addEventListener("cancel", stop, { once: true });
    dlg.showModal();
  }

  function render() {
    const o = state.order;
    clearTimeout(state.timer);
    updateSupport();
    $("#testbar").hidden = !o.is_test;

    if (o.payment_status === "pending") {
      show("pending");
      const pay = $("#pay-again");
      pay.hidden = !o.pay_url;
      if (o.pay_url) pay.href = o.pay_url;
      return schedule(4000);
    }
    if (o.payment_status !== "paid") {
      show("login");
      return setError("#login-error", "Este pedido foi cancelado e o valor devolvido. Fale com a gente se precisar de ajuda.");
    }
    trackPurchase(o);
    if (state.upsellReturn) {
      if (itemsOf(o).length && !(o.upsell && o.upsell.pending)) { state.upsellReturn = false; afterExtraAdded(); }
      else if (o.upsell && o.upsell.pending && !o.confirmed) state.step = "upsell";
      else state.upsellReturn = false;
    }
    if (o.confirmed && state.step !== "address") return renderDone();
    if (state.step === "address") return renderAddress();
    if (state.step === "upsell") return renderUpsell();
    if (state.step === "extras") return renderExtras();
    renderStudio();
  }

  // Avisa os anúncios da venda uma única vez por pedido (nunca em pedidos de teste).
  function trackPurchase(o) {
    if (o.is_test) return;
    const key = "pn_buy_" + o.code;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch (_) { return; }
    PN.track("Purchase", { value: o.amount_cents / 100, currency: "BRL", transaction_id: o.code });
  }

  function renderStudio() {
    const o = state.order;
    if (state.speciesFor !== state.item) { state.species = loadSpecies(state.item); state.speciesFor = state.item; }
    const arts = doneArts();
    const busy = processing();
    show("studio");

    const c = cur();
    let autoChoose = null;   // escolhe a primeira arte sozinho, depois de terminar de desenhar a tela
    // Geração que estávamos acompanhando terminou?
    if (state.watching && !busy) {
      const g = o.generations.find((x) => x.id === state.watching);
      state.watching = null;
      stopBar();
      if (g && g.status === "failed") {
        state.mode = state.photo ? "preview" : "idle";
        setError("#studio-error", "Não conseguimos criar a arte com essa foto. Sua tentativa foi devolvida — tente com outra foto, com o rosto do pet bem visível.");
      } else {
        state.mode = "idle";
        setError("#studio-error", "");
        if (arts.length === 1 && !c.chosen_generation) autoChoose = arts[0].id;
      }
      maybeShowTips();
    }
    if (busy) { state.mode = "working"; state.watching = busy.id; schedule(3000); startBar(); }
    else if (state.mode === "working" && !state.uploading) state.mode = "idle";

    // patinhas = tentativas
    const paws = $("#paws");
    paws.innerHTML = "";
    for (let i = 0; i < c.credits_total; i++) {
      const s = document.createElement("span");
      s.className = "paw" + (i < c.credits_total - c.credits_left ? " used" : "");
      s.textContent = "🐾";
      paws.appendChild(s);
    }
    const label = document.createElement("span");
    const used = c.credits_total - c.credits_left;
    label.textContent = c.credits_left === 0 ? "Você já criou todas as artes"
      : c.credits_left === 1 ? "Resta 1 arte para criar"
      : (used ? "Restam " : "Você pode criar ") + c.credits_left + " artes";
    paws.appendChild(label);

    $("#paid-banner").hidden = !(state.item === 0 && !o.generations.length);
    $("#paid-code").textContent = o.code;

    const piece = state.item ? `Enfeite ${state.item + 1}: ` : "";
    $("#studio-title").textContent = piece + (arts.length ? "escolha a arte preferida" : state.item ? "envie a foto do outro pet" : "Envie a foto do seu pet");
    if (!state.item) $("#studio-title").textContent = arts.length ? "Escolha a arte preferida" : "Envie a foto do seu pet";
    $("#back-extras").hidden = !state.item;
    $("#prog-2").classList.toggle("on", arts.length > 0);

    // artes
    $("#arts-block").hidden = arts.length === 0;
    const grid = $("#arts");
    grid.innerHTML = "";
    arts.forEach((g, i) => {
      const card = document.createElement("div");
      const isChosen = g.id === c.chosen_generation;
      card.className = "art-card" + (isChosen ? " chosen" : "");
      const img = document.createElement("img");
      img.src = g.url;
      img.alt = "Arte " + (i + 1) + " do seu pet";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn sm " + (isChosen ? "green" : "ghost");
      b.textContent = isChosen ? "✓ Escolhida" : "Escolher esta";
      b.addEventListener("click", () => choose(g.id));
      img.addEventListener("click", () => choose(g.id));
      card.append(img, b);
      grid.appendChild(card);
    });

    const noArts = arts.length === 0;
    const picking = state.mode === "pick" || (noArts && state.mode === "idle");
    const previewing = state.mode === "preview" || state.mode === "working";
    $("#pick-block").hidden = !picking;
    $("#cancel-pick").hidden = noArts;
    $("#preview-block").hidden = !previewing;
    $("#working").hidden = state.mode !== "working";
    $("#preview-actions").hidden = state.mode !== "preview";
    $("#preview-img").src = state.photoUrl || "img/favicon.svg";
    $("#next-block").hidden = noArts || state.mode !== "idle";

    const picked = chosenArt();
    $("#viewer-block").hidden = !picked || state.mode !== "idle";
    if (picked && state.mode === "idle") show3D(picked);
    const pn = $("#pet-name");
    if (document.activeElement !== pn) pn.value = nameOf(state.item);

    // tipo de pet: aparece enquanto a pessoa escolhe ou confere a foto
    $("#species-block").hidden = !(picking || state.mode === "preview");
    document.querySelectorAll("[data-species]").forEach((b) => {
      const on = b.dataset.species === state.species;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    $("#drop").classList.toggle("locked", !state.species);
    $("#drop-label").textContent = state.species ? "Toque para escolher a foto" : "Primeiro, escolha o tipo de pet acima";

    const go = $("#go-address");
    go.disabled = !c.chosen_generation;
    go.textContent = c.chosen_generation ? "Continuar com esta arte →" : "Escolha uma arte acima";

    $("#again-block").hidden = false;
    $("#again-same").hidden = c.credits_left === 0 || !state.photo;
    $("#again-other").hidden = c.credits_left === 0;
    $("#again-text").textContent = c.credits_left === 0
      ? "Você já criou todas as suas artes. Escolha a preferida para continuar."
      : "Quer ver outra opção?";
    $("#none-liked").hidden = c.credits_left !== 0;
    if (autoChoose) choose(autoChoose);
    maybeWelcome();
  }

  // Enfeites adicionais: para cada um, "outro pet" (cria a arte) ou "mais um igual".
  function renderExtras() {
    const o = state.order;
    show("extras");
    const one = itemsOf(o).length === 1;
    $("#extras-title").textContent = one ? "Seu 2º enfeite" : "Seus outros enfeites";
    $("#extras-sub").textContent = one ? "É de outro pet ou igual ao primeiro?" : "Para cada um: é de outro pet ou igual ao primeiro?";
    const list = $("#extras-list");
    list.replaceChildren(...itemsOf(o).map((it) => {
      const n = it.position + 1;
      const card = document.createElement("div");
      card.className = "extra-card" + (it.kind && (it.kind === "copia" || it.chosen_generation) ? " ready" : "");
      const art = genById(chosenIdOf(it.position));
      const thumb = document.createElement("div");
      thumb.className = "extra-thumb";
      if (art && art.url) { const im = document.createElement("img"); im.src = art.url; im.alt = "Arte do enfeite " + n; thumb.appendChild(im); }
      else thumb.textContent = "🐾";
      const body = document.createElement("div");
      const h = document.createElement("h3");
      h.textContent = "Enfeite " + n;
      const p = document.createElement("p");
      p.className = "small muted";
      p.textContent = it.kind === "copia" ? "Mais um igual ao primeiro (pode ter outro nome no verso)."
        : it.kind === "novo" ? (it.chosen_generation ? "Outro pet — arte escolhida ✓" : "Outro pet — falta criar a arte.")
        : "É de outro pet ou mais um igual ao primeiro?";
      const row = document.createElement("div");
      row.className = "extra-actions";
      const bNew = document.createElement("button");
      bNew.type = "button";
      bNew.className = "btn sm " + (it.kind === "novo" ? "green" : "ghost");
      bNew.textContent = it.kind === "novo" ? (it.chosen_generation ? "Trocar a arte" : "Criar a arte →") : "🐾 Outro pet";
      bNew.addEventListener("click", () => setKind(it.position, "novo", true));
      const bCopy = document.createElement("button");
      bCopy.type = "button";
      bCopy.className = "btn sm " + (it.kind === "copia" ? "green" : "ghost");
      bCopy.textContent = it.kind === "copia" ? "✓ Mais um igual" : "Mais um igual";
      bCopy.addEventListener("click", () => setKind(it.position, "copia", false));
      row.append(bNew, bCopy);
      body.append(h, p, row);
      card.append(thumb, body);
      return card;
    }));
    const left = pendingExtras().length;
    const next = $("#extras-next");
    next.disabled = left > 0;
    next.textContent = left ? `Falta decidir ${left === 1 ? "1 enfeite" : left + " enfeites"}` : "Continuar →";
    window.scrollTo(0, 0);
  }

  async function setKind(pos, kind, openStudio) {
    setError("#extras-error", "");
    const it = extraOf(pos);
    try {
      if (!it || it.kind !== kind) {
        const out = await PN.api("item-kind", { token: state.token, item: pos, kind });
        state.order = out.order;
      }
      if (openStudio) {
        state.item = pos;
        state.step = "studio";
        state.mode = "idle";
        state.photo = null;
        render();
        window.scrollTo(0, 0);
      } else renderExtras();
    } catch (err) {
      setError("#extras-error", err.message);
    }
  }

  // Depois de escolher a arte: adicionais → tela dos adicionais; senão oferta de mais enfeites
  // (uma vez só) → endereço.
  const upKey = () => "pn_up_" + state.order.code;
  function offerUpsell() {
    const u = state.order.upsell;
    if (!u || !(u.max > 0) || !(u.price_cents > 0)) return false;
    try { return !localStorage.getItem(upKey()); } catch (_) { return true; }
  }
  function nextStep() {
    state.step = itemsOf(state.order).length ? "extras" : offerUpsell() ? "upsell" : "address";
    render();
    window.scrollTo(0, 0);
  }

  // Oferta no fim da criação: o 2º enfeite (de outro pet ou igual ao primeiro), no mesmo pacote.
  function renderUpsell() {
    const o = state.order;
    const u = o.upsell || { max: 0, price_cents: 0 };
    show("upsell");
    const art = genById(o.chosen_generation);
    ["#up-art1", "#up-art2"].forEach((id) => { $(id).src = art && art.url ? art.url : "img/exemplo-4-arte.png"; });
    $("#up-price").textContent = PN.money(u.price_cents);
    document.querySelectorAll("[data-up-price]").forEach((el) => { el.textContent = PN.money(u.price_cents); });
    document.querySelectorAll(".up-cta").forEach((el) => { el.textContent = "+ " + PN.money(u.price_cents); });
    const waiting = state.upsellReturn && u.pending;
    $("#up-offer").hidden = waiting;
    $("#up-waiting").hidden = !waiting;
    if (waiting) schedule(4000);
  }
  // Depois que o 2º enfeite entra no pedido: outro pet → criar a arte; igual → finalizar.
  function afterExtraAdded() {
    const p = pendingExtras()[0];
    if (p && p.kind === "novo") { state.item = p.position; state.step = "studio"; state.mode = "idle"; state.photo = null; }
    else if (p) { state.item = 0; state.step = "extras"; }
    else { state.item = 0; state.step = "address"; }
  }
  function skipUpsell() {
    try { localStorage.setItem(upKey(), "1"); } catch (_) { /* modo privado */ }
    state.upsellReturn = false;
    state.step = "address";
    render();
    window.scrollTo(0, 0);
  }

  // Nomes no verso: um campo por enfeite, com a prévia 3D mostrando o verso.
  function renderNames() {
    const box = $("#names");
    const o = state.order;
    const many = pieces().length > 1;
    box.replaceChildren(...pieces().map((i) => {
      const label = document.createElement("label");
      label.className = "field";
      const span = document.createElement("span");
      span.innerHTML = (many ? `Nome no verso do enfeite ${i + 1}` : "Nome do pet") + " <small>(opcional, até 16 letras)</small>";
      const input = document.createElement("input");
      input.maxLength = 16;
      input.dataset.item = i;
      input.placeholder = "Ex.: Mel";
      input.value = nameOf(i);
      input.addEventListener("input", () => setName(i, input.value));
      label.append(span, input);
      return label;
    }));
  }

  let nameTimer = null, nameSeq = 0;
  function previewName(i, name) {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(async () => {
      const art = genById(chosenIdOf(i));
      if (!art || !window.PN3D) return;
      const seq = ++nameSeq;
      const box = $("#name-viewer");
      $("#name-caption").textContent = name.trim()
        ? `Verso do enfeite${pieces().length > 1 ? " " + (i + 1) : ""}: "${name.trim()}" gravado. Arraste para ver a frente.`
        : "Verso do enfeite: digite o nome para ver como fica gravado.";
      try {
        const c = (await PN.ready) || {};
        const model = await PN3D.build(art.url, {
          ...(c.model || {}), filaments: c.filaments || [], petName: name.trim(),
          brand: (PN.config && PN.config.MARCA) || "Patinha de Natal",
        });
        if (seq !== nameSeq) return;
        if (state.nameViewer) state.nameViewer.destroy();
        state.nameViewer = await PN3D.view(box, model, { spin: true, hold: true, pose: { x: 0.05, y: Math.PI } });
      } catch (err) {
        console.warn("prévia do nome indisponível", err);
        box.hidden = true;
      }
    }, 450);
  }

  function renderAddress() {
    const o = state.order;
    state.item = 0;
    const art = chosenArt();
    if (!art) { state.step = "studio"; return renderStudio(); }
    if (pendingExtras().length) { state.step = "extras"; return renderExtras(); }
    show("address");
    const pickup = o.delivery_method === "retirada";
    const f = $("#address-form");
    $("#address-title").textContent = pickup ? "Quem vai retirar?" : "Para onde enviamos?";
    $("#recipient-label").textContent = pickup ? "Nome de quem vai retirar" : "Quem vai receber";
    $("#addr-fields").hidden = pickup;
    $("#addr-fields").querySelectorAll("input, select").forEach((el) => { el.disabled = pickup; });
    const pk = (PN.publicConfig && PN.publicConfig.pickup) || null;
    $("#pickup-box").hidden = !pickup;
    if (pickup && pk) {
      $("#pickup-place").textContent = pk.name + " — " + pk.address;
      $("#pickup-map").href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(pk.name + ", " + pk.address);
    }
    renderNames();
    const ax = $("#addr-extra");
    const u = o.upsell || {};
    ax.hidden = !(u.max > 0 && u.price_cents > 0) && !itemsOf(o).length;
    ax.textContent = u.max > 0 ? `🎁 Quer um 2º enfeite? Adicionar por ${PN.money(u.price_cents)}` : "Mudar o 2º enfeite (outro pet ou igual)";
    if (!f.dataset.filled) {
      f.dataset.filled = "1";
      const a = o.address || {};
      f.customer_notes.value = o.customer_notes || "";
      f.recipient.value = a.recipient || o.name || "";
      f.cep.value = a.cep ? PN.maskCep(a.cep) : o.checkout_cep ? PN.maskCep(o.checkout_cep) : "";
      f.street.value = a.street || "";
      f.number.value = a.number || "";
      f.complement.value = a.complement || "";
      f.district.value = a.district || "";
      f.city.value = a.city || "";
      f.state.value = a.state || "";
      if (!pickup && !a.street && o.checkout_cep && !o.locked_cep) {
        lookupCep(o.checkout_cep, true);
        $("#cep-status").textContent = "CEP informado na compra. Confira o endereço e preencha o número.";
      }
    }
    // Frete cobrado por CEP: a entrega é nesse CEP.
    if (!pickup && o.locked_cep) {
      const first = !f.cep.readOnly;
      f.cep.value = PN.maskCep(o.locked_cep);
      f.cep.readOnly = true;
      $("#cep-status").textContent = "CEP informado na compra (o frete foi calculado para ele).";
      if (first && !f.street.value) lookupCep(o.locked_cep, true);
    }
    $("#back-arts").hidden = o.confirmed;
    window.scrollTo(0, 0);
  }

  function renderDone() {
    const o = state.order;
    show("done");
    const art = chosenArt();
    if (art) $("#done-art").src = art.url;
    $("#done-code").textContent = o.code;
    const names = [o.pet_name, ...itemsOf(o).map((it) => it.pet_name)].filter(Boolean);
    $("#done-pet").textContent = (pieces().length > 1 ? ` · ${pieces().length} enfeites` : "") + (names.length ? " · " + names.join(", ") : "");
    const pickup = o.delivery_method === "retirada";

    const st = o.production_status;
    const prazo = (PN.store && PN.store.lead_time) || (PN.config && PN.config.PRAZO_PRODUCAO) || "5 dias úteis";
    $("#done-next").textContent = st === "aguardando"
      ? `Agora é com a gente: produzimos em até ${prazo} e avisamos pelo WhatsApp quando ${pickup ? "estiver pronto para retirar" : "postar, com o código de rastreio"}.`
      : st === "producao" ? "Seu enfeite está sendo produzido. 🎄" : "";
    const steps = [
      ["Pagamento confirmado", true],
      ["Arte escolhida", true],
      ["Em produção", ["producao", "enviado", "entregue"].includes(st)],
      pickup
        ? [st === "entregue" ? "Retirado" : "Pronto para retirar", ["enviado", "entregue"].includes(st)]
        : [st === "entregue" ? "Entregue" : "Enviado" + (o.tracking_code ? " — rastreio: " + o.tracking_code : ""), ["enviado", "entregue"].includes(st)],
    ];
    const tl = $("#timeline");
    tl.innerHTML = "";
    steps.forEach(([text, done]) => {
      const li = document.createElement("li");
      if (done) li.className = "done";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.textContent = done ? "✓" : "";
      li.append(dot, document.createTextNode(text));
      tl.appendChild(li);
    });

    const a = o.address;
    const box = $("#done-address");
    box.innerHTML = "";
    const title = document.createElement("strong");
    const br = () => document.createElement("br");
    const txt = (t) => document.createTextNode(t);
    if (pickup) {
      const pk = (PN.publicConfig && PN.publicConfig.pickup) || {};
      title.textContent = "Retirada";
      box.append(title, br(), txt(pk.name || ""), br(), txt(pk.address || ""), br(), txt("Quem retira: " + (a.recipient || "")));
    } else {
      title.textContent = "Entrega para";
      box.append(title, br(), txt(a.recipient), br(),
        txt(a.street + ", " + a.number + (a.complement ? " — " + a.complement : "")), br(),
        txt(a.district + " · " + a.city + "/" + a.state + " · CEP " + PN.maskCep(a.cep)));
    }
    $("#edit-address").textContent = pickup ? "Corrigir os dados" : "Corrigir o endereço";
    PN.ready.then(updateSummary);
    const notes = $("#done-notes");
    notes.hidden = !o.customer_notes;
    notes.replaceChildren();
    if (o.customer_notes) {
      const t = document.createElement("strong");
      t.textContent = "Suas observações";
      notes.append(t, document.createElement("br"), document.createTextNode(o.customer_notes));
    }
    $("#edit-address").hidden = st !== "aguardando";

    // Atualiza sozinho de vez em quando para mostrar produção/envio.
    schedule(60000);
  }

  // ───────── dicas de foto ─────────

  // Boas-vindas com as dicas da foto: 3 telas curtas, fácil de pular (Pular, Esc, fora, arrastar).
  const onb = $("#onb");
  const slides = [...onb.querySelectorAll(".onb-slide")];
  const dots = [...onb.querySelectorAll(".onb-dots i")];
  let onbAt = 0;
  function onbGo(i) {
    onbAt = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach((el, k) => { el.classList.toggle("on", k === onbAt); el.classList.toggle("past", k < onbAt); });
    dots.forEach((el, k) => el.classList.toggle("on", k === onbAt));
    $("#onb-count").textContent = onbAt + 1 + " de " + slides.length;
    $("#onb-next").textContent = onbAt === slides.length - 1 ? "Vamos lá! 📸" : "Próximo →";
  }
  function openTips(note) {
    onb.querySelectorAll("[data-onb-credits]").forEach((el) => { el.textContent = state.order ? cur().credits_total : 4; });
    const msg = typeof note === "string" ? note : "";
    $("#onb-note").textContent = msg;
    $("#onb-note").hidden = !msg;
    onbGo(0);
    if (!onb.open) onb.showModal();
  }
  function closeTips() { if (onb.open) onb.close(); }
  $("#onb-next").addEventListener("click", () => (onbAt === slides.length - 1 ? closeTips() : onbGo(onbAt + 1)));
  onb.querySelectorAll("[data-onb-close]").forEach((b) => b.addEventListener("click", closeTips));
  onb.addEventListener("click", (e) => { if (e.target === onb) closeTips(); });   // toque fora do cartão
  let onbX = null;
  onb.addEventListener("touchstart", (e) => { onbX = e.touches[0].clientX; }, { passive: true });
  onb.addEventListener("touchend", (e) => {
    if (onbX === null) return;
    const dx = e.changedTouches[0].clientX - onbX;
    onbX = null;
    if (Math.abs(dx) < 50) return;
    if (dx < 0) { if (onbAt === slides.length - 1) closeTips(); else onbGo(onbAt + 1); } else onbGo(onbAt - 1);
  });
  // Na primeira vez que a pessoa entra para enviar a foto.
  function maybeWelcome() {
    const o = state.order;
    if (state.item !== 0 || o.generations.length) return;
    const key = "pn_onb_" + o.code;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch (_) { /* modo privado: mostra mesmo assim */ }
    openTips();
  }
  // Lembrete, uma única vez, quando o cliente já gastou 2 artes e ainda tem outras.
  function maybeShowTips() {
    const o = state.order;
    const c = cur();
    const used = c.credits_total - c.credits_left;
    const key = "pn_tips_" + o.code + "_" + state.item;
    let seen = false;
    try { seen = !!localStorage.getItem(key); } catch (_) { /* modo privado */ }
    if (used < 2 || c.credits_left === 0 || seen) return;
    try { localStorage.setItem(key, "1"); } catch (_) { /* modo privado */ }
    openTips((c.credits_left === 1 ? "Você ainda pode criar 1 arte." : "Você ainda pode criar " + c.credits_left + " artes.") + " Ela fica mais parecida com uma foto assim:");
  }
  $("#open-tips").addEventListener("click", () => openTips());

  // ───────── ações ─────────

  async function choose(id) {
    const item = state.item;
    const target = item === 0 ? state.order : extraOf(item);
    if (!target || target.chosen_generation === id) return;
    const before = target.chosen_generation;
    target.chosen_generation = id;
    renderStudio();
    updateSupport();
    try {
      await PN.api("choose", { token: state.token, generation_id: id, item });
    } catch (err) {
      target.chosen_generation = before;
      renderStudio();
      setError("#studio-error", err.message);
    }
  }

  // Reduz a foto no próprio aparelho: envio rápido mesmo com internet fraca.
  async function prepare(file) {
    let source;
    try {
      source = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (_) {
      source = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Não conseguimos abrir essa foto. Tente outra."));
        img.src = URL.createObjectURL(file);
      });
    }
    const max = 1536;
    const scale = Math.min(1, max / Math.max(source.width, source.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(source.width * scale);
    canvas.height = Math.round(source.height * scale);
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    if (!blob) throw new Error("Não conseguimos abrir essa foto. Tente outra.");
    return blob;
  }

  async function onFile(file) {
    if (!file) return;
    setError("#studio-error", "");
    if (!file.type.startsWith("image/")) return setError("#studio-error", "Escolha um arquivo de foto.");
    try {
      state.photo = await prepare(file);
      if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
      state.photoUrl = URL.createObjectURL(state.photo);
      state.mode = "preview";
      renderStudio();
    } catch (err) {
      setError("#studio-error", err.message);
    }
  }

  // ───────── prévia 3D ─────────

  async function show3D(art, back) {
    if ((state.viewerFor === art.id && !back) || !window.PN3D) return;
    state.viewerFor = art.id;
    const box = $("#viewer");
    if (state.viewer) { state.viewer.destroy(); state.viewer = null; }
    box.innerHTML = '<div class="loading"><div class="spinner dark"></div>Montando a prévia…</div>';
    try {
      const c = (await PN.ready) || {};
      const model = await PN3D.build(art.url, {
        diameter: (c.model && c.model.diameter) || 70,
        base: c.model && c.model.base,
        band: c.model && c.model.band,
        filaments: c.filaments || [],
        brand: (PN.config && PN.config.MARCA) || "Patinha de Natal",
        petName: nameOf(state.item).trim(),
      });
      if (state.viewerFor !== art.id) return;
      state.viewer = await PN3D.view(box, model, back ? { spin: true, hold: true, pose: { x: 0.05, y: Math.PI } } : { spin: true });
    } catch (err) {
      // sem WebGL ou arte inacessível: mostra a foto do enfeite com a arte aplicada
      console.warn("prévia 3D indisponível", err);
      box.innerHTML = "";
      const m = document.createElement("div");
      m.className = "mockup";
      m.style.width = "100%";
      const img = document.createElement("img");
      img.src = art.url;
      img.alt = "Sua arte aplicada no enfeite";
      m.appendChild(img);
      box.appendChild(m);
    }
  }

  async function create() {
    if (!state.photo || state.mode === "working") return;
    if (!state.species) { setError("#studio-error", "Toque no tipo do seu pet: gato, cachorro, ave ou roedor."); return; }
    setError("#studio-error", "");
    state.mode = "working";
    state.uploading = true;
    renderStudio();
    startBar(true);
    try {
      const out = await PN.upload(state.token, state.photo, state.species, state.item);
      state.watching = out.generation_id;
      state.uploading = false;
      schedule(2500);
    } catch (err) {
      state.uploading = false;
      stopBar();
      state.mode = "preview";
      await load().catch(() => {});
      setError("#studio-error", err.message);
    }
  }

  function startBar(reset) {
    const bar = $("#bar");
    if (reset) { stopBar(); bar.style.width = "4%"; }
    if (state.barTimer) return;
    let pct = parseFloat(bar.style.width) || 4;
    state.barTimer = setInterval(() => {
      pct = Math.min(94, pct + (pct < 60 ? 1.4 : pct < 85 ? 0.6 : 0.15));
      bar.style.width = pct + "%";
    }, 1000);
  }

  function stopBar() {
    clearInterval(state.barTimer);
    state.barTimer = null;
  }

  // Nome no verso: atualiza a prévia 3D virada de costas para mostrar o nome gravado.
  let petNameTimer = null;
  $("#pet-name").addEventListener("input", (e) => {
    setName(state.item, e.target.value);
    clearTimeout(petNameTimer);
    petNameTimer = setTimeout(() => {
      const art = chosenArt();
      if (art) show3D(art, true);
      $("#viewer-note").textContent = e.target.value.trim() ? "Assim fica o nome gravado no verso. Arraste para ver a frente." : "Arraste para girar.";
    }, 500);
  });

  // ───────── eventos ─────────

  $("#file").addEventListener("change", (e) => { onFile(e.target.files[0]); e.target.value = ""; });
  const drop = $("#drop");
  drop.addEventListener("click", (e) => {
    if (state.species) return;
    e.preventDefault();
    setError("#studio-error", "Primeiro, toque no tipo do seu pet: gato, cachorro, ave ou roedor.");
  });
  document.querySelectorAll("[data-species]").forEach((b) => b.addEventListener("click", () => {
    state.species = b.dataset.species;
    try { localStorage.setItem(speciesKey(state.item), state.species); } catch (_) { /* modo privado */ }
    setError("#studio-error", "");
    renderStudio();
  }));
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => onFile(e.dataTransfer.files[0]));

  $("#create").addEventListener("click", create);
  $("#change").addEventListener("click", () => { state.mode = "pick"; renderStudio(); });
  $("#cancel-pick").addEventListener("click", () => { state.mode = "idle"; renderStudio(); });
  $("#again-same").addEventListener("click", create);
  $("#again-other").addEventListener("click", () => { state.mode = "pick"; renderStudio(); $("#pick-block").scrollIntoView({ behavior: "smooth", block: "center" }); });
  $("#go-address").addEventListener("click", () => {
    if (state.item) { state.item = 0; state.step = pendingExtras().length ? "extras" : "address"; state.photo = null; render(); window.scrollTo(0, 0); return; }
    nextStep();
  });
  $("#back-arts").addEventListener("click", () => { state.step = itemsOf(state.order).length ? "extras" : "studio"; render(); });
  $("#back-extras").addEventListener("click", () => { state.item = 0; state.step = "extras"; state.photo = null; render(); });
  $("#extras-next").addEventListener("click", () => { state.step = "address"; render(); });
  $("#extras-back").addEventListener("click", () => { state.item = 0; state.step = "studio"; render(); });
  $("#up-no").addEventListener("click", skipUpsell);
  $("#addr-extra").addEventListener("click", () => {
    state.upsellReturn = false;
    state.step = (state.order.upsell || {}).max > 0 ? "upsell" : "extras";
    render();
    window.scrollTo(0, 0);
  });
  $("#up-skip").addEventListener("click", skipUpsell);
  $("#up-retry").addEventListener("click", () => { state.upsellReturn = false; renderUpsell(); });
  document.querySelectorAll("[data-up-kind]").forEach((btn) => btn.addEventListener("click", async () => {
    setError("#upsell-error", "");
    document.querySelectorAll("[data-up-kind]").forEach((b) => { b.disabled = true; });
    btn.classList.add("busy");
    try {
      const out = await PN.api("add-extras", { token: state.token, qty: 1, kind: btn.dataset.upKind });
      if (out.redirect) { location.href = out.redirect; return; }
      state.order = out.order;      // pedido de teste: entra na hora
      afterExtraAdded();
      render();
      window.scrollTo(0, 0);
    } catch (err) {
      setError("#upsell-error", err.message);
    } finally {
      document.querySelectorAll("[data-up-kind]").forEach((b) => { b.disabled = false; });
      btn.classList.remove("busy");
    }
  }));
  $("#edit-address").addEventListener("click", () => { delete $("#address-form").dataset.filled; state.step = "address"; render(); });

  // endereço
  const af = $("#address-form");
  af.cep.addEventListener("input", (e) => {
    if (e.target.readOnly) return;
    e.target.value = PN.maskCep(e.target.value);
    const cep = e.target.value.replace(/\D/g, "");
    if (cep.length !== 8) { $("#cep-status").textContent = ""; return; }
    lookupCep(cep, false);
  });

  async function lookupCep(cep, quiet) {
    const status = $("#cep-status");
    if (!quiet) status.textContent = "Buscando endereço…";
    try {
      const res = await fetch("https://viacep.com.br/ws/" + cep + "/json/");
      const d = await res.json();
      if (d.erro) throw new Error();
      if (d.logradouro) af.street.value = d.logradouro;
      if (d.bairro) af.district.value = d.bairro;
      if (d.localidade) af.city.value = d.localidade;
      if (d.uf) af.state.value = d.uf;
      if (!quiet) status.textContent = "Endereço encontrado ✓ Confira e preencha o número.";
      if (!quiet) (af.street.value ? af.number : af.street).focus();
    } catch (_) {
      if (!quiet) status.textContent = "Não achamos esse CEP. Preencha o endereço abaixo.";
    }
  }

  af.addEventListener("submit", async (e) => {
    e.preventDefault();
    setError("#address-error", "");
    const btn = $("#confirm-btn");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Enviando…";
    try {
      const names = [];
      $("#names").querySelectorAll("input[data-item]").forEach((el) => { names[Number(el.dataset.item)] = el.value; });
      const out = await PN.api("confirm", {
        token: state.token,
        pet_name: names[0] || "", pet_names: names, customer_notes: af.customer_notes.value,
        recipient: af.recipient.value, cep: af.cep.value,
        street: af.street.value, number: af.number.value, complement: af.complement.value,
        district: af.district.value, city: af.city.value, state: af.state.value,
      });
      state.order = out.order;
      state.step = "studio";
      render();
      window.scrollTo(0, 0);
      PN.ready.then(offerWhatsApp);
    } catch (err) {
      setError("#address-error", err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  // entrar com e-mail + WhatsApp
  const lf = $("#login-form");
  lf.whatsapp.addEventListener("input", (e) => { e.target.value = PN.maskPhone(e.target.value); });
  lf.addEventListener("submit", async (e) => {
    e.preventDefault();
    setError("#login-error", "");
    const b = lf.querySelector("button[type=submit]");
    b.disabled = true;
    try {
      const out = await PN.api("recover", { email: lf.email.value.trim(), whatsapp: lf.whatsapp.value });
      PN.setToken(out.token);
      state.token = out.token;
      show("loading");
      await load();
    } catch (err) {
      setError("#login-error", err.message);
    } finally {
      b.disabled = false;
    }
  });

  // Tira o token da barra de endereço (ele já está salvo no aparelho).
  if (new URLSearchParams(location.search).has("t")) history.replaceState(null, "", location.pathname);

  load();
})();
