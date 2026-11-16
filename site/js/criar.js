// Estúdio do cliente: foto → artes → escolha → endereço → acompanhamento.
(function () {
  const $ = (s) => document.querySelector(s);
  const views = ["loading", "login", "pending", "studio", "address", "done"];

  const state = {
    token: PN.getToken(),
    order: null,
    photo: null,        // Blob já reduzido, pronto para enviar
    photoUrl: null,
    mode: "idle",       // idle | pick | preview | working
    step: "studio",     // studio | address
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

  const doneArts = () => state.order.generations.filter((g) => g.status === "done" && g.url);
  const processing = () => state.order.generations.find((g) => g.status === "processing");
  const chosenArt = () => state.order.generations.find((g) => g.id === state.order.chosen_generation);

  // ───────── carregar pedido ─────────

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

  function render() {
    const o = state.order;
    clearTimeout(state.timer);
    $("#testbar").hidden = !o.is_test;

    if (o.payment_status === "pending") { show("pending"); return schedule(4000); }
    if (o.payment_status !== "paid") {
      show("login");
      return setError("#login-error", "Este pedido foi cancelado e o valor devolvido. Fale com a gente se precisar de ajuda.");
    }
    if (o.confirmed && state.step !== "address") return renderDone();
    if (state.step === "address") return renderAddress();
    renderStudio();
  }

  function renderStudio() {
    const o = state.order;
    const arts = doneArts();
    const busy = processing();
    show("studio");

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
        if (arts.length === 1 && !o.chosen_generation) choose(arts[0].id);
      }
    }
    if (busy) { state.mode = "working"; state.watching = busy.id; schedule(3000); startBar(); }
    else if (state.mode === "working" && !state.uploading) state.mode = "idle";

    // patinhas = tentativas
    const paws = $("#paws");
    paws.innerHTML = "";
    for (let i = 0; i < o.credits_total; i++) {
      const s = document.createElement("span");
      s.className = "paw" + (i < o.credits_total - o.credits_left ? " used" : "");
      s.textContent = "🐾";
      paws.appendChild(s);
    }
    const label = document.createElement("span");
    label.textContent = o.credits_left === 0 ? "Você usou todas as tentativas"
      : o.credits_left === 1 ? "Resta 1 tentativa" : "Você tem " + o.credits_left + " tentativas";
    paws.appendChild(label);

    $("#studio-title").textContent = arts.length ? "Escolha a arte preferida" : "Envie a foto do seu pet";
    $("#prog-2").classList.toggle("on", arts.length > 0);

    // artes
    $("#arts-block").hidden = arts.length === 0;
    const grid = $("#arts");
    grid.innerHTML = "";
    arts.forEach((g, i) => {
      const card = document.createElement("div");
      const isChosen = g.id === o.chosen_generation;
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

    const go = $("#go-address");
    go.disabled = !o.chosen_generation;
    go.textContent = o.chosen_generation ? "Continuar com esta arte →" : "Escolha uma arte acima";

    $("#again-block").hidden = false;
    $("#again-same").hidden = o.credits_left === 0 || !state.photo;
    $("#again-other").hidden = o.credits_left === 0;
    $("#again-text").textContent = o.credits_left === 0
      ? "Você já criou todas as suas artes. Escolha a preferida para continuar."
      : "Quer ver outra opção?";
  }

  function renderAddress() {
    const o = state.order;
    const art = chosenArt();
    if (!art) { state.step = "studio"; return renderStudio(); }
    show("address");
    $("#address-art").src = art.url;
    const f = $("#address-form");
    if (!f.dataset.filled) {
      f.dataset.filled = "1";
      const a = o.address || {};
      f.pet_name.value = o.pet_name || "";
      f.recipient.value = a.recipient || o.name || "";
      f.cep.value = a.cep ? PN.maskCep(a.cep) : "";
      f.street.value = a.street || "";
      f.number.value = a.number || "";
      f.complement.value = a.complement || "";
      f.district.value = a.district || "";
      f.city.value = a.city || "";
      f.state.value = a.state || "";
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
    $("#done-pet").textContent = o.pet_name ? " · enfeite de " + o.pet_name : "";

    const st = o.production_status;
    const steps = [
      ["Pagamento confirmado", true],
      ["Arte escolhida", true],
      ["Em produção", ["producao", "enviado", "entregue"].includes(st)],
      [st === "entregue" ? "Entregue" : "Enviado" + (o.tracking_code ? " — rastreio: " + o.tracking_code : ""), ["enviado", "entregue"].includes(st)],
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
    title.textContent = "Entrega para";
    box.append(title, document.createElement("br"),
      document.createTextNode(a.recipient), document.createElement("br"),
      document.createTextNode(a.street + ", " + a.number + (a.complement ? " — " + a.complement : "")), document.createElement("br"),
      document.createTextNode(a.district + " · " + a.city + "/" + a.state + " · CEP " + PN.maskCep(a.cep)));
    $("#edit-address").hidden = st !== "aguardando";

    // Atualiza sozinho de vez em quando para mostrar produção/envio.
    schedule(60000);
  }

  // ───────── ações ─────────

  async function choose(id) {
    if (state.order.chosen_generation === id) return;
    const before = state.order.chosen_generation;
    state.order.chosen_generation = id;
    renderStudio();
    try {
      await PN.api("choose", { token: state.token, generation_id: id });
    } catch (err) {
      state.order.chosen_generation = before;
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

  async function create() {
    if (!state.photo || state.mode === "working") return;
    setError("#studio-error", "");
    state.mode = "working";
    state.uploading = true;
    renderStudio();
    startBar(true);
    try {
      const out = await PN.upload(state.token, state.photo);
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

  // ───────── eventos ─────────

  $("#file").addEventListener("change", (e) => { onFile(e.target.files[0]); e.target.value = ""; });
  const drop = $("#drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => onFile(e.dataTransfer.files[0]));

  $("#create").addEventListener("click", create);
  $("#change").addEventListener("click", () => { state.mode = "pick"; renderStudio(); });
  $("#cancel-pick").addEventListener("click", () => { state.mode = "idle"; renderStudio(); });
  $("#again-same").addEventListener("click", create);
  $("#again-other").addEventListener("click", () => { state.mode = "pick"; renderStudio(); $("#pick-block").scrollIntoView({ behavior: "smooth", block: "center" }); });
  $("#go-address").addEventListener("click", () => { state.step = "address"; render(); });
  $("#back-arts").addEventListener("click", () => { state.step = "studio"; render(); });
  $("#edit-address").addEventListener("click", () => { delete $("#address-form").dataset.filled; state.step = "address"; render(); });

  // endereço
  const af = $("#address-form");
  af.cep.addEventListener("input", async (e) => {
    e.target.value = PN.maskCep(e.target.value);
    const cep = e.target.value.replace(/\D/g, "");
    const status = $("#cep-status");
    if (cep.length !== 8) { status.textContent = ""; return; }
    status.textContent = "Buscando endereço…";
    try {
      const res = await fetch("https://viacep.com.br/ws/" + cep + "/json/");
      const d = await res.json();
      if (d.erro) throw new Error();
      if (d.logradouro) af.street.value = d.logradouro;
      if (d.bairro) af.district.value = d.bairro;
      if (d.localidade) af.city.value = d.localidade;
      if (d.uf) af.state.value = d.uf;
      status.textContent = "Endereço encontrado ✓ Confira e preencha o número.";
      (af.street.value ? af.number : af.street).focus();
    } catch (_) {
      status.textContent = "Não achamos esse CEP. Preencha o endereço abaixo.";
    }
  });

  af.addEventListener("submit", async (e) => {
    e.preventDefault();
    setError("#address-error", "");
    const btn = $("#confirm-btn");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Enviando…";
    try {
      const out = await PN.api("confirm", {
        token: state.token,
        pet_name: af.pet_name.value, recipient: af.recipient.value, cep: af.cep.value,
        street: af.street.value, number: af.number.value, complement: af.complement.value,
        district: af.district.value, city: af.city.value, state: af.state.value,
      });
      state.order = out.order;
      state.step = "studio";
      render();
      window.scrollTo(0, 0);
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
