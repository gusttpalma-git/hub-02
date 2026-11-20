// Painel do administrador: pedidos, arquivos para impressão e configurações.
(function () {
  const $ = (s, root) => (root || document).querySelector(s);
  const KEY = "pn_admin";
  let password = sessionStorage.getItem(KEY) || "";
  let orders = [];
  let filter = "aguardando";
  let maxColors = 4;
  let filaments = [];
  let modelCfg = {};

  const call = (action, data) => PN.api(action, data, password);

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

  const date = (iso) => iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

  const BUCKETS = {
    aguardando: "Para produzir",
    "aguardando-cliente": "Aguardando cliente",
    producao: "Em produção",
    enviado: "Enviados",
    entregue: "Entregues",
    reembolsado: "Reembolsados",
    pendente: "Não pagos",
  };

  function bucket(o) {
    if (o.payment_status === "pending") return "pendente";
    if (o.payment_status === "refunded") return "reembolsado";
    if (!o.confirmed_at) return "aguardando-cliente";
    return o.production_status;
  }

  // ───────── login ─────────

  async function enter(settings) {
    $("#login-view").hidden = true;
    $("#panel").hidden = false;
    $("#logout").hidden = false;
    fillSettings(settings);
    await loadOrders();
  }

  $("#login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const box = $("#login-error");
    box.hidden = true;
    password = e.target.password.value;
    try {
      const out = await call("admin-login");
      sessionStorage.setItem(KEY, password);
      enter(out.settings);
    } catch (err) {
      box.textContent = err.message;
      box.hidden = false;
    }
  });

  $("#logout").addEventListener("click", () => { sessionStorage.removeItem(KEY); location.reload(); });

  if (password) call("admin-login").then((o) => enter(o.settings)).catch(() => sessionStorage.removeItem(KEY));

  // ───────── abas ─────────

  document.querySelectorAll("[data-tab]").forEach((tab) => tab.addEventListener("click", () => {
    document.querySelectorAll("[data-tab]").forEach((t) => t.classList.toggle("on", t === tab));
    $("#tab-orders").hidden = tab.dataset.tab !== "orders";
    $("#tab-settings").hidden = tab.dataset.tab !== "settings";
  }));
  $("#refresh").addEventListener("click", loadOrders);

  // ───────── pedidos ─────────

  async function loadOrders() {
    const out = await call("admin-orders", { include_pending: true });
    orders = out.orders;
    renderOrders();
  }

  function renderOrders() {
    const real = orders.filter((o) => !o.is_test);
    const paid = real.filter((o) => o.payment_status === "paid");
    const count = (b) => orders.filter((o) => bucket(o) === b).length;

    const stats = $("#stats");
    stats.replaceChildren(
      el("div", { class: "stat" }, el("b", {}, String(count("aguardando"))), el("span", {}, "para produzir")),
      el("div", { class: "stat" }, el("b", {}, String(count("aguardando-cliente"))), el("span", {}, "aguardando o cliente")),
      el("div", { class: "stat" }, el("b", {}, String(paid.length)), el("span", {}, "pedidos pagos")),
      el("div", { class: "stat" }, el("b", {}, PN.money(paid.reduce((s, o) => s + o.amount_cents, 0))), el("span", {}, "faturamento")),
    );

    const filters = $("#filters");
    filters.replaceChildren(...["aguardando", "aguardando-cliente", "producao", "enviado", "entregue", "pendente", "todos"].map((b) =>
      el("button", { class: "chip" + (filter === b ? " on" : ""), type: "button", onclick: () => { filter = b; renderOrders(); } },
        b === "todos" ? "Todos" : BUCKETS[b], el("b", {}, String(b === "todos" ? orders.length : count(b))))));

    const list = orders.filter((o) => filter === "todos" || bucket(o) === filter);
    $("#orders").replaceChildren(...(list.length ? list.map(orderCard) : [el("p", { class: "muted center", style: "padding:40px 0" }, "Nenhum pedido aqui por enquanto.")]));
  }

  function addressText(o) {
    if (!o.confirmed_at) return "";
    if (o.delivery_method === "retirada") return "RETIRADA no ponto\nQuem retira: " + (o.recipient || "");
    return [
      o.recipient,
      o.street + ", " + o.number + (o.complement ? " — " + o.complement : ""),
      o.district,
      o.city + "/" + o.state,
      "CEP " + PN.maskCep(o.cep || ""),
    ].join("\n");
  }

  function orderCard(o) {
    const b = bucket(o);
    const chosen = o.generations.find((g) => g.id === o.chosen_generation);
    const fileBase = (o.code + (o.pet_name ? "-" + o.pet_name : "")).replace(/[^\w-]+/g, "_");

    // coluna 1 — arte e arquivos
    const colors = el("select", { "aria-label": "Número de cores do SVG" }, ...[2, 3, 4, 5, 6].map((n) => el("option", { value: n, selected: n === maxColors }, n + " cores")));
    const svgBtn = el("button", { class: "btn green sm", type: "button", onclick: async () => {
      svgBtn.disabled = true; const t = svgBtn.textContent; svgBtn.textContent = "Vetorizando…";
      try { await downloadSvg(chosen.art_url, fileBase + ".svg", parseInt(colors.value, 10)); }
      catch (err) { alert("Não foi possível gerar o SVG: " + err.message); }
      svgBtn.disabled = false; svgBtn.textContent = t;
    } }, "⬇ SVG");
    // modelo 3D pronto para imprimir (gerado aqui no navegador)
    const layersInfo = el("p", { class: "layers" });
    const make3D = async (button, kind, artUrl, petName, suffix) => {
      const t = button.textContent;
      button.disabled = true; button.textContent = "Montando o 3D…";
      try {
        const model = await PN3D.build(artUrl || chosen.art_url, {
          ...modelCfg, filaments, petName: petName || "", brand: (PN.config && PN.config.MARCA) || "Patinha de Natal",
        });
        const title = `${o.code}${suffix || ""}${petName ? " - " + petName : ""}`;
        const blob = kind === "3mf" ? await PN3D.export3MF(model, title) : await PN3D.exportSTLZip(model, title);
        const base = (o.code + (suffix || "") + (petName ? "-" + petName : "")).replace(/[^\w-]+/g, "_");
        saveBlob(blob, base + (kind === "3mf" ? ".3mf" : "-stl.zip"));
        layersInfo.textContent = "Trocas de cor: " + model.parts.slice(1).map((p) => `${p.from.toFixed(1)} mm → ${p.name}`).join(" · ");
      } catch (err) { alert("Não foi possível montar o modelo 3D: " + err.message); }
      button.disabled = false; button.textContent = t;
    };
    const model3mf = el("button", { class: "btn green sm", type: "button", onclick: () => make3D(model3mf, "3mf", chosen.art_url, o.pet_name) }, "⬇ Modelo 3D (3MF)");
    const modelStl = el("button", { class: "btn ghost sm", type: "button", onclick: () => make3D(modelStl, "stl", chosen.art_url, o.pet_name) }, "⬇ STLs por cor (.zip)");

    // enfeites adicionais do mesmo pedido (outro pet ou mais um igual)
    const extraPieces = (o.items || []).map((it) => {
      const n = it.position + 1;
      const gen = it.kind === "copia" ? chosen : o.generations.find((g) => g.id === it.chosen_generation);
      const head = el("p", { class: "piece-head" }, el("b", {}, `Enfeite ${n}`), " · ",
        it.kind === "copia" ? "igual ao 1" : it.kind === "novo" ? "outro pet" : "ainda não definido",
        it.pet_name ? ` · verso: ${it.pet_name}` : "");
      if (!gen || !gen.art_url) return el("div", { class: "piece" }, head);
      const b1 = el("button", { class: "btn green sm", type: "button", onclick: () => make3D(b1, "3mf", gen.art_url, it.pet_name, "-" + n) }, "⬇ 3MF");
      const b2 = el("button", { class: "btn ghost sm", type: "button", onclick: () => make3D(b2, "stl", gen.art_url, it.pet_name, "-" + n) }, "⬇ STLs");
      return el("div", { class: "piece" }, head, el("div", { class: "piece-row" }, el("img", { src: gen.art_url, alt: "Arte do enfeite " + n, loading: "lazy" }), b1, b2));
    });

    const art = el("div", {},
      chosen
        ? el("img", { class: "art", src: chosen.art_url, alt: "Arte escolhida", loading: "lazy" })
        : el("div", { class: "art", style: "display:grid;place-items:center;text-align:center;color:var(--muted);font-weight:700;padding:14px" }, "Cliente ainda não escolheu a arte"),
      chosen && el("div", { class: "dl" },
        model3mf, modelStl, layersInfo,
        svgBtn,
        el("label", { class: "field", style: "margin:0" }, colors),
        el("button", { class: "btn ghost sm", type: "button", onclick: () => downloadFile(chosen.art_url, fileBase + ".png") }, "⬇ PNG")),
      ...extraPieces,
      o.generations.length > 0 && el("div", { class: "thumbs" }, ...o.generations.flatMap((g) => [
        g.photo_url && el("a", { href: g.photo_url, target: "_blank", rel: "noopener", title: "Foto enviada" }, el("img", { src: g.photo_url, alt: "Foto enviada", loading: "lazy" })),
        g.art_url && el("a", { href: g.art_url, target: "_blank", rel: "noopener", title: "Arte gerada", class: g.id === o.chosen_generation ? "sel" : "" }, el("img", { src: g.art_url, alt: "Arte gerada", loading: "lazy" })),
      ])),
    );

    // coluna 2 — cliente e endereço
    const addr = addressText(o);
    const copyBtn = el("button", { class: "linklike", type: "button", onclick: async () => {
      await navigator.clipboard.writeText(addr); copyBtn.textContent = "Copiado ✓"; setTimeout(() => { copyBtn.textContent = "Copiar endereço"; }, 1500);
    } }, "Copiar endereço");
    const info = el("div", {},
      el("dl", {},
        el("dt", {}, "Cliente"), el("dd", {}, o.name),
        el("dt", {}, "WhatsApp"), el("dd", {}, el("a", { href: "https://wa.me/55" + o.whatsapp, target: "_blank", rel: "noopener" }, PN.maskPhone(o.whatsapp))),
        el("dt", {}, "E-mail"), el("dd", {}, o.email),
        el("dt", {}, "Pet"), el("dd", {}, o.pet_name || "—"),
        el("dt", {}, "Pago em"), el("dd", {}, date(o.paid_at) + " · " + PN.money(o.amount_cents) + (o.shipping_cents ? " (frete " + PN.money(o.shipping_cents) + ")" : "")),
        o.delivery_method !== "retirada" && o.shipping_label && el("dt", {}, "Envio"),
        o.delivery_method !== "retirada" && o.shipping_label && el("dd", {}, o.shipping_label + (o.shipping_cost_cents ? " · custo " + PN.money(o.shipping_cost_cents) : "") + " (compre esta etiqueta no Melhor Envio)"),
        el("dt", {}, "Artes"), el("dd", {}, o.credits_used + " de " + o.credits_total + " usadas"),
      ),
      o.customer_notes && el("div", { class: "alert info", style: "margin:12px 0 0" }, "Observações do cliente: " + o.customer_notes),
      addr ? el("div", {}, el("div", { class: "addr" }, addr), copyBtn) : el("p", { class: "muted small", style: "margin-top:12px" }, "Endereço ainda não informado."),
    );

    // coluna 3 — produção
    const status = el("select", {}, ...[["aguardando", "Para produzir"], ["producao", "Em produção"], ["enviado", o.delivery_method === "retirada" ? "Pronto para retirar" : "Enviado"], ["entregue", o.delivery_method === "retirada" ? "Retirado" : "Entregue"]]
      .map(([v, t]) => el("option", { value: v, selected: o.production_status === v }, t)));
    const tracking = el("input", { value: o.tracking_code || "", placeholder: "Ex.: AA123456789BR", maxlength: 40 });
    const notes = el("textarea", { rows: 2, placeholder: "Só você vê", maxlength: 1000 }, o.admin_notes || "");
    const save = el("button", { class: "btn green sm block", type: "button", onclick: async () => {
      save.disabled = true;
      try {
        await call("admin-update-order", { id: o.id, production_status: status.value, tracking_code: tracking.value, admin_notes: notes.value });
        await loadOrders();
      } catch (err) { alert(err.message); save.disabled = false; }
    } }, "Salvar");
    const extra = el("button", { class: "linklike", type: "button", onclick: async () => {
      if (!confirm("Dar mais 1 tentativa de arte para este cliente?" + (o.confirmed_at ? "\nO pedido volta para a etapa de escolha." : ""))) return;
      await call("admin-update-order", { id: o.id, extra_credits: 1, reopen: true });
      await loadOrders();
    } }, "+1 tentativa de arte");
    const controls = el("div", {},
      el("label", { class: "field" }, el("span", {}, "Situação"), status),
      el("label", { class: "field" }, el("span", {}, "Código de rastreio"), tracking),
      el("label", { class: "field" }, el("span", {}, "Anotações"), notes),
      save,
      o.payment_status === "paid" && o.production_status === "aguardando" && el("p", { class: "center", style: "margin:8px 0 0" }, extra),
    );

    return el("article", { class: "order" },
      el("header", {},
        el("strong", {}, o.order_no ? "#" + String(o.order_no).padStart(3, "0") + " · " + o.code : o.code),
        el("span", { class: "badge " + b }, BUCKETS[b] || b),
        o.delivery_method === "retirada" && el("span", { class: "badge retirada" }, "🏠 Retirada"),
        (o.extras || 0) > 0 && el("span", { class: "badge extras" }, `${(o.extras || 0) + 1} enfeites`),
        o.is_test && el("span", { class: "badge teste" }, "TESTE"),
        el("span", { class: "muted small" }, "criado em " + date(o.created_at))),
      art, info, o.payment_status === "paid" ? controls : el("div", {}));
  }

  // ───────── arquivos ─────────

  function saveBlob(blob, name) {
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function downloadFile(url, name) {
    const blob = await (await fetch(url)).blob();
    saveBlob(blob, blob.type === "image/svg+xml" ? name.replace(/\.png$/, ".svg") : name);
  }

  // Escolhe as N cores principais da arte (k-means sobre um histograma) e devolve
  // a paleta + o mapa de qual cor cada pixel usa. O ponto de partida pega as cores
  // mais diferentes entre si, para o contorno preto e os detalhes não se perderem.
  function quantize(data, count, n) {
    const bins = new Map();
    for (let i = 0; i < count; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const bin = bins.get(key);
      if (bin) { bin.w++; bin.r += r; bin.g += g; bin.b += b; } else bins.set(key, { w: 1, r, g, b });
    }
    const pts = [...bins.values()].map((p) => ({ w: p.w, r: p.r / p.w, g: p.g / p.w, b: p.b / p.w }));
    const dist = (p, c) => (p.r - c.r) ** 2 + (p.g - c.g) ** 2 + (p.b - c.b) ** 2;
    const nearest = (p, pal) => { let best = 0, bd = Infinity; for (let k = 0; k < pal.length; k++) { const d = dist(p, pal[k]); if (d < bd) { bd = d; best = k; } } return [best, bd]; };

    const pal = [pts.reduce((a, p) => (p.w > a.w ? p : a))].map((p) => ({ r: p.r, g: p.g, b: p.b }));
    while (pal.length < Math.min(n, pts.length)) {
      let pick = null, score = -1;
      for (const p of pts) { const s = nearest(p, pal)[1] * Math.sqrt(p.w); if (s > score) { score = s; pick = p; } }
      pal.push({ r: pick.r, g: pick.g, b: pick.b });
    }
    for (let it = 0; it < 12; it++) {
      const acc = pal.map(() => ({ w: 0, r: 0, g: 0, b: 0 }));
      for (const p of pts) { const a = acc[nearest(p, pal)[0]]; a.w += p.w; a.r += p.r * p.w; a.g += p.g * p.w; a.b += p.b * p.w; }
      acc.forEach((a, k) => { if (a.w) pal[k] = { r: a.r / a.w, g: a.g / a.w, b: a.b / a.w }; });
    }
    const idx = new Uint8Array(count);
    const cache = new Map();
    for (let i = 0; i < count; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const key = (r << 16) | (g << 8) | b;
      let k = cache.get(key);
      if (k === undefined) { k = nearest({ r, g, b }, pal)[0]; cache.set(key, k); }
      idx[i] = k;
    }
    return { pal: pal.map((c) => ({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), a: 255 })), idx };
  }

  // Filtro de maioria 3×3: apaga pontinhos soltos e serrilhado entre as cores.
  function smooth(idx, w, h, n, passes) {
    let src = idx;
    for (let pass = 0; pass < passes; pass++) {
      const out = new Uint8Array(src);
      const votes = new Uint8Array(n);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          votes.fill(0);
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) votes[src[(y + dy) * w + x + dx]]++;
          const me = src[y * w + x];
          let best = me;
          for (let k = 0; k < n; k++) if (votes[k] > votes[best]) best = k;
          if (votes[best] >= 5) out[y * w + x] = best;
        }
      }
      src = out;
    }
    return src;
  }

  // Vetoriza a arte no próprio navegador: poucas cores chapadas, sem degradê,
  // do jeito que os fatiadores (Bambu Studio, Orca, Prusa) gostam de importar.
  async function downloadSvg(url, name, colors) {
    const blob = await (await fetch(url)).blob();
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("imagem inválida"));
      i.src = URL.createObjectURL(blob);
    });
    const size = 1024;
    const canvas = el("canvas", { width: size, height: size });
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    URL.revokeObjectURL(img.src);
    await new Promise((r) => setTimeout(r, 30)); // deixa o botão mostrar "Vetorizando…"

    const image = ctx.getImageData(0, 0, size, size);
    const q = quantize(image.data, size * size, colors);
    const idx = smooth(q.idx, size, size, q.pal.length, 2);
    for (let i = 0; i < idx.length; i++) {
      const c = q.pal[idx[i]];
      image.data[i * 4] = c.r; image.data[i * 4 + 1] = c.g; image.data[i * 4 + 2] = c.b; image.data[i * 4 + 3] = 255;
    }
    const svg = window.ImageTracer.imagedataToSVG(image, {
      pal: q.pal, colorquantcycles: 1, mincolorratio: 0,
      ltres: 1, qtres: 1, pathomit: 12, blurradius: 0, linefilter: false, rightangleenhance: false,
      strokewidth: 0, roundcoords: 1, viewbox: true, desc: false, scale: 1,
    });
    saveBlob(new Blob([svg], { type: "image/svg+xml" }), name);
  }

  // ───────── configurações ─────────

  function fillSettings(s) {
    const f = $("#settings");
    const brl = (cents) => ((cents || 0) / 100).toFixed(2).replace(".", ",");
    f.price.value = (s.price_cents / 100).toFixed(2).replace(".", ",");
    f.credits.value = s.credits_per_order;
    f.test_mode.checked = s.test_mode;
    maxColors = s.max_colors || 4;
    const pick = s.pickup || {};
    f.pickup_enabled.checked = pick.enabled !== false;
    f.pickup_name.value = pick.name || "";
    f.pickup_address.value = pick.address || "";
    f.ntfy_topic.value = s.ntfy_topic || "";
    $("#ntfy-link").textContent = s.ntfy_topic ? "ntfy.sh/" + s.ntfy_topic : "(salve um tópico primeiro)";
    const ep = s.extra_prices_cents || [];
    [0, 1, 2].forEach((i) => { f["extra_" + i].value = brl(ep[i]); });
    kitPreview();
    f.extra_max.value = s.extra_max ?? 3;
    f.free_up_to.value = brl(s.free_shipping_up_to_cents);
    f.extra_credits.value = s.extra_credits || 3;
    filaments = s.filaments || [];
    modelCfg = s.model || {};
    f.filaments.value = s.filaments_text || "";
    renderSwatches();
    f.model_diameter.value = modelCfg.diameter ?? 70;
    f.model_base.value = modelCfg.base ?? 2.4;
    f.model_band.value = modelCfg.band ?? 0.4;
    const pk = s.package_cm || {};
    f.pk_length.value = pk.length ?? 16;
    f.pk_width.value = pk.width ?? 11;
    f.pk_height.value = pk.height ?? 2;
    REGIONS.forEach((r) => {
      const rg = (s.regions || {})[r] || { on: true, until: "" };
      f["rg_on_" + r].checked = rg.on !== false;
      f["rg_until_" + r].value = rg.until || "";
    });
    f.max_colors.value = maxColors;
    f.openai_image_model.value = s.openai_image_model;
    f.openai_image_quality.value = s.openai_image_quality;
    const st = s.store || {};
    STORE_FIELDS.forEach((k) => { f["st_" + k].value = st[k] || ""; });
    f.st_whatsapp.value = st.whatsapp ? PN.maskPhone(st.whatsapp.replace(/^55/, "")) : "";
    f.shipping_mode.value = s.shipping_mode;
    REGIONS.forEach((r) => { f["ship_" + r].value = brl(s.shipping_table[r]); });
    f.origin_cep.value = s.origin_cep ? PN.maskCep(s.origin_cep) : "";
    f.package_weight_g.value = s.package_weight_g;
    f.melhor_envio_token.value = "";
    f.resend_api_key.value = "";
    f.email_from.value = s.email_from || "";
    f.owner_email.value = s.owner_email || "";
    showShipping();
    f.mp_access_token.value = "";
    f.openai_api_key.value = "";
    f.new_password.value = "";
    $("#webhook").textContent = s.webhook_url;
    const mark = (id, v) => { const n = $(id); n.textContent = v ? "✓ configurado (" + v + ")" : "✗ falta configurar"; n.className = "state " + (v ? "ok" : "no"); };
    mark("#mp-state", s.mp_access_token);
    mark("#ai-state", s.openai_api_key);
    mark("#me-state", s.melhor_envio_token);
    mark("#mail-state", s.resend_api_key && s.email_from ? s.resend_api_key : "");

    const missing = [];
    if (!s.mp_access_token) missing.push("o Access Token do Mercado Pago");
    if (!s.openai_api_key) missing.push("a API Key da OpenAI");
    if (!(s.store || {}).whatsapp) missing.push("o WhatsApp de atendimento");
    const alert = $("#setup-alert");
    const parts = [];
    if (missing.length) parts.push("Para vender de verdade falta configurar " + missing.join(" e ") + " na aba Configurações.");
    if (s.test_mode) parts.push("O MODO DE TESTE está ligado: os pedidos não são cobrados.");
    alert.textContent = parts.join(" ");
    alert.hidden = !parts.length;
  }

  const STORE_FIELDS = ["whatsapp", "company", "cnpj", "email", "size", "lead_time", "notice", "meta_pixel_id", "google_tag_id"];
  const REGIONS = ["sudeste", "sul", "centro_oeste", "nordeste", "norte"];
  const toCents = (text) => {
    const raw = String(text).trim().replace(/[^\d.,]/g, "");
    const n = parseFloat(raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw);
    return Math.round((n || 0) * 100);
  };
  function showShipping() {
    const mode = $("#settings").shipping_mode.value;
    $("#ship-table").hidden = mode === "incluso";
    $("#ship-me").hidden = mode !== "melhor_envio" && mode !== "gratis_ate";
    $("#ship-free").hidden = mode !== "gratis_ate";
  }
  $("#settings").shipping_mode.addEventListener("change", showShipping);

  function renderSwatches() {
    const lines = $("#settings").filaments.value.split(/\n/);
    const items = lines.map((l) => /^(.*?)[\s:;,-]*(#[0-9a-f]{6})\s*$/i.exec(l.trim())).filter((m) => m && m[1].trim());
    $("#swatches").replaceChildren(...items.map((m) => el("span", {}, el("i", { style: "background:" + m[2] }), m[1].trim())));
  }
  $("#settings").filaments.addEventListener("input", renderSwatches);

  $("#settings").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const msg = $("#settings-msg");
    msg.hidden = true;
    const raw = f.price.value.trim().replace(/[^\d.,]/g, "");
    const price = Math.round(parseFloat(raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw) * 100);
    try {
      if (!(price >= 100)) throw new Error("Confira o preço.");
      const out = await call("admin-save-settings", {
        price_cents: price,
        credits_per_order: f.credits.value,
        test_mode: f.test_mode.checked,
        max_colors: f.max_colors.value,
        store: Object.fromEntries(STORE_FIELDS.map((k) => [k, f["st_" + k].value])),
        filaments: f.filaments.value,
        pickup: { enabled: f.pickup_enabled.checked, name: f.pickup_name.value, address: f.pickup_address.value },
        ntfy_topic: f.ntfy_topic.value,
        extra_prices_cents: [0, 1, 2].map((i) => toCents(f["extra_" + i].value)),
        extra_max: f.extra_max.value,
        free_shipping_up_to_cents: toCents(f.free_up_to.value),
        extra_credits: f.extra_credits.value,
        model: { diameter: f.model_diameter.value, base: f.model_base.value, band: f.model_band.value },
        package_cm: { length: f.pk_length.value, width: f.pk_width.value, height: f.pk_height.value },
        regions: Object.fromEntries(REGIONS.map((r) => [r, { on: f["rg_on_" + r].checked, until: f["rg_until_" + r].value }])),
        shipping_mode: f.shipping_mode.value,
        shipping_table: Object.fromEntries(REGIONS.map((r) => [r, toCents(f["ship_" + r].value)])),
        origin_cep: f.origin_cep.value,
        package_weight_g: f.package_weight_g.value,
        melhor_envio_token: f.melhor_envio_token.value,
        resend_api_key: f.resend_api_key.value,
        email_from: f.email_from.value,
        owner_email: f.owner_email.value,
        mp_access_token: f.mp_access_token.value,
        openai_api_key: f.openai_api_key.value,
        openai_image_model: f.openai_image_model.value,
        openai_image_quality: f.openai_image_quality.value,
        new_password: f.new_password.value,
      });
      if (f.new_password.value) { password = f.new_password.value; sessionStorage.setItem(KEY, password); }
      fillSettings(out.settings);
      msg.textContent = "Configurações salvas ✓";
      msg.className = "alert ok";
    } catch (err) {
      msg.textContent = err.message;
      msg.className = "alert error";
    }
    msg.hidden = false;
  });

  // Notificações no celular (app ntfy): sugere um tópico secreto e manda um teste.
  $("#ntfy-new").addEventListener("click", () => {
    const r = crypto.getRandomValues(new Uint8Array(6));
    $("#settings").ntfy_topic.value = "patinha-" + Array.from(r, (b) => b.toString(16).padStart(2, "0")).join("");
  });
  $("#ntfy-test").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try { await call("admin-test-notify", {}); b.textContent = "✓ Enviado! Veja o celular"; }
    catch (err) { alert(err.message); }
    finally { setTimeout(() => { b.disabled = false; b.textContent = "Enviar notificação de teste"; }, 3000); }
  });

  // Configurações em abas: mostra só os quadros do assunto escolhido.
  function showSub(g) {
    document.querySelectorAll("#subtabs [data-sub]").forEach((b) => b.classList.toggle("on", b.dataset.sub === g));
    document.querySelectorAll("#settings .card[data-group]").forEach((c) => { c.hidden = c.dataset.group !== g; });
    try { localStorage.setItem("pn_admin_sub", g); } catch (_) { /* modo privado */ }
  }
  document.querySelectorAll("#subtabs [data-sub]").forEach((b) => b.addEventListener("click", () => showSub(b.dataset.sub)));
  let firstSub = "vendas";
  try { firstSub = localStorage.getItem("pn_admin_sub") || "vendas"; } catch (_) { /* modo privado */ }
  showSub(firstSub);
  const syncWarn = () => { $("#test-warn").hidden = !$("#settings").test_mode.checked; };
  $("#settings").test_mode.addEventListener("change", syncWarn);
  new MutationObserver(syncWarn).observe($("#settings"), { subtree: true, attributes: true, attributeFilter: ["value"] });
  setInterval(syncWarn, 1500);

  // Mostra como ficam os kits enquanto os preços são editados.
  function kitPreview() {
    const f = $("#settings");
    const price = toCents(f.price.value);
    let total = price;
    const parts = ["1 por " + PN.money(price)];
    [0, 1, 2].slice(0, Math.min(3, parseInt(f.extra_max.value, 10) || 0)).forEach((i) => {
      total += toCents(f["extra_" + i].value);
      parts.push(`${i + 2} por ${PN.money(total)} (${PN.money(Math.round(total / (i + 2)))} cada)`);
    });
    $("#kit-preview").textContent = "Kits: " + parts.join(" · ");
  }
  ["price", "extra_0", "extra_1", "extra_2", "extra_max"].forEach((n) => $("#settings")[n].addEventListener("input", kitPreview));
})();
