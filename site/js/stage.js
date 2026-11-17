// Apresentação do topo: foto → arte → peça 3D → na árvore.
// Anda sozinha (com barras de progresso), mas dá para avançar, voltar e girar o 3D.
(function () {
  const stage = document.getElementById("stage");
  if (!stage) return;
  const $ = (s) => stage.querySelector(s);
  const layers = [...stage.querySelectorAll(".stage-layer")];
  const tabs = [...stage.querySelectorAll("[data-go]")];
  const bars = [...stage.querySelectorAll(".stage-bars i")];
  const hint = $("#stage-hint");
  const scan = $("#stage-scan");
  const STEPS = [
    { title: "Você envia uma foto", text: "Qualquer foto do celular, com o rostinho aparecendo.", ms: 3200 },
    { title: "A gente cria a arte", text: "Desenho exclusivo, nas cores reais dos nossos filamentos.", ms: 3200 },
    { title: "Vira uma peça em 3D", text: "Impressa com relevo. Arraste para girar e ver o nome no verso.", ms: 6000 },
    { title: "E vai para a sua árvore", text: "Pronta para pendurar e guardar por muitos Natais.", ms: 3800 },
  ];
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let step = 0, timer = null, paused = false, resumeTimer = null, viewer = null, building = false, touched3D = false;

  function show(n, fromUser) {
    step = (n + STEPS.length) % STEPS.length;
    layers.forEach((l) => l.classList.toggle("on", Number(l.dataset.step) === step));
    tabs.forEach((b) => b.classList.toggle("on", Number(b.dataset.go) === step));
    $("#stage-num").textContent = step + 1;
    $("#stage-title").textContent = STEPS[step].title;
    $("#stage-text").textContent = STEPS[step].text;
    hint.hidden = !(step === 2 && viewer && !touched3D);
    if (step === 1 && !reduced) { scan.classList.remove("run"); void scan.offsetWidth; scan.classList.add("run"); }
    if (step >= 1) ensure3D();
    if (fromUser) pauseFor(9000);
    schedule();
  }

  function paintBars() {
    bars.forEach((b, i) => {
      b.classList.remove("run", "done", "hold");
      if (i < step) b.classList.add("done");
    });
    const cur = bars[step];
    void cur.offsetWidth;
    if (paused || reduced) cur.classList.add("hold");
    else { cur.style.setProperty("--dur", STEPS[step].ms + "ms"); cur.classList.add("run"); }
  }

  function schedule() {
    clearTimeout(timer);
    paintBars();
    if (paused || reduced) return;
    timer = setTimeout(() => show(step + 1), STEPS[step].ms);
  }

  // Depois que a pessoa mexe, espera um pouco e volta a andar sozinha.
  function pauseFor(ms) {
    paused = true;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { paused = false; schedule(); }, ms);
  }

  async function ensure3D() {
    if (viewer || building || !window.PN3D || !window.earcut) return;
    building = true;
    try {
      const c = (await (window.PN && PN.ready)) || {};
      const model = await PN3D.build("img/exemplo-4-arte.png", {
        petName: "Mimi",
        brand: (PN.config && PN.config.MARCA) || "Patinha de Natal",
        ...(c.model || {}),
        filaments: c.filaments || [],
      });
      viewer = await PN3D.view($("#stage-3d"), model, { spin: true, zoom: 1.22 });
      hint.hidden = step !== 2;
      viewer.canvas.addEventListener("pointerdown", () => { touched3D = true; hint.hidden = true; pauseFor(10000); });
    } catch (err) {
      console.warn("prévia 3D indisponível", err); // fica a foto do enfeite
    } finally {
      building = false;
    }
  }

  tabs.forEach((b) => b.addEventListener("click", () => show(Number(b.dataset.go), true)));
  stage.querySelectorAll("[data-nav]").forEach((b) => b.addEventListener("click", () => show(step + Number(b.dataset.nav), true)));

  // deslizar o dedo nas etapas que não são o 3D
  let sx = null;
  const frame = $(".stage-frame");
  frame.addEventListener("touchstart", (e) => { sx = step === 2 ? null : e.touches[0].clientX; }, { passive: true });
  frame.addEventListener("touchend", (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 40) show(step + (dx < 0 ? 1 : -1), true);
    sx = null;
  });

  // começa sozinha quando aparece na tela; o 3D já vai montando em segundo plano
  let started = false;
  const start = () => { if (started) return; started = true; show(0); setTimeout(ensure3D, 400); };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { start(); if (!paused) schedule(); }
        else clearTimeout(timer);
      });
    }, { threshold: 0.35 }).observe(stage);
  } else start();

  document.addEventListener("visibilitychange", () => { if (document.hidden) clearTimeout(timer); else if (started) schedule(); });
})();
