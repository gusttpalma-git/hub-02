// Animação do topo: foto → arte → enfeite em 3D (montado ao vivo pelo PN3D).
(function () {
  const stage = document.getElementById("stage");
  if (!stage) return;
  const layers = [...stage.querySelectorAll(".stage-layer")];
  const buttons = [...stage.querySelectorAll("[data-go]")];
  const tag = document.getElementById("stage-tag");
  const hint = document.getElementById("stage-hint");
  const scan = document.getElementById("stage-scan");
  const LABELS = ["Sua foto", "A arte", "O enfeite em 3D"];
  const DURATION = [2600, 2600, 5200];
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let step = 0, timer = null, auto = !reduced, viewer = null, building = false;

  function show(n) {
    step = n;
    layers.forEach((l) => l.classList.toggle("on", Number(l.dataset.step) === n));
    buttons.forEach((b) => b.classList.toggle("on", Number(b.dataset.go) === n));
    tag.textContent = LABELS[n];
    hint.hidden = n !== 2 || !viewer;
    if (n === 1 && !reduced) {
      scan.classList.remove("run");
      void scan.offsetWidth;
      scan.classList.add("run");
    }
    if (n === 2) ensure3D();
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (auto) timer = setTimeout(() => show((step + 1) % 3), DURATION[step]);
  }

  async function ensure3D() {
    if (viewer || building || !window.PN3D || !window.earcut) return;
    building = true;
    try {
      const store = (await (window.PN && PN.ready)) || {};
      const model = await PN3D.build("img/exemplo-4-arte.png", {
        petName: "Mimi",
        brand: (PN.config && PN.config.MARCA) || "Patinha de Natal",
        diameter: (store.model && store.model.diameter) || 70,
        filaments: store.filaments || [],
      });
      viewer = await PN3D.view(document.getElementById("stage-3d"), model, { spin: true });
      hint.hidden = step !== 2;
      // parar a troca automática quando a pessoa interage com o 3D
      viewer.canvas.addEventListener("pointerdown", () => { auto = false; clearTimeout(timer); });
    } catch (err) {
      // sem WebGL: fica a foto do enfeite pendurado
      console.warn("prévia 3D indisponível", err);
    } finally {
      building = false;
    }
  }

  buttons.forEach((b) => b.addEventListener("click", () => { auto = false; show(Number(b.dataset.go)); }));

  // começa quando o palco aparece; já deixa o 3D montando em segundo plano
  const start = () => {
    show(0);
    setTimeout(() => ensure3D(), 600);
  };
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { io.disconnect(); start(); }
    }, { threshold: 0.3 });
    io.observe(stage);
  } else start();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(timer); else schedule();
  });
})();
