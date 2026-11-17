// Patinha de Natal — API única (Supabase Edge Function)
//
// O site (pasta /site) só conversa com esta função. Ela cuida de:
//   • criar o pedido e o pagamento no Mercado Pago
//   • confirmar o pagamento (webhook + conferência ativa)
//   • gerar a arte do pet com a IA de imagem da OpenAI
//   • guardar escolha + endereço e servir o painel do administrador
//
// Chaves: podem vir de variáveis de ambiente (Secrets da função) ou da tabela
// pn_settings, preenchida pelo painel /admin.html. A variável de ambiente ganha.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { flattenColors } from "./flatten.ts";
import { checkRegion, esc, mailLayout, quoteShipping, REGION_LABEL, REGIONS, sendMail } from "./extras.ts";
import { artPrompt, SPECIES } from "./prompts.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const BUCKET = "pn-pets";
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/pn-api`;
const STALE_GENERATION_MS = 5 * 60 * 1000;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info, x-admin-password",
  "Access-Control-Max-Age": "86400",
};

const DEMO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="#fff"/><circle cx="512" cy="512" r="400" fill="#fff" stroke="#111" stroke-width="22"/><g fill="#C9793A" stroke="#111" stroke-width="16" stroke-linejoin="round"><path d="M300 330 250 150l170 110zM724 330l50-180-170 110z"/><ellipse cx="512" cy="500" rx="235" ry="215"/><path d="M330 880c0-150 80-230 182-230s182 80 182 230z"/></g><g fill="#fff" stroke="#111" stroke-width="16"><ellipse cx="512" cy="580" rx="110" ry="88"/><rect x="290" y="840" width="130" height="110" rx="55"/><rect x="604" y="840" width="130" height="110" rx="55"/></g><circle cx="420" cy="470" r="36" fill="#111"/><circle cx="604" cy="470" r="36" fill="#111"/><circle cx="432" cy="458" r="11" fill="#fff"/><circle cx="616" cy="458" r="11" fill="#fff"/><ellipse cx="512" cy="548" rx="34" ry="24" fill="#111"/><path d="M512 572v34m-54 4c20 30 88 30 108 0" fill="none" stroke="#111" stroke-width="14" stroke-linecap="round"/><text x="512" y="1005" text-anchor="middle" font-family="Arial" font-size="40" font-weight="700" fill="#111">ARTE DE TESTE</text></svg>`;

// ───────────────────────── utilidades ─────────────────────────

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (v: unknown, max = 200) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

