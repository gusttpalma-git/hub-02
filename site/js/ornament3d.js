// Patinha de Natal — gerador do modelo 3D do enfeite.
//
// A partir da arte (PNG com poucas cores chapadas) monta a peça para impressão:
//   • base branca redonda com alça e furo para pendurar;
//   • no fundo (lado da mesa), o nome do pet e a marca gravados, espelhados;
//   • em cima, cada cor da arte em relevo, numa faixa de altura própria.
//
// As faixas são empilhadas (técnica "uma cor por camada"): cada camada da
// impressão tem uma cor só, então o filamento troca poucas vezes na peça
// inteira — e não a cada camada. O relevo ainda dá uma sensação tátil.
//
// Saídas: 3MF colorido (uma peça por filamento) e STLs separados por cor.
// Depende de earcut (js/vendor/earcut.min.js). A visualização usa three.js.

(function () {
  "use strict";

  const SCRIPT_URL = (document.currentScript && document.currentScript.src) || location.href;

  const DEFAULTS = {
    diameter: 70,      // mm — diâmetro do disco
    base: 3.2,         // mm — espessura da base branca
    roundBottom: 1.2,  // mm — arredondado da borda de baixo
    roundTop: 0.8,     // mm — arredondado da borda de cima da base
    band: 0.4,         // mm — altura de cada faixa de cor (2 camadas de 0,2)
    engrave: 0.6,      // mm — profundidade da gravação no fundo
    cell: 0.15,        // mm — resolução da malha
    artScale: 0.97,    // o disco ocupa 97% da largura da arte
    petName: "",
    brand: "Patinha de Natal",
    filaments: [],     // [{ name, hex }] — para nomear as peças
  };

  // ───────────────────────── cores ─────────────────────────

  const hexOf = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const rgbOf = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };
  // distância "redmean": barata e bem mais próxima da percepção que RGB puro
  const dist2 = (a, b) => {
    const rm = (a.r + b.r) / 2, dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
    return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
  };
  const luma = (c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

  function nearestFilament(c, filaments) {
    let best = null, bd = Infinity;
    for (const f of filaments) {
      const fc = rgbOf(f.hex);
      if (!fc) continue;
      const d = dist2(c, fc);
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }

  // ───────────────────────── arte → grade de cores ─────────────────────────

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Não foi possível abrir a arte."));
      img.src = src;
    });
  }

  // Lê a arte numa grade size×size e agrupa as cores (aceita PNG chapado ou JPEG com ruído).
  function readArt(img, size) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    const n = size * size;

    const hist = new Map();
    for (let i = 0; i < n; i++) {
      const k = ((data[i * 4] >> 3) << 10) | ((data[i * 4 + 1] >> 3) << 5) | (data[i * 4 + 2] >> 3);
      const h = hist.get(k);
      if (h) { h.w++; h.r += data[i * 4]; h.g += data[i * 4 + 1]; h.b += data[i * 4 + 2]; }
      else hist.set(k, { w: 1, r: data[i * 4], g: data[i * 4 + 1], b: data[i * 4 + 2] });
    }
    const bins = [...hist.values()].map((h) => ({ w: h.w, r: h.r / h.w, g: h.g / h.w, b: h.b / h.w })).sort((a, b) => b.w - a.w);
    const palette = [];
    for (const b of bins) {
      if (b.w < n * 0.0006 || palette.length >= 8) break;
      if (palette.every((p) => dist2(p, b) > 3 * 40 * 40)) palette.push({ r: b.r, g: b.g, b: b.b });
    }
    if (!palette.length) palette.push({ r: 255, g: 255, b: 255 });

    let labels = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const px = { r: data[i * 4], g: data[i * 4 + 1], b: data[i * 4 + 2] };
      let bi = 0, bd = Infinity;
      for (let p = 0; p < palette.length; p++) { const d = dist2(px, palette[p]); if (d < bd) { bd = d; bi = p; } }
      labels[i] = bi;
    }
    labels = majority(labels, size, size, palette.length);
    return { size, labels, palette };
  }

  function majority(labels, w, h, n) {
    const out = new Uint8Array(labels);
    const votes = new Uint16Array(n);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const o = y * w + x;
        votes.fill(0);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) votes[labels[o + dy * w + dx]]++;
        let best = labels[o];
        for (let c = 0; c < n; c++) if (votes[c] > votes[best]) best = c;
        if (votes[best] >= 5) out[o] = best;
      }
    }
    return out;
  }

  // ───────────────────────── máscaras ─────────────────────────

  // Componentes conexos (4 vizinhos) de uma máscara. Devolve rótulos e tamanhos.
  function components(mask, w, h) {
    const comp = new Int32Array(w * h).fill(-1);
    const sizes = [];
    const stack = new Int32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || comp[i] >= 0) continue;
      const id = sizes.length;
      let top = 0, size = 0;
      stack[top++] = i;
      comp[i] = id;
      while (top) {
        const p = stack[--top];
        size++;
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && mask[p - 1] && comp[p - 1] < 0) { comp[p - 1] = id; stack[top++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && comp[p + 1] < 0) { comp[p + 1] = id; stack[top++] = p + 1; }
        if (y > 0 && mask[p - w] && comp[p - w] < 0) { comp[p - w] = id; stack[top++] = p - w; }
        if (y < h - 1 && mask[p + w] && comp[p + w] < 0) { comp[p + w] = id; stack[top++] = p + w; }
      }
      sizes.push(size);
    }
    return { comp, sizes };
  }

  // Remove ilhas pequenas demais para imprimir.
  function dropSpecks(mask, w, h, minCells) {
    const { comp, sizes } = components(mask, w, h);
    for (let i = 0; i < w * h; i++) if (mask[i] && sizes[comp[i]] < minCells) mask[i] = 0;
    return mask;
  }

  // Texto do fundo, espelhado (fica legível quando a peça é virada).
  function textMask(w, h, toGrid, mm, petName, brand, diameter) {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.fillStyle = "#000";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const [cx, cy] = toGrid(0, 0);
    const px = (v) => v / mm;
    const fit = (text, weight, maxSize, maxWidth) => {
      let size = maxSize;
      do {
        ctx.font = `${weight} ${px(size)}px "Nunito", "Arial Rounded MT Bold", Arial, sans-serif`;
        if (ctx.measureText(text).width <= px(maxWidth)) break;
        size -= 0.5;
      } while (size > 4);
      return size;
    };
    const name = String(petName || "").trim().slice(0, 24);
    if (name) {
      fit(name, 800, diameter * 0.17, diameter * 0.72);
      ctx.fillText(name, cx, cy - px(diameter * 0.04));
    }
    // marca + patinha desenhada (sem depender de emoji)
    fit(brand, 800, diameter * 0.075, diameter * 0.6);
    const by = cy + px(name ? diameter * 0.15 : 0);
    ctx.fillText(brand, cx, by);
    const pawY = by + px(diameter * 0.12);
    const r = px(diameter * 0.03);
    ctx.beginPath(); ctx.ellipse(cx, pawY + r * 0.6, r * 1.15, r, 0, 0, Math.PI * 2); ctx.fill();
    [[-1.3, -0.6], [-0.45, -1.25], [0.45, -1.25], [1.3, -0.6]].forEach(([dx, dy]) => {
      ctx.beginPath(); ctx.ellipse(cx + dx * r, pawY + dy * r, r * 0.42, r * 0.52, 0, 0, Math.PI * 2); ctx.fill();
    });
    const data = ctx.getImageData(0, 0, w, h).data;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = data[i * 4 + 3] > 110 ? 1 : 0;
    return mask;
  }

  // ───────────────────────── contornos (marching squares) ─────────────────────────

  // Pares de arestas cortadas por caso. Arestas: 0 topo, 1 direita, 2 baixo, 3 esquerda.
  // Nos casos em sela (5 e 10) os cantos cheios ficam separados (vizinhança 4).
  const SEGMENTS = [
    [], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], [[3, 0], [1, 2]], [[0, 2]], [[3, 2]],
    [[2, 3]], [[0, 2]], [[0, 1], [2, 3]], [[1, 2]], [[1, 3]], [[0, 1]], [[3, 0]], [],
  ];

  function contours(mask, w, h) {
    const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0);
    // ponto médio de aresta em coordenadas dobradas (X, Y) — chave inteira única
    const W2 = 2 * w + 6;
    const key = (X, Y) => (Y + 2) * W2 + (X + 2);
    const edgePoint = (x, y, e) => {
      switch (e) {
        case 0: return [2 * x + 1, 2 * y];
        case 1: return [2 * x + 2, 2 * y + 1];
        case 2: return [2 * x + 1, 2 * y + 2];
        default: return [2 * x, 2 * y + 1];
      }
    };
    const links = new Map();
    const coords = new Map();
    const link = (a, b) => {
      const la = links.get(a);
      if (la) la.push(b); else links.set(a, [b]);
    };
    for (let y = -1; y < h; y++) {
      for (let x = -1; x < w; x++) {
        const c = at(x, y) | (at(x + 1, y) << 1) | (at(x + 1, y + 1) << 2) | (at(x, y + 1) << 3);
        if (c === 0 || c === 15) continue;
        for (const [ea, eb] of SEGMENTS[c]) {
          const pa = edgePoint(x, y, ea), pb = edgePoint(x, y, eb);
          const ka = key(pa[0], pa[1]), kb = key(pb[0], pb[1]);
          coords.set(ka, pa); coords.set(kb, pb);
          link(ka, kb); link(kb, ka);
        }
      }
    }
    const loops = [];
    const seen = new Set();
    for (const start of links.keys()) {
      if (seen.has(start)) continue;
      const loop = [];
      let prev = -1, cur = start;
      while (!seen.has(cur)) {
        seen.add(cur);
        loop.push(coords.get(cur));
        const nb = links.get(cur);
        const next = nb[0] !== prev ? nb[0] : nb[1];
        prev = cur;
        cur = next;
        if (cur === undefined) break;
      }
      if (loop.length >= 3) loops.push(loop);
    }
    return loops; // pontos em coordenadas dobradas da grade (centro da célula i = 2i)
  }

  // Douglas–Peucker em polígono fechado.
  function simplify(pts, eps) {
    if (pts.length < 8) return pts;
    const e2 = eps * eps;
    const seg2 = (p, a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l = dx * dx + dy * dy;
      let t = l ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l : 0;
      t = Math.max(0, Math.min(1, t));
      const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
      return x * x + y * y;
    };
    const dp = (arr) => {
      const keep = new Uint8Array(arr.length);
      keep[0] = keep[arr.length - 1] = 1;
      const st = [[0, arr.length - 1]];
      while (st.length) {
        const [i, j] = st.pop();
        let md = 0, mi = -1;
        for (let k = i + 1; k < j; k++) { const d = seg2(arr[k], arr[i], arr[j]); if (d > md) { md = d; mi = k; } }
        if (md > e2) { keep[mi] = 1; st.push([i, mi], [mi, j]); }
      }
      return arr.filter((_, k) => keep[k]);
    };
    // divide no ponto mais distante do primeiro, para o anel não colapsar
    let far = 0, fd = -1;
    for (let k = 1; k < pts.length; k++) { const d = (pts[k][0] - pts[0][0]) ** 2 + (pts[k][1] - pts[0][1]) ** 2; if (d > fd) { fd = d; far = k; } }
    const a = dp(pts.slice(0, far + 1));
    const b = dp(pts.slice(far).concat([pts[0]]));
    const out = a.concat(b.slice(1, -1));
    return out.length >= 3 ? out : pts;
  }

  const area = (p) => { let s = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j][0] * p[i][1] - p[i][0] * p[j][1]); return s / 2; };
  function inside(pt, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }

  // Agrupa contornos em polígonos (externo + furos), já em mm e orientados.
  function polygons(loops) {
    const items = loops.map((p) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of p) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
      return { p, a: Math.abs(area(p)), box: [x0, y0, x1, y1], depth: 0, parent: -1 };
    });
    items.forEach((it, i) => {
      const t = it.p[0];
      let best = -1;
      items.forEach((o, j) => {
        if (i === j || o.a <= it.a) return;
        if (t[0] < o.box[0] || t[0] > o.box[2] || t[1] < o.box[1] || t[1] > o.box[3]) return;
        if (inside(t, o.p)) { it.depth++; if (best < 0 || o.a < items[best].a) best = j; }
      });
      it.parent = best;
    });
    const polys = [];
    const index = new Map();
    items.forEach((it, i) => {
      if (it.depth % 2 === 0) {
        if (area(it.p) < 0) it.p.reverse();               // externo anti-horário
        index.set(i, polys.length);
        polys.push({ outer: it.p, holes: [] });
      }
    });
    items.forEach((it) => {
      if (it.depth % 2 === 1 && index.has(it.parent)) {
        if (area(it.p) > 0) it.p.reverse();               // furo horário
        polys[index.get(it.parent)].holes.push(it.p);
      }
    });
    return polys;
  }

  // ───────────────────────── malha (extrusão) ─────────────────────────

  function newMesh() { return { pos: [], idx: [] }; }

  function extrude(mesh, polys, z0, z1) {
    const earcut = window.earcut;
    for (const poly of polys) {
      const rings = [poly.outer, ...poly.holes];
      const flat = [], holes = [], base = mesh.pos.length / 3;
      const bottom = [], top = [];
      let n = 0;
      rings.forEach((ring, r) => {
        if (r > 0) holes.push(n);
        for (const q of ring) { flat.push(q[0], q[1]); n++; }
      });
      for (let i = 0; i < n; i++) mesh.pos.push(flat[i * 2], flat[i * 2 + 1], z0);
      for (let i = 0; i < n; i++) mesh.pos.push(flat[i * 2], flat[i * 2 + 1], z1);
      for (let i = 0; i < n; i++) { bottom.push(base + i); top.push(base + n + i); }
      const tri = earcut(flat, holes.length ? holes : null, 2);
      for (let t = 0; t < tri.length; t += 3) {
        let a = tri[t], b = tri[t + 1], c = tri[t + 2];
        const cross = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]);
        if (cross < 0) { const s = b; b = c; c = s; }
        mesh.idx.push(top[a], top[b], top[c]);           // topo: normal +z
        mesh.idx.push(bottom[a], bottom[c], bottom[b]);  // fundo: normal −z
      }
      let off = 0;
      for (const ring of rings) {
        const m = ring.length;
        for (let i = 0; i < m; i++) {
          const p = off + i, q = off + ((i + 1) % m);
          mesh.idx.push(bottom[p], bottom[q], top[q], bottom[p], top[q], top[p]);
        }
        off += m;
      }
    }
    return mesh;
  }

  // ───────────────────────── base lisa (contorno geométrico) ─────────────────────────

  // Contorno do disco + alça, calculado direto da geometria (sem serrilhado), anti-horário.
  function outlinePath(R, tw, holeY) {
    const pts = [];
    const yj = Math.sqrt(R * R - tw * tw);
    const aR = Math.atan2(yj, tw);                 // junção direita
    const aL = Math.PI - aR;                       // junção esquerda
    const span = Math.PI * 2 - (aL - aR);
    const n = Math.max(240, Math.ceil(span / (Math.PI / 360)));
    for (let i = 0; i <= n; i++) {
      const a = aL + (span * i) / n;
      pts.push([R * Math.cos(a), R * Math.sin(a)]);
    }
    // lado direito da alça (subindo), meia-lua no topo, lado esquerdo (descendo)
    const side = 8;
    for (let i = 1; i <= side; i++) pts.push([tw, yj + ((holeY - yj) * i) / side]);
    const arc = 48;
    for (let i = 1; i < arc; i++) { const a = (Math.PI * i) / arc; pts.push([tw * Math.cos(a), holeY + tw * Math.sin(a)]); }
    for (let i = 0; i < side; i++) pts.push([-tw, holeY - ((holeY - yj) * i) / side]);
    return pts;
  }

  // Desloca o contorno para dentro (normal de cada ponto).
  function inset(path, d) {
    if (!d) return path.map((p) => p.slice());
    const n = path.length;
    return path.map((p, i) => {
      const a = path[(i - 1 + n) % n], b = path[(i + 1) % n];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const l = Math.hypot(tx, ty) || 1;
      tx /= l; ty /= l;
      return [p[0] - ty * d, p[1] + tx * d];
    });
  }

  function circlePath(cx, cy, r, n, clockwise) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = ((clockwise ? -1 : 1) * Math.PI * 2 * i) / n;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }

  // Laje com borda externa lisa e arredondada (contorno muda com a altura), furos verticais.
  function roundedSlab(mesh, path, profile, zs, holes) {
    const earcut = window.earcut;
    const base = mesh.pos.length / 3;
    const n = path.length;
    const rings = zs.map((z) => {
      const ring = inset(path, profile(z));
      const start = mesh.pos.length / 3;
      for (const q of ring) mesh.pos.push(q[0], q[1], z);
      return { start, ring };
    });
    for (let k = 0; k < rings.length - 1; k++) {
      const lo = rings[k].start, hi = rings[k + 1].start;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        mesh.idx.push(lo + i, lo + j, hi + j, lo + i, hi + j, hi + i);
      }
    }
    // furos (o furo da alça e as letras gravadas): paredes verticais
    const z0 = zs[0], z1 = zs[zs.length - 1];
    const holeIdx = holes.map((h) => {
      const b = mesh.pos.length / 3;
      for (const q of h) mesh.pos.push(q[0], q[1], z0);
      for (const q of h) mesh.pos.push(q[0], q[1], z1);
      const m = h.length;
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        mesh.idx.push(b + i, b + j, b + m + j, b + i, b + m + j, b + m + i);
      }
      return { bottom: b, top: b + m, m };
    });
    // tampas de baixo e de cima
    const cap = (ringInfo, top) => {
      const flat = [], holeStarts = [], ids = [];
      for (let i = 0; i < n; i++) { flat.push(ringInfo.ring[i][0], ringInfo.ring[i][1]); ids.push(ringInfo.start + i); }
      holes.forEach((h, hi) => {
        holeStarts.push(ids.length);
        h.forEach((q, i) => { flat.push(q[0], q[1]); ids.push((top ? holeIdx[hi].top : holeIdx[hi].bottom) + i); });
      });
      const tri = earcut(flat, holeStarts.length ? holeStarts : null, 2);
      for (let t = 0; t < tri.length; t += 3) {
        let a = tri[t], b = tri[t + 1], c = tri[t + 2];
        const cross = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]);
        if ((cross < 0) === top) { const s = b; b = c; c = s; }
        mesh.idx.push(ids[a], ids[b], ids[c]);
      }
    };
    cap(rings[0], false);
    cap(rings[rings.length - 1], true);
    void base;
    return mesh;
  }

  // ───────────────────────── montagem da peça ─────────────────────────

  async function build(src, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    if (!window.earcut) throw new Error("earcut não carregado");
    const img = typeof src === "string" ? await loadImage(src) : src;
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (_) { /* segue */ } }

    const D = o.diameter, R = D / 2, cell = o.cell;
    const S = D / o.artScale;                  // lado da arte em mm
    const tabTop = R + 7;                      // alça acima do disco
    const half = S / 2;
    const w = Math.ceil(S / cell);
    const h = Math.ceil((half + Math.max(tabTop, half)) / cell);
    const x0 = -half, yTop = Math.max(tabTop, half) + cell;  // canto superior esquerdo
    const toGrid = (x, y) => [(x - x0) / cell, (yTop - y) / cell];
    const cellX = (i) => x0 + (i + 0.5) * cell;
    const cellY = (j) => yTop - (j + 0.5) * cell;

    // forma: disco + alça − furo
    const shape = new Uint8Array(w * h);
    const disc = new Uint8Array(w * h);
    const tabW = 4.6, holeY = R + 2.6, holeR = 1.8;
    for (let j = 0; j < h; j++) {
      const y = cellY(j);
      for (let i = 0; i < w; i++) {
        const x = cellX(i), k = j * w + i;
        const inDisc = x * x + y * y <= R * R;
        let inTab = Math.abs(x) <= tabW && y >= R - 3 && y <= holeY;
        if (y > holeY && x * x + (y - holeY) ** 2 <= tabW * tabW) inTab = true;
        const inHole = x * x + (y - holeY) ** 2 <= holeR * holeR;
        disc[k] = inDisc ? 1 : 0;
        shape[k] = (inDisc || inTab) && !inHole ? 1 : 0;
      }
    }

    // arte amostrada na área do disco
    const artN = Math.round(S / cell);
    const art = readArt(img, artN);
    let pal = art.palette;
    const filaments = (o.filaments || []).filter((f) => rgbOf(f.hex));
    if (filaments.length) {
      // cada cor da arte vira o filamento mais próximo; cores no mesmo filamento se juntam
      const fil = pal.map((c) => nearestFilament(c, filaments));
      const merged = [], remap = [];
      fil.forEach((f, i) => {
        const j = merged.findIndex((m) => m.f === f);
        if (j >= 0) remap[i] = j; else { remap[i] = merged.length; merged.push({ f, c: rgbOf(f.hex) }); }
      });
      for (let k = 0; k < art.labels.length; k++) art.labels[k] = remap[art.labels[k]];
      pal = merged.map((m) => m.c);
    }
    const whiteness = (c) => Math.min(c.r, c.g, c.b) - (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b));
    let white = 0, black = 0;
    pal.forEach((c, i) => {
      if (whiteness(c) > whiteness(pal[white])) white = i;
      if (luma(c) < luma(pal[black])) black = i;
    });
    const label = new Int16Array(w * h).fill(-1);
    for (let j = 0; j < h; j++) {
      const y = cellY(j);
      const aj = Math.floor((half - y) / cell);
      if (aj < 0 || aj >= artN) continue;
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (!disc[k]) continue;
        const ai = Math.floor((cellX(i) + half) / cell);
        if (ai < 0 || ai >= artN) continue;
        label[k] = art.labels[aj * artN + ai];
      }
    }

    // fundo branco = brancos ligados à borda do disco + a maior área branca interna
    const whiteMask = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) whiteMask[k] = disc[k] && (label[k] === white || label[k] < 0) ? 1 : 0;
    const wc = components(whiteMask, w, h);
    const isBg = new Uint8Array(wc.sizes.length);
    for (let k = 0; k < w * h; k++) {
      if (!whiteMask[k]) continue;
      const i = k % w, j = (k / w) | 0;
      const edge = !disc[k - 1] || !disc[k + 1] || !disc[k - w] || !disc[k + w] || i === 0 || j === 0;
      if (edge) isBg[wc.comp[k]] = 1;
    }
    let biggest = -1;
    wc.sizes.forEach((s, id) => { if (!isBg[id] && (biggest < 0 || s > wc.sizes[biggest])) biggest = id; });
    if (biggest >= 0 && wc.sizes[biggest] > w * h * 0.04) isBg[biggest] = 1;

    // ordem das faixas: branco do pelo, depois cores do mais claro ao mais escuro, preto por último
    const colorIds = pal.map((_, i) => i).filter((i) => i !== white && i !== black)
      .sort((a, b) => luma(pal[b]) - luma(pal[a]));
    const order = [white, ...colorIds, black].filter((v, i, a) => a.indexOf(v) === i);
    const rankOf = new Int16Array(pal.length);
    order.forEach((id, r) => { rankOf[id] = r + 1; });
    const rank = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) {
      if (!disc[k] || label[k] < 0) continue;
      if (label[k] === white && whiteMask[k] && isBg[wc.comp[k]]) continue;
      rank[k] = rankOf[label[k]];
    }

    // fundo gravado
    const text = textMask(w, h, toGrid, cell, o.petName, o.brand, D);
    for (let k = 0; k < w * h; k++) if (!disc[k]) text[k] = 0;

    const minCells = Math.ceil(0.35 / (cell * cell));   // ilhas < 0,35 mm² somem
    const eps = cell * 0.35;
    const toMM = (loops) => loops.map((loop) => simplify(loop.map(([X, Y]) => [x0 + (X / 2 + 0.5) * cell, yTop - (Y / 2 + 0.5) * cell]), eps));
    const polysOf = (mask) => polygons(toMM(contours(mask, w, h)));

    const nameFor = (c, fallback) => {
      const f = filaments.length ? nearestFilament(c, filaments) : null;
      return f ? { name: f.name, hex: f.hex } : { name: fallback, hex: hexOf(c) };
    };
    const parts = [];
    const add = (label, color, mesh, z0, z1) => {
      const f = nameFor(color, label);
      parts.push({ name: f.name, label, hex: f.hex, from: +z0.toFixed(2), to: +z1.toFixed(2), positions: new Float32Array(mesh.pos), indices: new Uint32Array(mesh.idx) });
    };

    const whiteColor = pal[white];
    // Base: contorno liso (geométrico), borda de baixo e de cima arredondadas.
    const outline = outlinePath(R, tabW, holeY);
    const fb = Math.min(o.roundBottom, o.base / 2), ft = Math.min(o.roundTop, o.base / 3);
    const profile = (z) => {
      if (z < fb) return fb - Math.sqrt(Math.max(0, fb * fb - (fb - z) ** 2));
      const t0 = o.base - ft;
      if (z > t0) return ft - Math.sqrt(Math.max(0, ft * ft - (z - t0) ** 2));
      return 0;
    };
    const steps = (a, b) => {
      const zs = [a];
      for (let z = a + 0.1; z < b - 0.05; z += 0.1) if (z < fb || z > o.base - ft) zs.push(+z.toFixed(3));
      zs.push(b);
      return zs;
    };
    const hole = circlePath(0, holeY, holeR, 40, true);
    // letras gravadas no fundo: viram furos rasos; o miolo das letras (ex.: "o") fica como ilha
    const textPolys = polysOf(text);
    const letterHoles = textPolys.map((p) => p.outer.slice().reverse());
    const counters = textPolys.flatMap((p) => p.holes.map((h) => ({ outer: h.slice().reverse(), holes: [] })));
    const fundo = roundedSlab(newMesh(), outline, profile, steps(0, o.engrave), [hole, ...letterHoles]);
    if (counters.length) extrude(fundo, counters, 0, o.engrave);
    add("fundo", whiteColor, fundo, 0, o.engrave);
    add("base", whiteColor, roundedSlab(newMesh(), outline, profile, steps(o.engrave, o.base), [hole]), o.engrave, o.base);

    let level = 0;
    order.forEach((id, r) => {
      const mask = new Uint8Array(w * h);
      let any = 0;
      for (let k = 0; k < w * h; k++) if (rank[k] >= r + 1) { mask[k] = 1; any++; }
      if (!any) return;
      dropSpecks(mask, w, h, minCells);
      const z0 = o.base + level * o.band, z1 = z0 + o.band;
      level++;
      add(id === white ? "pelo-branco" : "relevo", pal[id], extrude(newMesh(), polysOf(mask), z0, z1), z0, z1);
    });

    const height = o.base + level * o.band;
    return { parts, size: { diameter: D, height: +height.toFixed(2), tab: 7 } };
  }

  // ───────────────────────── exportação ─────────────────────────

  function toSTL(part, name) {
    const tris = part.indices.length / 3;
    const buf = new ArrayBuffer(84 + tris * 50);
    const dv = new DataView(buf);
    const header = ("Patinha de Natal - " + (name || part.name)).slice(0, 79);
    for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i) & 127);
    dv.setUint32(80, tris, true);
    const P = part.positions, I = part.indices;
    let off = 84;
    for (let t = 0; t < tris; t++) {
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (const v of [nx, ny, nz, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]]) { dv.setFloat32(off, v, true); off += 4; }
      dv.setUint16(off, 0, true); off += 2;
    }
    return new Uint8Array(buf);
  }

  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => ((Math.random() * 16) | 0).toString(16)));
  const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"';

  function meshXML(id, name, P, I) {
    const v = [], t = [];
    for (let k = 0; k < P.length; k += 3) v.push(`<vertex x="${P[k].toFixed(3)}" y="${P[k + 1].toFixed(3)}" z="${P[k + 2].toFixed(3)}"/>`);
    for (let k = 0; k < I.length; k += 3) t.push(`<triangle v1="${I[k]}" v2="${I[k + 1]}" v3="${I[k + 2]}"/>`);
    return `<object id="${id}" name="${esc(name)}" type="model"><mesh><vertices>${v.join("")}</vertices><triangles>${t.join("")}</triangles></mesh></object>`;
  }

  // Filamento de cada parte: partes da mesma cor dividem o mesmo slot (1, 2, 3…).
  function slots(model) {
    const order = [];
    const slotOf = model.parts.map((p) => {
      const key = p.hex.toLowerCase();
      let i = order.findIndex((o) => o.key === key);
      if (i < 0) { order.push({ key, hex: p.hex.toUpperCase(), name: p.name }); i = order.length - 1; }
      return i + 1;
    });
    return { order, slotOf };
  }

  // 3MF no formato que o Bambu Studio / Orca leem com cada parte já no seu filamento:
  // uma malha por parte em 3D/Objects, montagem por componentes e Metadata/model_settings.config.
  function files3MF(model, title) {
    const N = model.parts.length;
    const parent = N + 1;
    const { order, slotOf } = slots(model);
    const files = [
      { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>' },
      { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
    ];
    const comps = model.parts.map((_, i) => `<component p:path="/3D/Objects/object_${i + 1}.model" objectid="${i + 1}" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`).join("");
    files.push({ name: "3D/3dmodel.model", data: `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="pt-BR" ${NS} requiredextensions="p">` +
      // O Bambu Studio só lê as cores por parte de arquivos que ele reconhece como seus.
      `<metadata name="Application">BambuStudio-02.03.00.70</metadata><metadata name="BambuStudio:3mfVersion">1</metadata>` +
      `<metadata name="Title">${esc(title)}</metadata><metadata name="Designer">Patinha de Natal</metadata>` +
      `<resources><object id="${parent}" name="${esc(title)}" type="model" p:UUID="${uuid()}"><components>${comps}</components></object></resources>` +
      `<build p:UUID="${uuid()}"><item objectid="${parent}" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 128 128 0" printable="1"/></build></model>` });
    files.push({ name: "3D/_rels/3dmodel.model.rels", data: '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      model.parts.map((_, i) => `<Relationship Target="/3D/Objects/object_${i + 1}.model" Id="rel-${i + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`).join("") + "</Relationships>" });
    model.parts.forEach((p, i) => {
      files.push({ name: `3D/Objects/object_${i + 1}.model`, data: `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="pt-BR" ${NS}><resources>${meshXML(i + 1, p.name + " - " + p.label, p.positions, p.indices)}</resources><build/></model>` });
    });
    const parts = model.parts.map((p, i) => `<part id="${i + 1}" subtype="normal_part"><metadata key="name" value="${esc(p.name + " - " + p.label)}"/><metadata key="extruder" value="${slotOf[i]}"/></part>`).join("");
    files.push({ name: "Metadata/model_settings.config", data: `<?xml version="1.0" encoding="UTF-8"?>\n<config><object id="${parent}"><metadata key="name" value="${esc(title)}"/><metadata key="extruder" value="1"/>${parts}</object>` +
      `<plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value=""/><metadata key="locked" value="false"/><model_instance><metadata key="object_id" value="${parent}"/><metadata key="instance_id" value="0"/></model_instance></plate></config>` });
    files.push({ name: "Metadata/project_settings.config", data: JSON.stringify({
      filament_colour: order.map((o) => o.hex),
      filament_type: order.map(() => "PLA"),
      filament_settings_id: order.map(() => "Bambu PLA Basic @BBL X1C"),
      filament_ids: order.map(() => "GFA00"),
      filament_vendor: order.map(() => "Bambu Lab"),
    }, null, 4) });
    return files;
  }

  // Todas as partes numa malha só: para imprimir trocando o filamento por altura em qualquer fatiador.
  function mergedPart(model) {
    let count = 0;
    model.parts.forEach((p) => { count += p.positions.length; });
    const positions = new Float32Array(count);
    const idx = [];
    let off = 0;
    model.parts.forEach((p) => {
      positions.set(p.positions, off);
      const base = off / 3;
      for (const v of p.indices) idx.push(v + base);
      off += p.positions.length;
    });
    return { name: "Peça única", positions, indices: new Uint32Array(idx) };
  }

  // ZIP mínimo (usado para o 3MF e para o pacote de STLs).
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

  async function deflate(u8) {
    if (typeof CompressionStream === "undefined") return null;
    try {
      const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (_) { return null; }
  }

  async function zip(files) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const packed = await deflate(data);
      const method = packed && packed.length < data.length ? 8 : 0;
      const body = method ? packed : data;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint16(8, method, true); local.setUint32(14, crc, true);
      local.setUint32(18, body.length, true); local.setUint32(22, data.length, true); local.setUint16(26, name.length, true);
      chunks.push(new Uint8Array(local.buffer), name, body);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, method, true); cen.setUint32(16, crc, true); cen.setUint32(20, body.length, true);
      cen.setUint32(24, data.length, true); cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + body.length;
    }
    const size = central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, size, true); end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
  }

  async function export3MF(model, title) {
    const blob = await zip(files3MF(model, title));
    return new Blob([blob], { type: "model/3mf" });
  }

  const slug = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "cor";

  function guide(model, title) {
    const { order, slotOf } = slots(model);
    const lines = [
      title,
      "",
      `Diâmetro: ${model.size.diameter} mm · Altura total: ${model.size.height} mm`,
      "",
      "OPÇÃO A — peça única + troca de filamento por altura (funciona em qualquer fatiador):",
      "1. Abra só o arquivo 0-peca-unica.stl.",
      "2. Na barra de camadas, adicione a troca de filamento nas alturas abaixo.",
      "",
      "OPÇÃO B — partes coloridas (Bambu Studio, Orca, Prusa):",
      "1. Arraste os arquivos numerados (1-, 2-, 3-…) juntos para o fatiador.",
      "2. Aceite carregar como UM objeto com várias partes.",
      "3. Atribua a cada parte o filamento do nome do arquivo.",
      "   (o .3mf baixado do painel já vem com as partes nos filamentos:",
      "    " + order.map((o, i) => `slot ${i + 1} = ${o.name} ${o.hex}`).join(", ") + ")",
      "",
      "O fundo (nome e marca gravados) já fica virado para a mesa.",
      "",
      "Cor por altura (uma cor por camada):",
    ];
    model.parts.forEach((p, i) => lines.push(`  ${p.from.toFixed(2)} mm → ${p.to.toFixed(2)} mm: ${p.name} (slot ${slotOf[i]})`));
    return lines.join("\r\n");
  }

  async function exportSTLZip(model, title) {
    const files = [{ name: "0-peca-unica.stl", data: toSTL(mergedPart(model), "peca unica") }];
    model.parts.forEach((p, i) => files.push({ name: `${i + 1}-${slug(p.name)}-${slug(p.label)}.stl`, data: toSTL(p) }));
    files.push({ name: "LEIA-ME.txt", data: guide(model, title) });
    return zip(files);
  }

  // ───────────────────────── visualização (three.js) ─────────────────────────

  // three.js fica junto do site (js/vendor), sem depender de CDN.
  const THREE_URL = new URL("vendor/three.module.min.js", SCRIPT_URL).href;
  let threePromise = null;
  const loadThree = () => (threePromise = threePromise || import(THREE_URL));

  // Mostra o enfeite girando devagar; arrastar gira, soltar volta a girar.
  async function view(container, model, opts) {
    const THREE = await loadThree();
    const o = Object.assign({ spin: true, background: null }, opts || {});
    const width = () => container.clientWidth || 320;
    const height = () => container.clientHeight || width();

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: !!o.preserve });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(width(), height());
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.replaceChildren(renderer.domElement);
    renderer.domElement.style.touchAction = "pan-y";
    renderer.domElement.setAttribute("aria-label", "Prévia 3D do enfeite. Arraste para girar.");
    renderer.domElement.setAttribute("role", "img");

    const scene = new THREE.Scene();
    if (o.background) scene.background = new THREE.Color(o.background);
    const camera = new THREE.PerspectiveCamera(30, width() / height(), 1, 1000);
    const fit = model.size.diameter * 2.35 * (o.zoom || 1);
    camera.position.set(0, 0, fit);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-40, 60, 90);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xfff1dd, 0.9);
    rim.position.set(60, -30, -60);
    scene.add(rim);
    const back = new THREE.DirectionalLight(0xffffff, 0.9);   // ilumina o verso
    back.position.set(-50, 70, -90);
    scene.add(back);
    // luz rasante pelo verso: realça as letras gravadas (sombra/brilho nas bordas)
    const graze = new THREE.DirectionalLight(0xfff4e2, 2.2);
    graze.position.set(-120, 60, -22);
    scene.add(graze);

    const group = new THREE.Group();
    model.parts.forEach((p) => {
      const indexed = new THREE.BufferGeometry();
      indexed.setAttribute("position", new THREE.BufferAttribute(p.positions, 3));
      indexed.setIndex(new THREE.BufferAttribute(p.indices, 1));
      const g = indexed.toNonIndexed();   // faces planas: topo e paredes com sombra nítida
      indexed.dispose();
      g.computeVertexNormals();
      const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(p.hex), roughness: 0.55, metalness: 0.02, flatShading: false });
      group.add(new THREE.Mesh(g, m));
    });
    // centraliza (o disco fica no centro, a alça em cima)
    group.position.set(0, -3.5, -model.size.height / 2);
    const pivot = new THREE.Group();
    pivot.add(group);
    scene.add(pivot);

    // Parado, o enfeite balança de leve, sempre de frente; arrastando, gira livre
    // (dá para ver o verso) e depois volta devagar para a frente.
    let offY = (o.pose && o.pose.y) || 0, offX = (o.pose && o.pose.x) || 0, vel = 0, dragging = false, lastX = 0, lastY = 0, alive = true, idle = 0, clock = 0;
    const el = renderer.domElement;
    el.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; el.setPointerCapture(e.pointerId); });
    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      offY += dx * 0.012; offX = Math.max(-0.9, Math.min(0.9, offX + dy * 0.008));
      loop();
      vel = dx * 0.012; idle = 0;
    });
    const up = () => { dragging = false; };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);

    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Só desenha quando está visível na tela (economiza bateria no celular).
    let visible = true, running = false;
    let t0 = performance.now();
    const loop = () => {
      if (running || !alive) return;
      running = true;
      t0 = performance.now();
      requestAnimationFrame(tick);
    };
    const tick = (now) => {
      if (!alive) return;
      if (!visible || document.hidden) { running = false; return; }
      const dt = Math.min(0.05, (now - t0) / 1000);
      t0 = now;
      if (!dragging) {
        idle += dt;
        vel *= 0.92;
        offY += vel;
        if (idle > 2.5 && !o.hold) {
          // volta para a frente pelo caminho mais curto
          const full = Math.PI * 2;
          offY = ((offY % full) + full + Math.PI) % full - Math.PI;
          offY *= 0.94; offX *= 0.94;
        }
        if (o.spin && !reduced) clock += dt;
      }
      const sway = Math.sin(clock * 0.9) * 0.42;
      pivot.rotation.set(0.1 + offX + Math.sin(clock * 0.6) * 0.05, -0.15 + sway + offY, Math.sin(clock * 0.9 + 1) * 0.03);
      renderer.render(scene, camera);
      requestAnimationFrame(tick);
    };
    loop();
    const io = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(([e]) => {
      visible = e.isIntersecting && e.intersectionRatio > 0;
      if (visible) loop();
    }) : null;
    if (io) io.observe(container);
    const onVis = () => { if (!document.hidden) loop(); };
    document.addEventListener("visibilitychange", onVis);

    const onResize = () => {
      renderer.setSize(width(), height());
      camera.aspect = width() / height();
      camera.updateProjectionMatrix();
    };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    if (ro) ro.observe(container);

    return {
      destroy() {
        alive = false;
        if (ro) ro.disconnect();
        if (io) io.disconnect();
        document.removeEventListener("visibilitychange", onVis);
        renderer.dispose();
        group.traverse((m) => { if (m.geometry) m.geometry.dispose(); if (m.material) m.material.dispose(); });
      },
      canvas: el,
    };
  }

  window.PN3D = { build, view, toSTL, export3MF, exportSTLZip, loadThree, DEFAULTS, slug };
})();
