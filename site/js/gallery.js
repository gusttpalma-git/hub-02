// Galeria de fotos reais: polaroides espalhadas; tocar abre a foto ampliada.
(function () {
  const wrap = document.getElementById("polaroids");
  if (!wrap) return;
  const items = [...wrap.querySelectorAll(".polaroid")];
  const box = document.getElementById("lightbox");
  const img = document.getElementById("lb-img");
  const cap = document.getElementById("lb-cap");
  const count = document.getElementById("lb-count");
  let cur = 0;

  // entrada suave quando a galeria aparece
  if ("IntersectionObserver" in window) {
    wrap.classList.add("wait");
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      wrap.classList.remove("wait");
      setTimeout(() => wrap.classList.add("ready"), 900);
    }, { threshold: 0.2 });
    io.observe(wrap);
  }

  function open(i) {
    cur = (i + items.length) % items.length;
    const fig = items[cur];
    const pic = fig.querySelector("img");
    img.src = pic.currentSrc || pic.src;
    img.alt = pic.alt;
    cap.textContent = fig.querySelector("figcaption").textContent;
    count.textContent = `${cur + 1} de ${items.length}`;
    if (!box.open) box.showModal();
  }

  items.forEach((fig, i) => fig.querySelector("button").addEventListener("click", () => open(i)));
  box.querySelectorAll("[data-lb]").forEach((b) => b.addEventListener("click", () => open(cur + Number(b.dataset.lb))));
  box.querySelector("[data-close]").addEventListener("click", () => box.close());
  box.addEventListener("click", (e) => { if (e.target === box) box.close(); });
  document.addEventListener("keydown", (e) => {
    if (!box.open) return;
    if (e.key === "ArrowRight") open(cur + 1);
    if (e.key === "ArrowLeft") open(cur - 1);
  });
  let sx = null;
  img.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; }, { passive: true });
  img.addEventListener("touchend", (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 40) open(cur + (dx < 0 ? 1 : -1));
    sx = null;
  });
})();