function normalizePhone(v: unknown): string {
  let d = digits(v);
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  return d;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function orderCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const r = crypto.getRandomValues(new Uint8Array(6));
  return "PN-" + Array.from(r, (b) => alphabet[b % alphabet.length]).join("");
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ───────────────────────── configurações ─────────────────────────

type Settings = Record<string, string>;

async function loadSettings(): Promise<Settings> {
  const { data, error } = await db.from("pn_settings").select("key, value");
  if (error) throw new HttpError(500, "Banco de dados indisponível.");
  const s: Settings = {};
  for (const row of data ?? []) s[row.key] = row.value;
  return s;
}

const DEFAULT_FILAMENTS = `Branco #F2F2EE
Preto #161616
Cinza #8A8D8F
Cinza escuro #4F5356
Marrom #6B4226
Bege #E3C9A4
Caramelo #C98A3E
Laranja #E8761E
Amarelo #F4C21C
Rosa #F29BB2
Vermelho #C8202F
Verde #2F8F4E
Azul #2D6CC0`;

export function parseFilaments(raw: string | undefined): { name: string; hex: string }[] {
  const out: { name: string; hex: string }[] = [];
  for (const line of String(raw || DEFAULT_FILAMENTS).split(/\r?\n/)) {
    const m = /^(.*?)[\s:;,-]*(#[0-9a-f]{6})\s*$/i.exec(line.trim());
    if (m && m[1].trim()) out.push({ name: m[1].trim().slice(0, 30), hex: m[2].toUpperCase() });
  }
  return out.slice(0, 30);
}

function parseRegions(raw: string | undefined): Record<string, { on: boolean; until: string }> {
  let parsed: Record<string, { on?: boolean; until?: string }> = {};
  try { parsed = JSON.parse(raw || "{}"); } catch (_) { /* padrão */ }
  const out: Record<string, { on: boolean; until: string }> = {};
  for (const r of REGIONS) {
    const v = parsed[r] || {};
    out[r] = { on: v.on !== false, until: /^\d{4}-\d{2}-\d{2}$/.test(String(v.until || "")) ? String(v.until) : "" };
  }
  return out;
}

const num = (v: string | undefined, def: number, min: number, max: number) => {
  const n = parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

function parseTable(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(raw || "{}"); } catch (_) { /* tabela vazia */ }
  for (const r of REGIONS) out[r] = Math.max(0, Math.round(Number(parsed[r]) || 0));
  return out;
}

function cfg(s: Settings) {
  const env = (k: string) => (Deno.env.get(k) ?? "").trim();
  return {
    mpToken: env("MP_ACCESS_TOKEN") || s.mp_access_token || "",
    openaiKey: env("OPENAI_API_KEY") || s.openai_api_key || "",
    imageModel: env("OPENAI_IMAGE_MODEL") || s.openai_image_model || "gpt-image-2",
    imageQuality: s.openai_image_quality || "medium",
    priceCents: Math.max(100, parseInt(s.price_cents || "4990", 10) || 4990),
    credits: Math.min(10, Math.max(1, parseInt(s.credits_per_order || "3", 10) || 3)),
    testMode: s.test_mode === "true",
    maxColors: Math.min(6, Math.max(2, parseInt(s.max_colors || "4", 10) || 4)),
    adminHash: s.admin_password_hash || "",
    filaments: parseFilaments(s.filaments),
    extraPrices: String(s.extra_prices || "1290,990,690").split(",").map((v) => Math.max(0, parseInt(v, 10) || 0)).filter((v) => v > 0).slice(0, 3),
    extraCredits: Math.min(10, Math.max(1, parseInt(s.extra_credits || "3", 10) || 3)),
    model: {
      diameter: num(s.model_diameter, 70, 40, 120),
      base: num(s.model_base, 3.2, 1.2, 5),
      band: num(s.model_band, 0.4, 0.2, 1.2),
    },
    shipping: {
      regions: parseRegions(s.regions),
      packageCm: { length: num(s.package_length, 16, 1, 100), width: num(s.package_width, 11, 1, 100), height: num(s.package_height, 2, 1, 100) },
      mode: ["incluso", "tabela", "melhor_envio"].includes(s.shipping_mode) ? s.shipping_mode : "incluso",
      table: parseTable(s.shipping_table),
      originCep: digits(s.origin_cep),
      melhorEnvioToken: env("MELHOR_ENVIO_TOKEN") || s.melhor_envio_token || "",
      weightGrams: Math.max(10, parseInt(s.package_weight_g || "50", 10) || 50),
      contactEmail: s.owner_email || "",
    },
    mail: {
      apiKey: env("RESEND_API_KEY") || s.resend_api_key || "",
      from: s.email_from || "",
      brand: s.brand_name || "Patinha de Natal",
    },
    ownerEmail: s.owner_email || "",
    pickup: {
      enabled: s.pickup_enabled !== "false",
      name: s.pickup_name || "Studio Lina Palma",
      address: s.pickup_address || "Rua 7 de Setembro, 433 - Centro, Cosmópolis - SP, 13150-013",
    },
    store: {
      whatsapp: digits(s.store_whatsapp),
      company: s.store_company || "",
      cnpj: s.store_cnpj || "",
      email: s.store_email || "",
      size: s.store_size || "",
      lead_time: s.store_lead_time || "",
      notice: s.store_notice || "",
      meta_pixel_id: s.meta_pixel_id || "",
      google_tag_id: s.google_tag_id || "",
    },
  };
}

async function saveSetting(key: string, value: string) {
  const { error } = await db.from("pn_settings").upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw new HttpError(500, "Não foi possível salvar a configuração.");
}

// ───────────────────────── Mercado Pago ─────────────────────────

async function mp(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`https://api.mercadopago.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("mercadopago", path, res.status, JSON.stringify(body).slice(0, 500));
    throw new HttpError(502, "O Mercado Pago não respondeu. Tente de novo em instantes.");
  }
  return body;
}

// Aplica no pedido o que o Mercado Pago diz sobre um pagamento.
// A verdade vem sempre da API deles, nunca do que chega no navegador ou no webhook.
// deno-lint-ignore no-explicit-any
async function applyPayment(payment: any) {
  const orderId = payment?.external_reference;
  if (!isUuid(orderId)) return;
  const { data: order } = await db.from("pn_orders").select("id, amount_cents, payment_status").eq("id", orderId).maybeSingle();
  if (!order) return;

  if (payment.status === "approved" && order.payment_status === "pending") {
    const paidCents = Math.round(Number(payment.transaction_amount) * 100);
    if (payment.currency_id !== "BRL" || paidCents < order.amount_cents) {
      console.error("pagamento com valor divergente", orderId, paidCents, order.amount_cents);
      return;
    }
    const { data: paid } = await db.from("pn_orders")
      .update({ payment_status: "paid", paid_at: new Date().toISOString(), mp_payment_id: String(payment.id) })
      .eq("id", orderId).eq("payment_status", "pending").select("*");
    if (paid?.length) await notify("paid", paid[0], cfg(await loadSettings()));
  } else if (["refunded", "charged_back"].includes(payment.status) && order.payment_status === "paid") {
    await db.from("pn_orders").update({ payment_status: "refunded" }).eq("id", orderId);
  }
}

// ───────────────────────── e-mails do pedido ─────────────────────────

// deno-lint-ignore no-explicit-any
async function notify(event: "paid" | "confirmed" | "shipped", order: any, c: ReturnType<typeof cfg>) {
  if (!c.mail.apiKey || !c.mail.from) return;
  const link = order.site_url ? `${order.site_url}criar.html?t=${order.token}` : "";
  const first = esc(String(order.name || "").split(" ")[0]);
  const button = link ? { text: event === "paid" ? "Enviar a foto do meu pet" : "Acompanhar meu pedido", url: link } : undefined;
  if (event === "paid") {
    await sendMail(c.mail, order.email, `Pagamento confirmado — pedido ${order.code}`, mailLayout(c.mail.brand, "Pagamento confirmado! 🎄", [
      `Olá, ${first}! Recebemos o seu pagamento.`,
      "Agora é só enviar a foto do seu pet, escolher a arte e informar o endereço de entrega.",
      "Guarde este e-mail: o botão abaixo abre o seu pedido em qualquer aparelho.",
    ], button));
  } else if (event === "confirmed") {
    const pickup = order.delivery_method === "retirada";
    const address = pickup ? `Retirada em ${esc(c.pickup.name)}<br>${esc(c.pickup.address)}` : `${esc(order.street)}, ${esc(order.number)}${order.complement ? " — " + esc(order.complement) : ""}<br>${esc(order.district)} · ${esc(order.city)}/${esc(order.state)} · CEP ${esc(order.cep)}`;
    await sendMail(c.mail, order.email, `Pedido ${order.code} confirmado`, mailLayout(c.mail.brand, "Seu enfeite vai para a produção 🐾", [
      `Olá, ${first}! Recebemos a arte escolhida e o endereço.`,
      `<strong>Entrega para:</strong><br>${esc(order.recipient)}<br>${address}`,
      pickup ? "Avisamos por e-mail e WhatsApp quando estiver pronto para retirar." : "Assim que o pacote for postado, você recebe o código de rastreio por e-mail.",
    ], button));
    if (c.ownerEmail) {
      await sendMail(c.mail, c.ownerEmail, `Novo pedido para produzir — ${order.code}`, mailLayout(c.mail.brand, `Pedido ${esc(order.code)} pronto para produzir`, [
        `<strong>Cliente:</strong> ${esc(order.name)} · ${esc(order.whatsapp)}`,
        `<strong>Pet:</strong> ${esc(order.pet_name || "—")}${order.extras ? ` · + ${order.extras} enfeite(s) adicional(is)` : ""}`,
        ...(order.customer_notes ? [`<strong>Observações do cliente:</strong> ${esc(order.customer_notes)}`] : []),
        `<strong>${pickup ? "Retirada" : "Entrega"}:</strong><br>${esc(order.recipient)}<br>${address}`,
        "A arte e o modelo 3D (3MF ou STLs por cor) estão no painel, prontos para baixar.",
      ]));
    }
  } else if (order.delivery_method === "retirada") {
    await sendMail(c.mail, order.email, `Seu enfeite está pronto para retirar — pedido ${order.code}`, mailLayout(c.mail.brand, "Pronto para retirar! 🎁", [
      `Olá, ${first}! O seu enfeite está pronto.`,
      `<strong>Onde retirar:</strong> ${esc(c.pickup.name)}<br>${esc(c.pickup.address)}`,
      "Leve o código do pedido: " + esc(order.code) + ".",
    ], button));
  } else {
    await sendMail(c.mail, order.email, `Seu enfeite foi enviado — pedido ${order.code}`, mailLayout(c.mail.brand, "Seu enfeite está a caminho! 📦", [
      `Olá, ${first}! Postamos o seu pedido.`,
      order.tracking_code ? `<strong>Código de rastreio:</strong> ${esc(order.tracking_code)}` : "Em breve o código de rastreio aparece na página do pedido.",
    ], button));
  }
}

async function syncOrderPayment(token: string, orderId: string) {
  const found = await mp(token, `/v1/payments/search?external_reference=${orderId}&sort=date_created&criteria=desc&limit=10`);
  // deno-lint-ignore no-explicit-any
  const approved = (found.results ?? []).find((p: any) => p.status === "approved");
  if (approved) await applyPayment(approved);
}

// ───────────────────────── pedidos ─────────────────────────

// deno-lint-ignore no-explicit-any
async function getOrderByToken(token: unknown): Promise<any> {
  if (typeof token !== "string" || !/^[0-9a-f]{48}$/.test(token)) throw new HttpError(404, "Pedido não encontrado.");
  const { data } = await db.from("pn_orders").select("*").eq("token", token).maybeSingle();
  if (!data) throw new HttpError(404, "Pedido não encontrado.");
  return data;
}

async function signedUrls(paths: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))];
  if (!unique.length) return {};
  const { data } = await db.storage.from(BUCKET).createSignedUrls(unique, 60 * 60 * 24);
  const out: Record<string, string> = {};
  for (const item of data ?? []) if (item.path && item.signedUrl) out[item.path] = item.signedUrl;
  return out;
}

async function expireStaleGenerations(orderId: string) {
  const limit = new Date(Date.now() - STALE_GENERATION_MS).toISOString();
  const { data } = await db.from("pn_generations").select("id")
    .eq("order_id", orderId).eq("status", "processing").lt("created_at", limit);
  for (const g of data ?? []) await db.rpc("pn_fail_generation", { p_gen: g.id, p_error: "timeout" });
}

// deno-lint-ignore no-explicit-any
async function orderView(order: any) {
  await expireStaleGenerations(order.id);
  const { data: fresh } = await db.from("pn_orders").select("*").eq("id", order.id).single();
  const o = fresh ?? order;
  const { data: gens } = await db.from("pn_generations")
    .select("id, status, item, result_path, created_at").eq("order_id", o.id).order("created_at");
  const { data: items } = await db.from("pn_order_items")
    .select("position, kind, credits_total, credits_used, chosen_generation, pet_name").eq("order_id", o.id).order("position");
  const urls = await signedUrls((gens ?? []).map((g) => g.result_path));
  return {
    extras: o.extras,
    items: (items ?? []).map((it) => ({
      position: it.position, kind: it.kind, chosen_generation: it.chosen_generation, pet_name: it.pet_name,
      credits_total: it.credits_total, credits_left: Math.max(0, it.credits_total - it.credits_used),
    })),
    code: o.code,
    name: o.name,
    payment_status: o.payment_status,
    is_test: o.is_test,
    credits_total: o.credits_total,
    credits_left: Math.max(0, o.credits_total - o.credits_used),
    generations: (gens ?? []).map((g) => ({
      id: g.id, status: g.status, item: g.item ?? 0,
      url: g.result_path ? urls[g.result_path] ?? null : null,
      // link curto e permanente da arte, para o cliente mandar no WhatsApp
      share_url: g.result_path ? `${FUNCTION_URL}?action=art&g=${g.id}` : null,
    })),
    chosen_generation: o.chosen_generation,
    customer_notes: o.customer_notes,
    confirmed: !!o.confirmed_at,
    production_status: o.production_status,
    tracking_code: o.tracking_code,
    pet_name: o.pet_name,
    amount_cents: o.amount_cents,
    shipping_cents: o.shipping_cents,
    locked_cep: o.shipping_cents > 0 ? o.cep : null,
    delivery_method: o.delivery_method,
    address: o.confirmed_at
      ? { recipient: o.recipient, cep: o.cep, street: o.street, number: o.number, complement: o.complement, district: o.district, city: o.city, state: o.state }
      : null,
  };
}

// ───────────────────────── geração da arte ─────────────────────────

async function runGeneration(genId: string, orderId: string, photo: Uint8Array, photoType: string, species: string, c: ReturnType<typeof cfg>) {
  try {
    let bytes: Uint8Array;
    let ext = "png";
    let type = "image/png";

    if (c.openaiKey) {
      const form = new FormData();
      form.append("model", c.imageModel);
      form.append("image[]", new Blob([photo as BlobPart], { type: photoType }), photoType === "image/png" ? "pet.png" : "pet.jpg");
      form.append("prompt", artPrompt(species, c.maxColors, c.filaments.map((f) => f.name)));
      form.append("size", "1024x1024");
      form.append("quality", c.imageQuality);
      form.append("n", "1");
      const res = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${c.openaiKey}` },
        body: form,
        signal: AbortSignal.timeout(240000),
      });
      const body = await res.json().catch(() => ({}));
      const b64 = body?.data?.[0]?.b64_json;
      if (!res.ok || !b64) {
        throw new Error(`openai ${res.status}: ${body?.error?.code ?? ""} ${body?.error?.message ?? "sem imagem"}`);
      }
      bytes = b64ToBytes(b64);
      // Garante o limite de cores da impressão: o cliente escolhe vendo o resultado final.
      try {
        bytes = flattenColors(bytes, c.maxColors, c.filaments.map((f) => f.hex)).png;
      } catch (err) {
        console.error("redução de cores falhou; mantendo a arte original", err);
      }
    } else if (c.testMode) {
      await sleep(4000);
      bytes = new TextEncoder().encode(DEMO_SVG);
      ext = "svg";
      type = "image/svg+xml";
    } else {
      throw new Error("OPENAI_API_KEY não configurada");
    }

    const path = `${orderId}/${genId}-arte.${ext}`;
    const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: true });
    if (up.error) throw new Error(`storage: ${up.error.message}`);

    await db.from("pn_generations")
      .update({ status: "done", result_path: path, finished_at: new Date().toISOString() })
      .eq("id", genId).eq("status", "processing");
  } catch (err) {
    console.error("geração falhou", genId, err);
    await db.rpc("pn_fail_generation", { p_gen: genId, p_error: String((err as Error)?.message ?? err) });
  }
}

