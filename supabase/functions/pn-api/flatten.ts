// Reduz a arte a poucas cores chapadas e bem diferentes entre si, para impressão 3D.
//
// Preto (contorno) e branco (fundo) são fixos. As demais cores saem da própria arte.
// Tons parecidos são fundidos num só: o cliente vê exatamente o que será impresso.

import { PNG } from "npm:pngjs@7.0.0";
import { Buffer } from "node:buffer";

type RGB = { r: number; g: number; b: number };

const BLACK: RGB = { r: 17, g: 17, b: 17 };
const WHITE: RGB = { r: 255, g: 255, b: 255 };
const MIN_DISTANCE = 60; // abaixo disso duas cores são "o mesmo tom"

const dist = (a: RGB, b: RGB) => Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
// distância "redmean", mais próxima da percepção — usada para casar cor com filamento
const pdist = (a: RGB, b: RGB) => {
  const rm = (a.r + b.r) / 2, dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
};
const fromHex = (hex: string): RGB | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};
const isBlackish = (c: RGB) => Math.max(c.r, c.g, c.b) < 46;
const isWhitish = (c: RGB) => Math.min(c.r, c.g, c.b) > 212 && Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) < 30;

// filaments: cores disponíveis (hex). Quando informadas, a arte final usa SÓ essas cores,
// então o cliente vê exatamente o que será impresso.
export function flattenColors(pngBytes: Uint8Array, maxColors: number, filaments: string[] = []): { png: Uint8Array; palette: string[] } {
  const img = PNG.sync.read(Buffer.from(pngBytes));
  const { width: w, height: h, data } = img;
  const total = w * h;

  // Pixel "chapado" = igual aos vizinhos. As bordas (anti-serrilhado) ficam de fora da
  // escolha das cores, senão o cinza da transição preto→branco viraria uma cor da paleta.
  const flat = new Uint8Array(total);
  const near = (a: number, b: number) =>
    Math.abs(data[a] - data[b]) < 16 && Math.abs(data[a + 1] - data[b + 1]) < 16 && Math.abs(data[a + 2] - data[b + 2]) < 16;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const o = (y * w + x) * 4;
      if (near(o, o - 4) && near(o, o + 4) && near(o, o - w * 4) && near(o, o + w * 4)) flat[y * w + x] = 1;
    }
  }

  // histograma em blocos de 5 bits por canal (só áreas chapadas)
  const count = new Uint32Array(32768);
  const sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
  for (let i = 0; i < total; i++) {
    if (!flat[i]) continue;
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    count[k]++; sr[k] += r; sg[k] += g; sb[k] += b;
  }
  const bins: (RGB & { k: number; w: number })[] = [];
  for (let k = 0; k < 32768; k++) {
    if (count[k]) bins.push({ k, w: count[k], r: sr[k] / count[k], g: sg[k] / count[k], b: sb[k] / count[k] });
  }

  // cores livres = tudo que não é o preto do contorno nem o branco do fundo
  const free = bins.filter((p) => !isBlackish(p) && !isWhitish(p));
  const slots = Math.max(0, Math.min(maxColors, 8) - 2);
  let centers: (RGB & { w: number })[] = [];

  if (free.length && slots > 0) {
    const first = free.reduce((a, p) => (p.w > a.w ? p : a));
    centers.push({ r: first.r, g: first.g, b: first.b, w: 0 });
    while (centers.length < Math.min(slots, free.length)) {
      let pick = free[0], best = -1;
      for (const p of free) {
        let d = Infinity;
        for (const c of centers) d = Math.min(d, dist(p, c));
        const score = d * d * Math.sqrt(p.w);
        if (score > best) { best = score; pick = p; }
      }
      centers.push({ r: pick.r, g: pick.g, b: pick.b, w: 0 });
    }
    for (let it = 0; it < 14; it++) {
      const acc = centers.map(() => ({ w: 0, r: 0, g: 0, b: 0 }));
      for (const p of free) {
        let bi = 0, bd = Infinity;
        for (let c = 0; c < centers.length; c++) { const d = dist(p, centers[c]); if (d < bd) { bd = d; bi = c; } }
        const a = acc[bi]; a.w += p.w; a.r += p.r * p.w; a.g += p.g * p.w; a.b += p.b * p.w;
      }
      centers = centers.map((c, i) => acc[i].w ? { r: acc[i].r / acc[i].w, g: acc[i].g / acc[i].w, b: acc[i].b / acc[i].w, w: acc[i].w } : c);
    }

    // funde tons parecidos (entre si, ou com o preto/branco) e descarta cores quase sem uso
    centers = centers.filter((c) => c.w > total * 0.0007 && dist(c, BLACK) >= MIN_DISTANCE * 0.7 && dist(c, WHITE) >= MIN_DISTANCE * 0.7);
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < centers.length; i++) {
        for (let j = i + 1; j < centers.length; j++) {
          if (dist(centers[i], centers[j]) < MIN_DISTANCE) {
            const a = centers[i], b = centers[j], w2 = a.w + b.w;
            centers[i] = { r: (a.r * a.w + b.r * b.w) / w2, g: (a.g * a.w + b.g * b.w) / w2, b: (a.b * a.w + b.b * b.w) / w2, w: w2 };
            centers.splice(j, 1);
            merged = true;
            break outer;
          }
        }
      }
    }
  }

  // Cor escura demais se confunde com o contorno: clareia até ficar bem distinta do preto.
  const MIN_FROM_BLACK = 120;
  const lift = (c: RGB): RGB => {
    const d = dist(c, BLACK);
    if (d >= MIN_FROM_BLACK || d === 0) return c;
    const f = MIN_FROM_BLACK / d;
    return { r: BLACK.r + (c.r - BLACK.r) * f, g: BLACK.g + (c.g - BLACK.g) * f, b: BLACK.b + (c.b - BLACK.b) * f };
  };
  let shown = centers.map(lift).map((c) => ({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) }));
  let ink = BLACK, paper = WHITE;
  const fil = filaments.map(fromHex).filter((c): c is RGB => !!c);
  if (fil.length) {
    const nearest = (c: RGB, pool = fil) => pool.reduce((a, f) => (pdist(c, f) < pdist(c, a) ? f : a));
    ink = nearest(BLACK);
    paper = nearest(WHITE);
    // Cores mais usadas escolhem primeiro. Se o filamento mais próximo já foi usado,
    // tenta o próximo livre (ex.: listras laranja-escuro → caramelo), desde que pareça.
    const used = new Set<RGB>([ink, paper]);
    const pick: RGB[] = new Array(centers.length);
    centers.map((c, i) => ({ c, i })).sort((a, b) => b.c.w - a.c.w).forEach(({ c, i }) => {
      const best = nearest(c);
      if (!used.has(best)) { used.add(best); pick[i] = best; return; }
      const free = fil.filter((f) => !used.has(f));
      const alt = free.length ? nearest(c, free) : null;
      if (alt && pdist(c, alt) < 150) { used.add(alt); pick[i] = alt; } else pick[i] = best;
    });
    shown = pick;
  }
  // "palette" classifica os pixels (cores originais); "paint" é o que vai para a imagem final.
  const palette: RGB[] = [BLACK, WHITE, ...centers.map((c) => ({ r: c.r, g: c.g, b: c.b }))];
  const paint: RGB[] = [ink, paper, ...shown];

  // cada bloco do histograma → cor da paleta
  const lut = new Uint8Array(32768);
  for (const p of bins) {
    if (isBlackish(p)) { lut[p.k] = 0; continue; }
    if (isWhitish(p)) { lut[p.k] = 1; continue; }
    let bi = 0, bd = Infinity;
    for (let c = 0; c < palette.length; c++) { const d = dist(p, palette[c]); if (d < bd) { bd = d; bi = c; } }
    lut[p.k] = bi;
  }
  const UNSET = 255;
  let idx = new Uint8Array(total).fill(UNSET);
  for (let i = 0; i < total; i++) {
    if (flat[i]) idx[i] = lut[((data[i * 4] >> 3) << 10) | ((data[i * 4 + 1] >> 3) << 5) | (data[i * 4 + 2] >> 3)];
  }
  // Bordas: cada pixel só pode assumir uma cor que já existe ao lado dele.
  const offsets = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
  for (let pass = 0; pass < 6; pass++) {
    const out = new Uint8Array(idx);
    let pending = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const o = y * w + x;
        if (idx[o] !== UNSET) continue;
        const px = { r: data[o * 4], g: data[o * 4 + 1], b: data[o * 4 + 2] };
        let best = UNSET, bd = Infinity;
        for (const d of offsets) {
          const c = idx[o + d];
          if (c === UNSET) continue;
          const dd = dist(px, palette[c]);
          if (dd < bd) { bd = dd; best = c; }
        }
        if (best === UNSET) pending++; else out[o] = best;
      }
    }
    idx = out;
    if (!pending) break;
  }
  for (let i = 0; i < total; i++) {
    if (idx[i] !== UNSET) continue;
    const px = { r: data[i * 4], g: data[i * 4 + 1], b: data[i * 4 + 2] };
    let bi = 1, bd = Infinity;
    for (let c = 0; c < palette.length; c++) { const d = dist(px, palette[c]); if (d < bd) { bd = d; bi = c; } }
    idx[i] = bi;
  }

  // filtro de maioria 3×3: tira pontinhos soltos e a franja do anti-serrilhado
  const n = palette.length;
  const votes = new Uint16Array(n);
  for (let pass = 0; pass < 2; pass++) {
    const out = new Uint8Array(idx);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const o = y * w + x;
        votes.fill(0);
        votes[idx[o - w - 1]]++; votes[idx[o - w]]++; votes[idx[o - w + 1]]++;
        votes[idx[o - 1]]++; votes[idx[o]]++; votes[idx[o + 1]]++;
        votes[idx[o + w - 1]]++; votes[idx[o + w]]++; votes[idx[o + w + 1]]++;
        let best = idx[o];
        for (let c = 0; c < n; c++) if (votes[c] > votes[best]) best = c;
        if (votes[best] >= 5) out[o] = best;
      }
    }
    idx = out;
  }

  for (let i = 0; i < total; i++) {
    const c = paint[idx[i]];
    data[i * 4] = c.r; data[i * 4 + 1] = c.g; data[i * 4 + 2] = c.b; data[i * 4 + 3] = 255;
  }
  const hex = (c: RGB) => "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");
  return { png: new Uint8Array(PNG.sync.write(img)), palette: paint.map(hex) };
}