// ───────────────────────── ações públicas ─────────────────────────

// deno-lint-ignore no-explicit-any
type Body = Record<string, any>;

async function publicConfig() {
  const c = cfg(await loadSettings());
  return json({
    price_cents: c.priceCents,
    credits: c.credits,
    test_mode: c.testMode,
    sales_open: c.testMode || !!c.mpToken,
    shipping_mode: c.shipping.mode === "incluso" ? "incluso" : "calculado",
    store: c.store,
    pickup: c.pickup.enabled ? { name: c.pickup.name, address: c.pickup.address } : null,
    extra_prices: c.extraPrices,
    extra_credits: c.extraCredits,
    model: c.model,
    filaments: c.filaments,
    regions: REGIONS.map((r) => ({ id: r, label: REGION_LABEL[r], on: c.shipping.regions[r].on, until: c.shipping.regions[r].until })),
  });
}

// Abre a arte de uma geração (o id é secreto e impossível de adivinhar).
async function openArt(url: URL) {
  const id = url.searchParams.get("g");
  if (!isUuid(id)) throw new HttpError(404, "Arte não encontrada.");
  const { data: gen } = await db.from("pn_generations").select("result_path").eq("id", id).eq("status", "done").maybeSingle();
  if (!gen?.result_path) throw new HttpError(404, "Arte não encontrada.");
  const { data } = await db.storage.from(BUCKET).createSignedUrl(gen.result_path, 60 * 60);
  if (!data?.signedUrl) throw new HttpError(404, "Arte não encontrada.");
  return new Response(null, { status: 302, headers: { ...CORS, Location: data.signedUrl, "Cache-Control": "no-store" } });
}

// Quantos adicionais (0..3) e quanto custam: o 2º enfeite custa extra_prices[0], o 3º [1]…
function extrasOf(c: ReturnType<typeof cfg>, v: unknown) {
  const n = Math.max(0, Math.min(c.extraPrices.length, parseInt(String(v ?? 0), 10) || 0));
  const prices = c.extraPrices.slice(0, n);
  return { n, prices, cents: prices.reduce((a, b) => a + b, 0) };
}

// Pacote um pouco mais pesado quando vão mais peças (≈ 20 g cada).
function shippingFor(c: ReturnType<typeof cfg>, extras: number) {
  return { ...c.shipping, weightGrams: c.shipping.weightGrams + extras * 20 };
}

async function quote(b: Body) {
  const c = cfg(await loadSettings());
  const cep = digits(b.cep);
  if (cep.length !== 8) throw new HttpError(400, "Confira o CEP (8 números).");
  try {
    checkRegion(c.shipping, cep);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  try {
    const ex = extrasOf(c, b.extras);
    const q = await quoteShipping(shippingFor(c, ex.n), cep);
    return json({ shipping_cents: q.cents, label: q.label, days: q.days, price_cents: c.priceCents, extras_cents: ex.cents, total_cents: c.priceCents + ex.cents + q.cents });
  } catch (_) {
    throw new HttpError(400, "Não encontramos esse CEP. Confira os números.");
  }
}

async function checkout(b: Body) {
  const c = cfg(await loadSettings());
  const name = clean(b.name, 120);
  const email = clean(b.email, 160).toLowerCase();
  const whatsapp = normalizePhone(b.whatsapp);
  if (name.length < 3) throw new HttpError(400, "Digite seu nome completo.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, "Confira seu e-mail.");
  if (whatsapp.length < 10 || whatsapp.length > 11) throw new HttpError(400, "Confira seu WhatsApp com DDD.");

  let site: URL;
  try {
    site = new URL(String(b.site_url));
    if (!/^https?:$/.test(site.protocol)) throw new Error();
  } catch {
    throw new HttpError(400, "Endereço do site inválido.");
  }
  const base = site.origin + site.pathname.replace(/[^/]*$/, "");

  if (!c.testMode && !c.mpToken) {
    throw new HttpError(503, "As vendas ainda não foram abertas. Volte em breve!");
  }

  // O frete é sempre recalculado aqui: o valor cobrado nunca vem do navegador.
  const pickup = b.delivery === "retirada";
  const ex = extrasOf(c, b.extras);
  if (pickup && !c.pickup.enabled) throw new HttpError(400, "A retirada não está disponível no momento.");
  let shipping = { cents: 0, label: pickup ? "Retirada: " + c.pickup.name : "Frete incluso" };
  const cep = pickup ? "" : digits(b.cep);
  if (!pickup && cep.length !== 8) throw new HttpError(400, "Digite o CEP de entrega (8 números).");
  if (!pickup) {
    try {
      checkRegion(c.shipping, cep);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }
  if (!pickup && c.shipping.mode !== "incluso") {
    try {
      shipping = await quoteShipping(shippingFor(c, ex.n), cep);
    } catch (_) {
      throw new HttpError(400, "Não encontramos esse CEP. Confira os números.");
    }
  }
  const totalCents = c.priceCents + ex.cents + shipping.cents;

  const token = randomHex(24);
  const { data: order, error } = await db.from("pn_orders").insert({
    code: orderCode(),
    token,
    name,
    email,
    whatsapp,
    amount_cents: totalCents,
    shipping_cents: shipping.cents,
    shipping_label: shipping.label,
    cep: cep || null,
    delivery_method: pickup ? "retirada" : "correios",
    extras: ex.n,
    extras_cents: ex.cents,
    site_url: base,
    credits_total: c.credits,
    is_test: c.testMode,
    ...(c.testMode ? { payment_status: "paid", paid_at: new Date().toISOString() } : {}),
  }).select("*").single();
  if (error || !order) throw new HttpError(500, "Não foi possível criar o pedido. Tente de novo.");
  if (ex.n) {
    const rows = Array.from({ length: ex.n }, (_, i) => ({ order_id: order.id, position: i + 1, credits_total: c.extraCredits }));
    const { error: itemsError } = await db.from("pn_order_items").insert(rows);
    if (itemsError) {
      await db.from("pn_orders").delete().eq("id", order.id);
      throw new HttpError(500, "Não foi possível criar o pedido. Tente de novo.");
    }
  }

  const studio = `${base}criar.html?t=${token}`;
  if (c.testMode) {
    await notify("paid", order, c);
    return json({ redirect: studio, token });
  }

  try {
    const pref = await mp(c.mpToken, "/checkout/preferences", {
      method: "POST",
      body: JSON.stringify({
        items: [{
          id: "enfeite-pet",
          title: "Enfeite de Natal personalizado do seu pet",
          description: `Pedido ${order.code}`,
          quantity: 1,
          currency_id: "BRL",
          unit_price: c.priceCents / 100,
        }, ...ex.prices.map((cents, i) => ({
          id: "enfeite-adicional-" + (i + 1),
          title: `Enfeite adicional ${i + 1}`,
          quantity: 1,
          currency_id: "BRL",
          unit_price: cents / 100,
        })), ...(shipping.cents > 0 ? [{
          id: "frete",
          title: "Frete",
          description: shipping.label,
          quantity: 1,
          currency_id: "BRL",
          unit_price: shipping.cents / 100,
        }] : [])],
        payer: { name, email },
        external_reference: order.id,
        back_urls: { success: studio, pending: studio, failure: `${base}index.html?pagamento=falhou#comprar` },
        ...(site.protocol === "https:" ? { auto_return: "approved" } : {}),
        notification_url: `${FUNCTION_URL}?action=mp-webhook`,
        statement_descriptor: "PATINHA NATAL",
        payment_methods: { excluded_payment_types: [{ id: "ticket" }], installments: 3 },
      }),
    });
    await db.from("pn_orders").update({ mp_preference_id: pref.id }).eq("id", order.id);
    return json({ redirect: pref.init_point, token });
  } catch (err) {
    await db.from("pn_orders").delete().eq("id", order.id);
    throw err;
  }
}

async function getOrder(b: Body) {
  let order = await getOrderByToken(b.token);
  if (order.payment_status === "pending" && !order.is_test) {
    const c = cfg(await loadSettings());
    if (c.mpToken) {
      try {
        await syncOrderPayment(c.mpToken, order.id);
        order = await getOrderByToken(b.token);
      } catch (_) { /* segue como pendente; o webhook ou a próxima consulta resolvem */ }
    }
  }
  return json({ order: await orderView(order) });
}

async function recover(b: Body) {
  await sleep(600);
  const email = clean(b.email, 160).toLowerCase();
  const whatsapp = normalizePhone(b.whatsapp);
  if (!email || whatsapp.length < 10) throw new HttpError(400, "Preencha o e-mail e o WhatsApp usados na compra.");
  const { data } = await db.from("pn_orders").select("token")
    .eq("email", email).eq("whatsapp", whatsapp).eq("payment_status", "paid")
    .order("created_at", { ascending: false }).limit(1);
  if (!data?.length) throw new HttpError(404, "Não encontramos um pedido pago com esses dados.");
  return json({ token: data[0].token });
}

async function generate(req: Request) {
  const form = await req.formData();
  const order = await getOrderByToken(form.get("token"));
  if (order.payment_status !== "paid") throw new HttpError(402, "O pagamento ainda não foi confirmado.");
  if (order.confirmed_at) throw new HttpError(409, "Este pedido já foi finalizado.");

  const file = form.get("photo");
  if (!(file instanceof File)) throw new HttpError(400, "Envie uma foto do seu pet.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new HttpError(400, "Envie uma foto em JPG ou PNG.");
  if (file.size > MAX_PHOTO_BYTES) throw new HttpError(413, "A foto é muito grande. Tente outra.");
  const photo = new Uint8Array(await file.arrayBuffer());

  const c = cfg(await loadSettings());
  if (!c.openaiKey && !c.testMode) throw new HttpError(503, "A criação de artes está temporariamente indisponível.");
  const item = Math.max(0, Math.min(3, parseInt(String(form.get("item") ?? "0"), 10) || 0));
  if (item > (order.extras ?? 0)) throw new HttpError(400, "Esse enfeite não faz parte do pedido.");
  const species = String(form.get("species") || "");
  if (!(SPECIES as readonly string[]).includes(species)) throw new HttpError(400, "Escolha qual é o seu pet: gato, cachorro, ave ou roedor.");

  await expireStaleGenerations(order.id);
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const sourcePath = `${order.id}/${Date.now()}-foto.${ext}`;
  const up = await db.storage.from(BUCKET).upload(sourcePath, photo, { contentType: file.type });
  if (up.error) throw new HttpError(500, "Não conseguimos receber a foto. Tente de novo.");

  const { data: genId, error } = await db.rpc("pn_start_generation_item", { p_order: order.id, p_item: item, p_source: sourcePath });
  if (error) throw new HttpError(500, "Não foi possível iniciar a criação.");
  if (!genId) {
    await db.storage.from(BUCKET).remove([sourcePath]);
    throw new HttpError(409, "Você já usou todas as suas tentativas, ou uma arte ainda está sendo criada.");
  }

  await db.from("pn_generations").update({ species }).eq("id", genId);
  const task = runGeneration(genId, order.id, photo, file.type, species, c);
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(task);
  else await task;

  return json({ generation_id: genId });
}

async function choose(b: Body) {
  const order = await getOrderByToken(b.token);
  if (order.payment_status !== "paid") throw new HttpError(402, "O pagamento ainda não foi confirmado.");
  if (order.confirmed_at) throw new HttpError(409, "Este pedido já foi finalizado.");
  if (!isUuid(b.generation_id)) throw new HttpError(400, "Escolha uma das artes.");
  const item = Math.max(0, parseInt(String(b.item ?? 0), 10) || 0);
  const { data: gen } = await db.from("pn_generations").select("id")
    .eq("id", b.generation_id).eq("order_id", order.id).eq("item", item).eq("status", "done").maybeSingle();
  if (!gen) throw new HttpError(400, "Essa arte não está disponível.");
  if (item === 0) await db.from("pn_orders").update({ chosen_generation: gen.id }).eq("id", order.id);
  else await db.from("pn_order_items").update({ chosen_generation: gen.id, kind: "novo" }).eq("order_id", order.id).eq("position", item);
  return json({ ok: true });
}

// Para cada adicional: "novo" (outro pet, com arte própria) ou "copia" (mais um igual ao primeiro).
async function itemKind(b: Body) {
  const order = await getOrderByToken(b.token);
  if (order.confirmed_at) throw new HttpError(409, "Este pedido já foi finalizado.");
  const item = parseInt(String(b.item ?? 0), 10) || 0;
  if (!(item >= 1 && item <= (order.extras ?? 0))) throw new HttpError(400, "Esse enfeite não faz parte do pedido.");
  if (!["novo", "copia"].includes(b.kind)) throw new HttpError(400, "Escolha: outro pet ou mais um igual.");
  await db.from("pn_order_items").update({ kind: b.kind, ...(b.kind === "copia" ? { chosen_generation: null } : {}) })
    .eq("order_id", order.id).eq("position", item);
  return json({ order: await orderView(await getOrderByToken(b.token)) });
}

async function confirm(b: Body) {
  const order = await getOrderByToken(b.token);
  if (order.payment_status !== "paid") throw new HttpError(402, "O pagamento ainda não foi confirmado.");
  if (!order.chosen_generation) throw new HttpError(400, "Escolha uma arte antes de continuar.");
  const { data: items } = await db.from("pn_order_items").select("position, kind, chosen_generation").eq("order_id", order.id).order("position");
  for (const it of items ?? []) {
    if (!it.kind) throw new HttpError(400, `Diga se o enfeite ${it.position + 1} é de outro pet ou mais um igual.`);
    if (it.kind === "novo" && !it.chosen_generation) throw new HttpError(400, `Escolha a arte do enfeite ${it.position + 1}.`);
  }
  const names: unknown[] = Array.isArray(b.pet_names) ? b.pet_names : [];
  if (order.production_status !== "aguardando") throw new HttpError(409, "Seu enfeite já está em produção. Fale com a gente para alterar o endereço.");

  const pickup = order.delivery_method === "retirada";
  const a = {
    pet_name: clean(b.pet_name, 20) || null,
    customer_notes: clean(b.customer_notes, 500) || null,
    recipient: clean(b.recipient, 120),
    // Se o frete foi cobrado por CEP, a entrega é nesse CEP.
    cep: order.shipping_cents > 0 && order.cep ? order.cep : digits(b.cep),
    street: clean(b.street, 160),
    number: clean(b.number, 20),
    complement: clean(b.complement, 80) || null,
    district: clean(b.district, 100),
    city: clean(b.city, 100),
    state: clean(b.state, 2).toUpperCase(),
  };
  if (a.recipient.length < 3) throw new HttpError(400, pickup ? "Digite o nome de quem vai retirar." : "Digite o nome de quem vai receber.");
  if (pickup) {
    for (const k of ["cep", "street", "number", "complement", "district", "city", "state"] as const) (a as Record<string, unknown>)[k] = null;
  } else {
  if (a.cep.length !== 8) throw new HttpError(400, "Confira o CEP (8 números).");
  if (!a.street) throw new HttpError(400, "Digite o nome da rua.");
  if (!a.number) throw new HttpError(400, "Digite o número (ou S/N).");
  if (!a.district) throw new HttpError(400, "Digite o bairro.");
  if (!a.city) throw new HttpError(400, "Digite a cidade.");
  if (!/^[A-Z]{2}$/.test(a.state)) throw new HttpError(400, "Escolha o estado.");
  try {
    checkRegion(cfg(await loadSettings()).shipping, a.cep as string, false);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  }

  await db.from("pn_orders")
    .update({ ...a, confirmed_at: order.confirmed_at ?? new Date().toISOString() })
    .eq("id", order.id);
  for (const it of items ?? []) {
    await db.from("pn_order_items").update({ pet_name: clean(names[it.position], 20) || null }).eq("order_id", order.id).eq("position", it.position);
  }
  const saved = await getOrderByToken(b.token);
  if (!order.confirmed_at) await notify("confirmed", saved, cfg(await loadSettings()));
  return json({ order: await orderView(saved) });
}

async function mpWebhook(req: Request, url: URL) {
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const type = body?.type ?? url.searchParams.get("type") ?? url.searchParams.get("topic");
    const id = digits(body?.data?.id ?? url.searchParams.get("data.id") ?? url.searchParams.get("id"));
    if (type === "payment" && id) {
      const c = cfg(await loadSettings());
      if (c.mpToken) await applyPayment(await mp(c.mpToken, `/v1/payments/${id}`));
    }
  } catch (err) {
    console.error("webhook", err);
  }
  return json({ ok: true });
}

// ───────────────────────── painel do administrador ─────────────────────────

async function requireAdmin(req: Request): Promise<Settings> {
  const settings = await loadSettings();
  const hash = cfg(settings).adminHash;
  const given = req.headers.get("x-admin-password") ?? "";
  if (!hash || !given || !safeEqual(await sha256Hex("pn:" + given), hash)) {
    await sleep(800);
    throw new HttpError(401, "Senha incorreta.");
  }
  return settings;
}

function mask(v: string) {
  return v ? `••••${v.slice(-4)}` : "";
}

function settingsView(s: Settings) {
  const c = cfg(s);
  return {
    price_cents: c.priceCents,
    credits_per_order: c.credits,
    test_mode: c.testMode,
    max_colors: c.maxColors,
    openai_image_model: c.imageModel,
    openai_image_quality: c.imageQuality,
    mp_access_token: mask(c.mpToken),
    openai_api_key: mask(c.openaiKey),
    shipping_mode: c.shipping.mode,
    shipping_table: c.shipping.table,
    origin_cep: c.shipping.originCep,
    package_weight_g: c.shipping.weightGrams,
    melhor_envio_token: mask(c.shipping.melhorEnvioToken),
    resend_api_key: mask(c.mail.apiKey),
    email_from: c.mail.from,
    owner_email: c.ownerEmail,
    store: c.store,
    pickup: c.pickup,
    extra_prices: c.extraPrices,
    extra_credits: c.extraCredits,
    filaments_text: c.filaments.map((f) => `${f.name} ${f.hex}`).join("\n"),
    filaments: c.filaments,
    model: c.model,
    regions: c.shipping.regions,
    package_cm: c.shipping.packageCm,
    webhook_url: `${FUNCTION_URL}?action=mp-webhook`,
  };
}

async function adminOrders(b: Body) {
  let q = db.from("pn_orders").select("*").order("created_at", { ascending: false }).limit(300);
  if (!b.include_pending) q = q.neq("payment_status", "pending");
  const { data: orders, error } = await q;
  if (error) throw new HttpError(500, "Erro ao carregar pedidos.");

  const ids = (orders ?? []).map((o) => o.id);
  const { data: gens } = ids.length
    ? await db.from("pn_generations").select("id, order_id, status, species, item, source_path, result_path, created_at").in("order_id", ids).order("created_at")
    : { data: [] };
  const urls = await signedUrls((gens ?? []).flatMap((g) => [g.source_path, g.result_path]));
  const { data: allItems } = ids.length
    ? await db.from("pn_order_items").select("order_id, position, kind, chosen_generation, pet_name").in("order_id", ids).order("position")
    : { data: [] };

  return json({
    orders: (orders ?? []).map((o) => ({
      id: o.id, code: o.code, created_at: o.created_at, paid_at: o.paid_at, confirmed_at: o.confirmed_at,
      name: o.name, email: o.email, whatsapp: o.whatsapp, amount_cents: o.amount_cents,
      shipping_cents: o.shipping_cents, shipping_label: o.shipping_label, delivery_method: o.delivery_method,
      payment_status: o.payment_status, is_test: o.is_test, mp_payment_id: o.mp_payment_id,
      credits_total: o.credits_total, credits_used: o.credits_used,
      pet_name: o.pet_name, recipient: o.recipient, cep: o.cep, street: o.street, number: o.number,
      complement: o.complement, district: o.district, city: o.city, state: o.state,
      production_status: o.production_status, tracking_code: o.tracking_code, admin_notes: o.admin_notes,
      customer_notes: o.customer_notes,
      chosen_generation: o.chosen_generation,
      extras: o.extras, extras_cents: o.extras_cents,
      items: (allItems ?? []).filter((it) => it.order_id === o.id).map((it) => ({ position: it.position, kind: it.kind, chosen_generation: it.chosen_generation, pet_name: it.pet_name })),
      generations: (gens ?? []).filter((g) => g.order_id === o.id).map((g) => ({
        id: g.id, status: g.status, species: g.species, item: g.item ?? 0,
        photo_url: urls[g.source_path] ?? null,
        art_url: g.result_path ? urls[g.result_path] ?? null : null,
      })),
    })),
  });
}

async function adminUpdateOrder(b: Body) {
  if (!isUuid(b.id)) throw new HttpError(400, "Pedido inválido.");
  // deno-lint-ignore no-explicit-any
  const patch: Record<string, any> = {};
  if (b.production_status !== undefined) {
    if (!["aguardando", "producao", "enviado", "entregue"].includes(b.production_status)) throw new HttpError(400, "Status inválido.");
    patch.production_status = b.production_status;
  }
  if (b.tracking_code !== undefined) patch.tracking_code = clean(b.tracking_code, 40) || null;
  if (b.admin_notes !== undefined) patch.admin_notes = clean(b.admin_notes, 1000) || null;
  if (b.extra_credits !== undefined) {
    const { data: o } = await db.from("pn_orders").select("credits_total").eq("id", b.id).single();
    if (o) patch.credits_total = Math.min(20, o.credits_total + Math.max(0, parseInt(b.extra_credits, 10) || 0));
  }
  if (b.reopen === true) patch.confirmed_at = null;
  if (!Object.keys(patch).length) return json({ ok: true });
  const { data: before } = await db.from("pn_orders").select("production_status").eq("id", b.id).maybeSingle();
  const { data: after, error } = await db.from("pn_orders").update(patch).eq("id", b.id).select("*").maybeSingle();
  if (error) throw new HttpError(500, "Não foi possível salvar.");
  if (after && after.production_status === "enviado" && before?.production_status !== "enviado") {
    await notify("shipped", after, cfg(await loadSettings()));
  }
  return json({ ok: true });
}

async function adminSaveSettings(b: Body) {
  if (b.price_cents !== undefined) {
    const v = parseInt(b.price_cents, 10);
    if (!(v >= 100 && v <= 1000000)) throw new HttpError(400, "Preço inválido.");
    await saveSetting("price_cents", String(v));
  }
  if (b.credits_per_order !== undefined) {
    const v = parseInt(b.credits_per_order, 10);
    if (!(v >= 1 && v <= 10)) throw new HttpError(400, "Número de tentativas inválido (1 a 10).");
    await saveSetting("credits_per_order", String(v));
  }
  if (b.max_colors !== undefined) {
    const v = parseInt(b.max_colors, 10);
    if (!(v >= 2 && v <= 6)) throw new HttpError(400, "Número de cores inválido (2 a 6).");
    await saveSetting("max_colors", String(v));
  }
  if (b.test_mode !== undefined) await saveSetting("test_mode", b.test_mode ? "true" : "false");
  if (typeof b.shipping_mode === "string" && ["incluso", "tabela", "melhor_envio"].includes(b.shipping_mode)) {
    await saveSetting("shipping_mode", b.shipping_mode);
  }
  if (b.shipping_table && typeof b.shipping_table === "object") {
    await saveSetting("shipping_table", JSON.stringify(parseTable(JSON.stringify(b.shipping_table))));
  }
  if (typeof b.origin_cep === "string") {
    const v = digits(b.origin_cep);
    if (v && v.length !== 8) throw new HttpError(400, "CEP de origem inválido.");
    await saveSetting("origin_cep", v);
  }
  if (b.package_weight_g !== undefined) {
    const v = parseInt(b.package_weight_g, 10);
    if (!(v >= 10 && v <= 30000)) throw new HttpError(400, "Peso do pacote inválido.");
    await saveSetting("package_weight_g", String(v));
  }
  if (typeof b.melhor_envio_token === "string" && b.melhor_envio_token.trim()) await saveSetting("melhor_envio_token", b.melhor_envio_token.trim());
  if (typeof b.resend_api_key === "string" && b.resend_api_key.trim()) await saveSetting("resend_api_key", b.resend_api_key.trim());
  if (typeof b.email_from === "string") await saveSetting("email_from", clean(b.email_from, 160));
  if (typeof b.owner_email === "string") await saveSetting("owner_email", clean(b.owner_email, 160).toLowerCase());
  if (b.store && typeof b.store === "object") {
    const st = b.store;
    const text: [string, string, number][] = [
      ["company", "store_company", 160], ["cnpj", "store_cnpj", 30], ["email", "store_email", 160],
      ["size", "store_size", 30], ["lead_time", "store_lead_time", 60], ["notice", "store_notice", 200],
      ["meta_pixel_id", "meta_pixel_id", 40], ["google_tag_id", "google_tag_id", 40],
    ];
    for (const [field, key, max] of text) if (typeof st[field] === "string") await saveSetting(key, clean(st[field], max));
    if (typeof st.whatsapp === "string") {
      let w = digits(st.whatsapp);
      if (w && w.length <= 11) w = "55" + w;
      if (w && (w.length < 12 || w.length > 13)) throw new HttpError(400, "WhatsApp inválido. Use DDD + número.");
      await saveSetting("store_whatsapp", w);
    }
  }
  if (Array.isArray(b.extra_prices)) {
    const list = b.extra_prices.map((v: unknown) => Math.round(Number(v) || 0)).filter((v: number) => v >= 100 && v <= 1000000).slice(0, 3);
    await saveSetting("extra_prices", list.join(","));
  }
  if (b.extra_credits !== undefined) {
    const v = parseInt(b.extra_credits, 10);
    if (!(v >= 1 && v <= 10)) throw new HttpError(400, "Tentativas por pet adicional: de 1 a 10.");
    await saveSetting("extra_credits", String(v));
  }
  if (b.pickup && typeof b.pickup === "object") {
    if (b.pickup.enabled !== undefined) await saveSetting("pickup_enabled", b.pickup.enabled ? "true" : "false");
    if (typeof b.pickup.name === "string" && b.pickup.name.trim()) await saveSetting("pickup_name", clean(b.pickup.name, 80));
    if (typeof b.pickup.address === "string" && b.pickup.address.trim()) await saveSetting("pickup_address", clean(b.pickup.address, 200));
  }
  if (typeof b.filaments === "string") {
    const list = parseFilaments(b.filaments);
    if (list.length < 2) throw new HttpError(400, "Cadastre pelo menos 2 filamentos (um por linha: Nome #RRGGBB).");
    await saveSetting("filaments", list.map((f) => `${f.name} ${f.hex}`).join("\n"));
  }
  if (b.regions && typeof b.regions === "object") {
    await saveSetting("regions", JSON.stringify(parseRegions(JSON.stringify(b.regions))));
  }
  if (b.model && typeof b.model === "object") {
    const m = b.model;
    if (m.diameter !== undefined) await saveSetting("model_diameter", String(num(m.diameter, 70, 40, 120)));
    if (m.base !== undefined) await saveSetting("model_base", String(num(m.base, 3.2, 1.2, 5)));
    if (m.band !== undefined) await saveSetting("model_band", String(num(m.band, 0.4, 0.2, 1.2)));
  }
  if (b.package_cm && typeof b.package_cm === "object") {
    for (const k of ["length", "width", "height"]) {
      if (b.package_cm[k] !== undefined) await saveSetting("package_" + k, String(num(b.package_cm[k], 2, 1, 100)));
    }
  }
  if (typeof b.mp_access_token === "string" && b.mp_access_token.trim()) await saveSetting("mp_access_token", b.mp_access_token.trim());
  if (typeof b.openai_api_key === "string" && b.openai_api_key.trim()) await saveSetting("openai_api_key", b.openai_api_key.trim());
  if (typeof b.openai_image_model === "string" && b.openai_image_model.trim()) await saveSetting("openai_image_model", clean(b.openai_image_model, 60));
  if (typeof b.openai_image_quality === "string" && ["low", "medium", "high"].includes(b.openai_image_quality)) {
    await saveSetting("openai_image_quality", b.openai_image_quality);
  }
  if (typeof b.new_password === "string" && b.new_password) {
    if (b.new_password.length < 8) throw new HttpError(400, "A nova senha precisa ter pelo menos 8 caracteres.");
    await saveSetting("admin_password_hash", await sha256Hex("pn:" + b.new_password));
  }
  return json({ settings: settingsView(await loadSettings()) });
}

// ───────────────────────── roteador ─────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  try {
    const queryAction = url.searchParams.get("action");
    if (queryAction === "mp-webhook") return await mpWebhook(req, url);
    if (queryAction === "art") return await openArt(url);
    if (queryAction === "generate" && req.method === "POST") return await generate(req);
    if (req.method !== "POST") return json({ ok: true, service: "patinha-de-natal" });

    const body: Body = await req.json().catch(() => ({}));
    switch (body.action) {
      case "config": return await publicConfig();
      case "quote": return await quote(body);
      case "checkout": return await checkout(body);
      case "order": return await getOrder(body);
      case "recover": return await recover(body);
      case "choose": return await choose(body);
      case "item-kind": return await itemKind(body);
      case "confirm": return await confirm(body);
      case "admin-login": return json({ settings: settingsView(await requireAdmin(req)) });
      case "admin-orders": await requireAdmin(req); return await adminOrders(body);
      case "admin-update-order": await requireAdmin(req); return await adminUpdateOrder(body);
      case "admin-save-settings": await requireAdmin(req); return await adminSaveSettings(body);
      default: throw new HttpError(400, "Ação desconhecida.");
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error("erro inesperado", err);
    return json({ error: "Algo deu errado do nosso lado. Tente de novo em instantes." }, 500);
  }
});
