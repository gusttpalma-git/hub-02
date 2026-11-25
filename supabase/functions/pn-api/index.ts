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
import { PNG } from "npm:pngjs@7.0.0";
import { Buffer } from "node:buffer";

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
const SHIP_MODES = ["incluso", "gratis_ate", "tabela", "melhor_envio"];

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
    // Teste grátis: artes antes de pagar; limite por rede (24 h) e limite geral por dia.
    trialCredits: Math.min(5, Math.max(1, parseInt(s.trial_credits || "2", 10) || 2)),
    trialDailyCap: Math.max(0, parseInt(s.trial_daily_cap || "300", 10) || 0),
    trialIpLimit: Math.max(1, parseInt(s.trial_ip_limit || "6", 10) || 6),
    testMode: s.test_mode === "true",
    maxColors: Math.min(6, Math.max(2, parseInt(s.max_colors || "4", 10) || 4)),
    adminHash: s.admin_password_hash || "",
    filaments: parseFilaments(s.filaments),
    // Enfeite adicional: oferecido no fim da criação (depois de escolher a arte), preço único.
    // Preço de cada enfeite a mais: [2º, 3º, 4º] (escada de kits: 1 por 39,90 · 2 por 59,90 · 3 por 74,90…)
    extraPrices: (() => {
      const l = String(s.extra_prices_cents || s.extra_price_cents || "2000,1500,1500").split(",").map((v) => Math.max(0, parseInt(v, 10) || 0));
      while (l.length < 3) l.push(l[l.length - 1] ?? 0);
      return l.slice(0, 3);
    })(),
    get extraPrice() { return this.extraPrices[0]; },
    extraMax: Math.min(3, Math.max(0, parseInt(s.extra_max ?? "3", 10) || 0)),
    extraCredits: Math.min(10, Math.max(1, parseInt(s.extra_credits || "3", 10) || 3)),
    model: {
      diameter: num(s.model_diameter, 70, 40, 120),
      base: num(s.model_base, 3.2, 1.2, 5),
      band: num(s.model_band, 0.4, 0.2, 1.2),
    },
    shipping: {
      regions: parseRegions(s.regions),
      packageCm: { length: num(s.package_length, 16, 1, 100), width: num(s.package_width, 11, 1, 100), height: num(s.package_height, 2, 1, 100) },
      mode: SHIP_MODES.includes(s.shipping_mode) ? s.shipping_mode : "incluso",
      // "gratis_ate": a loja paga o frete até este valor; acima disso o cliente paga só a diferença.
      freeUpTo: Math.max(0, parseInt(s.free_shipping_up_to_cents || "2000", 10) || 0),
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
    // Venda de balcão (lojas parceiras): preço sem Correios, entrega em mãos na cidade e prazo de retirada.
    local: {
      priceCents: Math.max(100, parseInt(s.local_price_cents || "2990", 10) || 2990),
      extraPrices: (() => {
        const l = String(s.local_extra_prices_cents || "1500,1200,1200").split(",").map((v) => Math.max(0, parseInt(v, 10) || 0));
        while (l.length < 3) l.push(l[l.length - 1] ?? 0);
        return l.slice(0, 3);
      })(),
      ceps: String(s.local_ceps ?? "13150").split(/[\s,;]+/).map(digits).filter((v) => v.length >= 2 && v.length <= 8),
      deliveryCents: Math.max(0, parseInt(s.local_delivery_cents ?? "500", 10) || 0),
      readyDays: Math.min(30, Math.max(0, parseInt(s.pickup_days ?? "3", 10) || 0)),
    },
    ownerEmail: s.owner_email || "",
    ntfyTopic: (s.ntfy_topic || "").trim(),
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
      tiktok_pixel_id: s.tiktok_pixel_id || "",
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
  const ref = String(payment?.external_reference ?? "");
  if (ref.startsWith("up:")) return await applyUpsellPayment(payment, ref.slice(3));
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
    if (paid?.length) await onPaid(paid[0], cfg(await loadSettings()));
  } else if (["refunded", "charged_back"].includes(payment.status) && order.payment_status === "paid") {
    await db.from("pn_orders").update({ payment_status: "refunded" }).eq("id", orderId);
  }
}

// Depois que o pagamento entra. Teste grátis com arte escolhida e endereço já informados vai
// direto para a produção; senão o cliente termina no site (criar/escolher a arte, endereço).
// deno-lint-ignore no-explicit-any
async function onPaid(order: any, c: ReturnType<typeof cfg>) {
  let o = order;
  if (o.trial) {
    const { data: items } = await db.from("pn_order_items").select("kind, chosen_generation").eq("order_id", o.id);
    const ready = !!o.chosen_generation && !!o.lead_at && (items ?? []).every((it) => it.kind === "copia" || (it.kind === "novo" && it.chosen_generation));
    const patch: Record<string, unknown> = { credits_total: Math.max(o.credits_total, c.credits) };
    if (ready) patch.confirmed_at = new Date().toISOString();
    const { data } = await db.from("pn_orders").update(patch).eq("id", o.id).select("*").single();
    if (data) o = data;
  }
  const admin = o.site_url ? o.site_url + "admin.html" : undefined;
  const value = (o.amount_cents / 100).toFixed(2).replace(".", ",");
  const via = await updatePartnerCommission(o.id);
  const viaText = via ? ` · 🤝 ${via.name} (comissão R$ ${(via.cents / 100).toFixed(2).replace(".", ",")})` : "";
  if (o.confirmed_at) {
    await notify("confirmed", o, c);
    await pushOwner(c, `🎄 Pedido ${orderNo(o)} pago e pronto para produzir`, `${o.name} · R$ ${value}${o.extras ? ` · ${o.extras + 1} enfeites` : ""} · ${o.delivery_method === "retirada" ? "retirada" : o.city + "/" + o.state}${viaText}`, admin);
  } else {
    await notify("paid", o, c);
    await pushOwner(c, `💰 Novo pedido pago ${orderNo(o)}`, `${o.name} · R$ ${value} — falta o cliente terminar a arte (${o.code})${viaText}`, admin);
  }
}

// ───────────────────────── aviso no celular (app ntfy) ─────────────────────────

// deno-lint-ignore no-explicit-any
const orderNo = (o: any) => (o?.order_no ? "#" + String(o.order_no).padStart(3, "0") : o?.is_test ? "teste" : o?.code || "");

// Notificação no celular do dono: app gratuito "ntfy", inscrito no tópico secreto do painel.
async function pushOwner(c: ReturnType<typeof cfg>, title: string, message: string, click?: string) {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(c.ntfyTopic)) return;
  try {
    await fetch(`https://ntfy.sh/${c.ntfyTopic}`, {
      method: "POST",
      headers: {
        // cabeçalhos HTTP só aceitam ASCII: o título vai codificado (RFC 2047)
        Title: `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(title)))}?=`,
        Tags: "christmas_tree",
        ...(click ? { Click: click } : {}),
      },
      body: message,
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.error("aviso no celular falhou", err);
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
      "Agora é só terminar no site: criar ou escolher a arte do seu pet e conferir a entrega.",
      "Guarde este e-mail: o botão abaixo abre o seu pedido em qualquer aparelho.",
    ], button));
  } else if (event === "confirmed") {
    const pickup = order.delivery_method === "retirada";
    const address = pickup ? `Retirada em ${order.pickup_label ? esc(order.pickup_label) : esc(c.pickup.name) + "<br>" + esc(c.pickup.address)}` : `${esc(order.street)}, ${esc(order.number)}${order.complement ? " — " + esc(order.complement) : ""}<br>${esc(order.district)} · ${esc(order.city)}/${esc(order.state)} · CEP ${esc(order.cep)}`;
    await sendMail(c.mail, order.email, `Pedido ${order.code} confirmado`, mailLayout(c.mail.brand, "Seu enfeite vai para a produção 🐾", [
      `Olá, ${first}! Recebemos a arte escolhida e o endereço.`,
      `<strong>Entrega para:</strong><br>${esc(order.recipient)}<br>${address}`,
      pickup ? "Avisamos por e-mail e WhatsApp quando estiver pronto para retirar." : "Assim que o pacote for postado, você recebe o código de rastreio por e-mail.",
    ], button));
    if (c.ownerEmail) {
      await sendMail(c.mail, c.ownerEmail, `Pedido ${orderNo(order)} pronto para produzir (${order.code})`, mailLayout(c.mail.brand, `Pedido ${esc(orderNo(order))} pronto para produzir`, [
        `<strong>Código:</strong> ${esc(order.code)}`,
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
      `<strong>Onde retirar:</strong> ${order.pickup_label ? esc(order.pickup_label) : esc(c.pickup.name) + "<br>" + esc(c.pickup.address)}`,
      "Leve o código do pedido: " + esc(order.code) + ".",
    ], button));
  } else {
    await sendMail(c.mail, order.email, `Seu enfeite foi enviado — pedido ${order.code}`, mailLayout(c.mail.brand, "Seu enfeite está a caminho! 📦", [
      `Olá, ${first}! Postamos o seu pedido.`,
      order.tracking_code ? `<strong>Código de rastreio:</strong> ${esc(order.tracking_code)}` : "Em breve o código de rastreio aparece na página do pedido.",
    ], button));
  }
}

// Pagamento de enfeites adicionais (comprados depois, no fim da criação).
// deno-lint-ignore no-explicit-any
async function applyUpsellPayment(payment: any, upsellId: string) {
  if (!isUuid(upsellId) || payment.status !== "approved") return;
  const { data: up } = await db.from("pn_upsells").select("id, amount_cents, status").eq("id", upsellId).maybeSingle();
  if (!up || up.status !== "pending") return;
  const paidCents = Math.round(Number(payment.transaction_amount) * 100);
  if (payment.currency_id !== "BRL" || paidCents < up.amount_cents) {
    console.error("adicional com valor divergente", upsellId, paidCents, up.amount_cents);
    return;
  }
  const c = cfg(await loadSettings());
  const { data: ok } = await db.rpc("pn_apply_upsell", { p_upsell: upsellId, p_payment: String(payment.id), p_credits: c.extraCredits });
  if (ok) {
    const { data: upOrder } = await db.from("pn_upsells").select("order_id").eq("id", upsellId).maybeSingle();
    if (upOrder?.order_id) await updatePartnerCommission(upOrder.order_id);
    const { data: o } = await db.from("pn_upsells").select("pn_orders(code, order_no, is_test, name, site_url)").eq("id", upsellId).maybeSingle();
    // deno-lint-ignore no-explicit-any
    const ord: any = (o as any)?.pn_orders;
    if (ord) await pushOwner(c, `🎁 2º enfeite no pedido ${orderNo(ord)}`, `${ord.name} adicionou mais um enfeite (${ord.code})`, ord.site_url ? ord.site_url + "admin.html" : undefined);
  }
}

async function syncUpsells(token: string, orderId: string) {
  const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const { data } = await db.from("pn_upsells").select("id").eq("order_id", orderId).eq("status", "pending").gt("created_at", since);
  for (const up of data ?? []) {
    const found = await mp(token, `/v1/payments/search?external_reference=up:${up.id}&sort=date_created&criteria=desc&limit=5`);
    // deno-lint-ignore no-explicit-any
    const approved = (found.results ?? []).find((p: any) => p.status === "approved");
    if (approved) await applyUpsellPayment(approved, up.id);
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
    .select("id, status, item, result_path, preview_path, created_at").eq("order_id", o.id).order("created_at");
  const { data: items } = await db.from("pn_order_items")
    .select("position, kind, credits_total, credits_used, chosen_generation, pet_name").eq("order_id", o.id).order("position");
  // Teste grátis: a arte só aparece depois que o cliente informa os dados.
  const hidden = o.trial && !o.lead_at;
  // O cliente vê só a prévia (menor); a arte original fica para a produção (painel).
  const shown = (g: { result_path: string | null; preview_path: string | null }) => g.preview_path || g.result_path || "";
  const urls = hidden ? {} : await signedUrls((gens ?? []).map(shown));
  const c = cfg(await loadSettings());
  const partner = o.partner_id ? await partnerById(o.partner_id) : null;
  const local = isLocalDeal(c, o, partner);
  const pl = priceList(c, local);
  const { count: upPending } = await db.from("pn_upsells").select("id", { count: "exact", head: true })
    .eq("order_id", o.id).eq("status", "pending").gt("created_at", new Date(Date.now() - 2 * 3600 * 1000).toISOString());
  return {
    extras: o.extras,
    upsell: {
      price_cents: pl.extras[Math.min(2, o.extras ?? 0)],
      prices: pl.extras.slice(o.extras ?? 0, c.extraMax),
      main_cents: pl.price,
      max: Math.max(0, c.extraMax - (o.extras ?? 0)),
      pending: (upPending ?? 0) > 0,
    },
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
      url: g.result_path ? urls[shown(g)] ?? null : null,
      // link curto e permanente da arte, para o cliente mandar no WhatsApp
      share_url: g.result_path && !hidden ? `${FUNCTION_URL}?action=art&g=${g.id}` : null,
    })),
    trial: !!o.trial,
    lead: !!o.lead_at,
    contact: o.lead_at ? { name: o.name, email: o.email, whatsapp: o.whatsapp } : null,
    address_set: o.delivery_method === "retirada" || !!o.cep,
    price_cents: pl.price,
    extra_prices: c.extraMax > 0 ? pl.extras.slice(0, c.extraMax) : [],
    // loja parceira: ponto de retirada e preço de balcão (sem Correios)
    partner: partner ? { name: partner.name } : null,
    pickup: pickupFor(c, partner),
    pickup_label: o.pickup_label,
    local_deal: local,
    balcao: partner ? {
      price_cents: c.local.priceCents, extra_prices: c.extraMax > 0 ? c.local.extraPrices.slice(0, c.extraMax) : [],
      normal_price_cents: c.priceCents, delivery_cents: c.local.deliveryCents, ready_days: c.local.readyDays,
      local_cep: !!o.cep && isLocalCep(c, o.cep),
    } : null,
    // artes que o cliente ganha ao pagar (além das que já usou no teste)
    paid_credits: o.payment_status === "pending" ? Math.max(0, c.credits - o.credits_total) : 0,
    chosen_generation: o.chosen_generation,
    customer_notes: o.customer_notes,
    confirmed: !!o.confirmed_at,
    production_status: o.production_status,
    tracking_code: o.tracking_code,
    pet_name: o.pet_name,
    amount_cents: o.amount_cents,
    shipping_cents: o.shipping_cents,
    locked_cep: o.shipping_cents > 0 ? o.cep : null,
    checkout_cep: o.cep,
    // pagamento ainda não feito: reabre o mesmo pagamento (sem criar outro pedido)
    pay_url: o.payment_status === "pending" && o.mp_preference_id
      ? `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=${encodeURIComponent(o.mp_preference_id)}` : null,
    delivery_method: o.delivery_method,
    address: o.confirmed_at || o.lead_at
      ? { recipient: o.recipient, cep: o.cep, street: o.street, number: o.number, complement: o.complement, district: o.district, city: o.city, state: o.state }
      : null,
  };
}

// ───────────────────────── geração da arte ─────────────────────────

// Prévia menor (≈512 px) da arte: é o que o cliente vê no site. A original fica para a produção.
function previewPng(png: Uint8Array): Uint8Array {
  const src = PNG.sync.read(Buffer.from(png));
  const f = Math.max(1, Math.round(src.width / 512));
  const w = Math.floor(src.width / f), h = Math.floor(src.height / f);
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y * f) * src.width + x * f) * 4, di = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out.data[di + k] = src.data[si + k];
    }
  }
  return new Uint8Array(PNG.sync.write(out));
}

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
    let previewPath: string | null = null;
    if (ext === "png") {
      try {
        const pv = `${orderId}/${genId}-previa.png`;
        const r = await db.storage.from(BUCKET).upload(pv, previewPng(bytes), { contentType: "image/png", upsert: true });
        if (!r.error) previewPath = pv;
      } catch (err) {
        console.error("prévia não gerada", err);
      }
    }

    await db.from("pn_generations")
      .update({ status: "done", result_path: path, preview_path: previewPath, finished_at: new Date().toISOString() })
      .eq("id", genId).eq("status", "processing");

    // Teste grátis: a primeira arte pronta vai por e-mail, para o cliente voltar e comprar depois.
    const { data: ord } = await db.from("pn_orders").select("trial, payment_status, email, name, site_url, token").eq("id", orderId).maybeSingle();
    if (ord?.trial && ord.payment_status === "pending" && ord.email && c.mail.apiKey && c.mail.from) {
      const { count } = await db.from("pn_generations").select("id", { count: "exact", head: true }).eq("order_id", orderId).eq("status", "done");
      if (count === 1) {
        const link = ord.site_url ? `${ord.site_url}criar.html?t=${ord.token}` : "";
        await sendMail(c.mail, ord.email, "A arte do seu pet ficou pronta 🐾", mailLayout(c.mail.brand, "A arte do seu pet ficou pronta 🎄", [
          `Olá, ${esc(String(ord.name || "").split(" ")[0])}! Desenhamos o seu pet e guardamos a arte para você.`,
          "Toque no botão para ver o enfeite em 3D, criar outra versão ou fazer o pedido quando quiser.",
        ], link ? { text: "Ver o enfeite do meu pet", url: link } : undefined));
      }
    }
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
    trial_credits: c.trialCredits,
    shipping_mode: c.shipping.mode === "incluso" || c.shipping.mode === "gratis_ate" ? c.shipping.mode : "calculado",
    free_shipping_up_to_cents: c.shipping.mode === "gratis_ate" ? c.shipping.freeUpTo : null,
    store: c.store,
    pickup: c.pickup.enabled ? { name: c.pickup.name, address: c.pickup.address } : null,
    extra_price_cents: c.extraMax > 0 ? c.extraPrice : 0,
    extra_prices: c.extraMax > 0 ? c.extraPrices.slice(0, c.extraMax) : [],
    extra_max: c.extraPrice > 0 ? c.extraMax : 0,
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
  const { data: gen } = await db.from("pn_generations").select("result_path, preview_path").eq("id", id).eq("status", "done").maybeSingle();
  if (!gen?.result_path) throw new HttpError(404, "Arte não encontrada.");
  const { data } = await db.storage.from(BUCKET).createSignedUrl(gen.preview_path || gen.result_path, 60 * 60);
  if (!data?.signedUrl) throw new HttpError(404, "Arte não encontrada.");
  return new Response(null, { status: 302, headers: { ...CORS, Location: data.signedUrl, "Cache-Control": "no-store" } });
}

// Soma do preço de `n` enfeites a mais a partir da posição `from` (0 = o 2º enfeite do pedido).
function extrasCents(c: ReturnType<typeof cfg>, from: number, n: number) {
  return c.extraPrices.slice(from, from + n).reduce((a, b) => a + b, 0);
}

// Quantos enfeites a mais já na compra (0 ou até extra_max), pela escada de preços.
function extrasOf(c: ReturnType<typeof cfg>, v: unknown) {
  const n = c.extraPrice > 0 ? Math.max(0, Math.min(c.extraMax, parseInt(String(v ?? 0), 10) || 0)) : 0;
  return { n, cents: extrasCents(c, 0, n) };
}

// Pacote um pouco mais pesado quando vão mais peças (≈ 20 g cada).
function shippingFor(c: ReturnType<typeof cfg>, extras: number) {
  return { ...c.shipping, weightGrams: c.shipping.weightGrams + extras * 20 };
}

// Quanto o cliente paga de frete. No modo "gratis_ate" cota o frete real (Melhor Envio; se falhar,
// a tabela por região) e a loja paga até o limite: o cliente só paga o que passar disso.
async function shippingCharge(c: ReturnType<typeof cfg>, cep: string, extras = 0) {
  const s = shippingFor(c, extras);
  if (s.mode === "incluso") return { cents: 0, cost: null as number | null, label: "Frete grátis", days: null as number | null };
  if (s.mode === "gratis_ate") {
    let q = { cents: 0, label: "", days: null as number | null };
    try {
      q = await quoteShipping({ ...s, mode: "melhor_envio" }, cep);
    } catch (err) {
      console.error("sem cotação de frete; frete grátis", err);
    }
    const charge = Math.max(0, q.cents - s.freeUpTo);
    // O rótulo guarda o serviço cotado: é a etiqueta que a loja compra no Melhor Envio.
    const label = q.label ? q.label + (q.days ? ` · ${q.days} dias úteis` : "") : "Frete";
    return { cents: charge, cost: q.cents || null, label, days: q.days };
  }
  const q = await quoteShipping(s, cep);
  return { cents: q.cents, cost: q.cents, label: q.label, days: q.days };
}

async function quote(b: Body) {
  const c = cfg(await loadSettings());
  const cep = digits(b.cep);
  if (cep.length !== 8) throw new HttpError(400, "Confira o CEP (8 números).");
  if (b.token && isLocalCep(c, cep)) {
    const order = await getOrderByToken(b.token).catch(() => null);
    if (order?.partner_id) {
      return json({ shipping_cents: c.local.deliveryCents, label: "Entrega em mãos", days: null, local: true });
    }
  }
  try {
    checkRegion(c.shipping, cep);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  try {
    const ex = extrasOf(c, b.extras);
    const q = await shippingCharge(c, cep, ex.n);
    return json({
      shipping_cents: q.cents, label: q.label, days: q.days, price_cents: c.priceCents, extras_cents: ex.cents,
      total_cents: c.priceCents + ex.cents + q.cents,
      free_up_to_cents: c.shipping.mode === "gratis_ate" ? c.shipping.freeUpTo : null,
    });
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
  let shipping: { cents: number; cost: number | null; label: string } = { cents: 0, cost: null, label: pickup ? "Retirada: " + c.pickup.name : "Frete grátis" };
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
      shipping = await shippingCharge(c, cep, ex.n);
    } catch (_) {
      throw new HttpError(400, "Não encontramos esse CEP. Confira os números.");
    }
  }
  const totalCents = c.priceCents + ex.cents + shipping.cents;

  const token = randomHex(24);
  const partnerId = await partnerIdOf(b.partner);
  const { data: order, error } = await db.from("pn_orders").insert({
    code: orderCode(),
    ...(partnerId ? { partner_id: partnerId } : {}),
    token,
    name,
    email,
    whatsapp,
    amount_cents: totalCents,
    shipping_cents: shipping.cents,
    shipping_label: shipping.label,
    shipping_cost_cents: shipping.cost,
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
        }, ...c.extraPrices.slice(0, ex.n).map((cents, i) => ({
          id: "enfeite-adicional-" + (i + 2),
          title: `${i + 2}º enfeite`,
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
  // Só consulta o Mercado Pago se o pagamento já foi aberto (teste grátis ainda não tem).
  if (order.payment_status === "pending" && !order.is_test && order.mp_preference_id) {
    const c = cfg(await loadSettings());
    if (c.mpToken) {
      try {
        await syncOrderPayment(c.mpToken, order.id);
        order = await getOrderByToken(b.token);
      } catch (_) { /* segue como pendente; o webhook ou a próxima consulta resolvem */ }
    }
  } else if (order.payment_status === "paid" && !order.is_test) {
    const c = cfg(await loadSettings());
    if (c.mpToken) {
      try { await syncUpsells(c.mpToken, order.id); } catch (_) { /* o webhook resolve */ }
    }
  }
  return json({ order: await orderView(order) });
}

async function recover(b: Body) {
  await sleep(600);
  const email = clean(b.email, 160).toLowerCase();
  const whatsapp = normalizePhone(b.whatsapp);
  if (!email || whatsapp.length < 10) throw new HttpError(400, "Preencha o e-mail e o WhatsApp usados na compra.");
  // Primeiro o pedido pago mais recente; senão o teste grátis mais recente com esses dados.
  const { data } = await db.from("pn_orders").select("token, payment_status")
    .eq("email", email).eq("whatsapp", whatsapp).in("payment_status", ["paid", "pending"])
    .order("created_at", { ascending: false }).limit(20);
  const found = (data ?? []).find((o) => o.payment_status === "paid") ?? (data ?? [])[0];
  if (!found) throw new HttpError(404, "Não encontramos um pedido com esses dados.");
  return json({ token: found.token });
}

async function generate(req: Request) {
  const form = await req.formData();
  const order = await getOrderByToken(form.get("token"));
  const trial = order.trial && order.payment_status === "pending";
  if (!trial && order.payment_status !== "paid") throw new HttpError(402, "O pagamento ainda não foi confirmado.");
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
  if (trial) {
    if (item !== 0) throw new HttpError(400, "Esse enfeite não faz parte do pedido.");
    if (order.credits_used >= order.credits_total) throw new HttpError(409, "Seus testes grátis acabaram. Faça o pedido para criar mais artes.");
    if (order.credits_used > 0 && !order.lead_at) throw new HttpError(400, "Preencha seus dados para ver a arte e criar outra versão.");
    if (c.trialDailyCap > 0) {
      const { count } = await db.from("pn_generations").select("id", { count: "exact", head: true })
        .eq("free", true).gt("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
      if ((count ?? 0) >= c.trialDailyCap) throw new HttpError(429, "Os testes grátis de hoje esgotaram. Faça o pedido e crie a arte logo depois do pagamento, ou volte amanhã.");
    }
  }
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

// ───────────────────────── teste grátis ─────────────────────────

// Rede de quem acessa, guardada só como resumo (hash), para limitar abusos do teste grátis.
async function clientKey(req: Request): Promise<string | null> {
  const ip = (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return ip ? (await sha256Hex("pn-ip:" + ip)).slice(0, 32) : null;
}

// Nome, e-mail e WhatsApp do cliente (conferidos).
function contactOf(b: Body) {
  const name = clean(b.name, 120);
  const email = clean(b.email, 160).toLowerCase();
  const whatsapp = normalizePhone(b.whatsapp);
  if (name.length < 2) throw new HttpError(400, "Digite seu nome.");
  if (whatsapp.length < 10 || whatsapp.length > 11) throw new HttpError(400, "Confira seu WhatsApp com DDD.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, "Confira seu e-mail.");
  return { name, email, whatsapp };
}

// Começa um teste grátis: cria o pedido (com nome, e-mail e WhatsApp, se vierem) e devolve o token.
async function trialStart(req: Request, b: Body) {
  const c = cfg(await loadSettings());
  let site: URL;
  try {
    site = new URL(String(b.site_url));
    if (!/^https?:$/.test(site.protocol)) throw new Error();
  } catch {
    throw new HttpError(400, "Endereço do site inválido.");
  }
  const base = site.origin + site.pathname.replace(/[^/]*$/, "");
  const contact = b.name || b.email || b.whatsapp ? contactOf(b) : null;
  const ip = await clientKey(req);
  if (ip) {
    const { count } = await db.from("pn_orders").select("id", { count: "exact", head: true })
      .eq("trial", true).eq("client_ip", ip).gt("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    if ((count ?? 0) >= c.trialIpLimit) {
      throw new HttpError(429, "Você já fez vários testes hoje. Para criar mais artes, faça o pedido ou fale com a gente no WhatsApp.");
    }
  }
  const token = randomHex(24);
  const partnerId = await partnerIdOf(b.partner);
  const { error } = await db.from("pn_orders").insert({
    code: orderCode(),
    token,
    trial: true,
    ...(partnerId ? { partner_id: partnerId } : {}),
    client_ip: ip,
    amount_cents: 0,
    site_url: base,
    credits_total: c.trialCredits,
    is_test: c.testMode,
    ...(contact ? { ...contact, recipient: contact.name, lead_at: new Date().toISOString() } : {}),
  });
  if (error) throw new HttpError(500, "Não foi possível começar o teste. Tente de novo.");
  return json({ token });
}

// Dados do cliente e da entrega. step "contact": só nome/e-mail/WhatsApp; "address": só a entrega
// (preenchida enquanto a arte é desenhada); sem step: os dois.
async function lead(b: Body) {
  const order = await getOrderByToken(b.token);
  if (order.confirmed_at || order.payment_status === "refunded") throw new HttpError(409, "Este pedido já foi finalizado.");
  const step = b.step === "contact" || b.step === "address" ? b.step : "all";
  const c = cfg(await loadSettings());
  const contact = step === "address" ? null : contactOf(b);
  if (step === "address" && !order.lead_at) throw new HttpError(400, "Preencha seu nome, e-mail e WhatsApp primeiro.");
  // deno-lint-ignore no-explicit-any
  const patch: Record<string, any> = { lead_at: order.lead_at ?? new Date().toISOString() };
  if (contact) Object.assign(patch, contact, { recipient: contact.name });
  if (step !== "contact") {
    const pickup = b.delivery === "retirada";
    if (pickup && !pickupFor(c, order.partner_id ? await partnerById(order.partner_id) : null)) throw new HttpError(400, "A retirada não está disponível no momento.");
    if (order.payment_status === "paid" && order.shipping_cents > 0 && !pickup && digits(b.cep) !== order.cep) {
      throw new HttpError(400, "O frete já foi pago para outro CEP. Fale com a gente pelo WhatsApp para mudar.");
    }
    const a = {
      cep: pickup ? null : digits(b.cep),
      street: pickup ? null : clean(b.street, 160),
      number: pickup ? null : clean(b.number, 20),
      complement: pickup ? null : clean(b.complement, 80) || null,
      district: pickup ? null : clean(b.district, 100),
      city: pickup ? null : clean(b.city, 100),
      state: pickup ? null : clean(b.state, 2).toUpperCase(),
    };
    if (!pickup) {
      if ((a.cep ?? "").length !== 8) throw new HttpError(400, "Confira o CEP (8 números).");
      if (!a.street) throw new HttpError(400, "Digite o nome da rua.");
      if (!a.number) throw new HttpError(400, "Digite o número (ou S/N).");
      if (!a.district) throw new HttpError(400, "Digite o bairro.");
      if (!a.city) throw new HttpError(400, "Digite a cidade.");
      if (!/^[A-Z]{2}$/.test(a.state ?? "")) throw new HttpError(400, "Escolha o estado.");
      try {
        checkRegion(c.shipping, a.cep as string, order.payment_status !== "paid");
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }
    Object.assign(patch, a, { delivery_method: pickup ? "retirada" : "correios" });
    if (!contact) patch.recipient = order.recipient || order.name;
  }
  const { data: saved, error } = await db.from("pn_orders").update(patch).eq("id", order.id).select("*").single();
  if (error || !saved) throw new HttpError(500, "Não foi possível salvar. Tente de novo.");
  return json({ order: await orderView(saved) });
}

// Pagamento do teste grátis: quantidade, nomes e frete; abre o Mercado Pago no mesmo pedido.
async function pay(b: Body) {
  const order = await getOrderByToken(b.token);
  if (order.payment_status === "paid") return json({ order: await orderView(order) });
  if (order.payment_status !== "pending" || !order.trial) throw new HttpError(409, "Este pedido não pode ser pago aqui.");
  if (!order.lead_at) throw new HttpError(400, "Preencha seus dados de entrega antes de pagar.");
  if (order.delivery_method !== "retirada" && !order.cep) throw new HttpError(400, "Falta o endereço de entrega.");
  const c = cfg(await loadSettings());
  if (!order.is_test && !c.mpToken) throw new HttpError(503, "As vendas ainda não foram abertas. Volte em breve!");
  const partner = order.partner_id ? await partnerById(order.partner_id) : null;
  const local = isLocalDeal(c, order, partner);
  const pl = priceList(c, local);
  const exN = pl.extras[0] > 0 ? Math.max(0, Math.min(c.extraMax, parseInt(String(b.extras ?? 0), 10) || 0)) : 0;
  const ex = { n: exN, cents: pl.extras.slice(0, exN).reduce((a, v) => a + v, 0) };
  const kind = b.kind === "novo" ? "novo" : "copia";
  // "escolher depois": paga sem arte definida e ganha mais artes para criar depois do pagamento
  const later = b.choose_later === true || !order.chosen_generation;
  const pickup = order.delivery_method === "retirada";
  const point = pickup ? pickupFor(c, partner) : null;
  if (pickup && !point) throw new HttpError(400, "A retirada não está disponível no momento.");
  let shipping: { cents: number; cost: number | null; label: string } = { cents: 0, cost: null, label: point ? "Retirada: " + point.name : "Frete grátis" };
  if (!pickup) {
    try {
      checkRegion(c.shipping, order.cep);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    if (partner && isLocalCep(c, order.cep)) {
      // cliente da loja parceira na cidade: o dono entrega em mãos
      shipping = { cents: c.local.deliveryCents, cost: null, label: `Entrega em mãos${order.city ? " — " + order.city : ""}` };
    } else if (c.shipping.mode !== "incluso") {
      try {
        shipping = await shippingCharge(c, order.cep, ex.n);
      } catch (_) {
        throw new HttpError(400, "Não conseguimos calcular o frete para o seu CEP. Confira o endereço.");
      }
    }
  }
  const total = pl.price + ex.cents + shipping.cents;
  const names: unknown[] = Array.isArray(b.pet_names) ? b.pet_names : [];

  await db.from("pn_order_items").delete().eq("order_id", order.id);
  if (ex.n) {
    const rows = Array.from({ length: ex.n }, (_, i) => ({
      order_id: order.id, position: i + 1, credits_total: c.extraCredits, kind,
      pet_name: kind === "copia" ? clean(names[i + 1], 20) || null : null,
    }));
    const { error } = await db.from("pn_order_items").insert(rows);
    if (error) throw new HttpError(500, "Não foi possível montar o pedido. Tente de novo.");
  }
  const { data: o, error } = await db.from("pn_orders").update({
    amount_cents: total, extras: ex.n, extras_cents: ex.cents,
    shipping_cents: shipping.cents, shipping_label: shipping.label, shipping_cost_cents: shipping.cost,
    pet_name: clean(names[0] ?? b.pet_name, 20) || null,
    customer_notes: clean(b.customer_notes, 500) || null,
    local_deal: local,
    pickup_label: point ? point.name + " — " + point.address + (point.hours ? " (" + point.hours + ")" : "") : null,
    ...(later ? { chosen_generation: null } : {}),
  }).eq("id", order.id).select("*").single();
  if (error || !o) throw new HttpError(500, "Não foi possível montar o pedido. Tente de novo.");

  const studio = `${o.site_url}criar.html?t=${o.token}`;
  if (o.is_test) {
    const { data: paid } = await db.from("pn_orders").update({ payment_status: "paid", paid_at: new Date().toISOString() })
      .eq("id", o.id).eq("payment_status", "pending").select("*");
    if (paid?.length) await onPaid(paid[0], c);
    return json({ order: await orderView(await getOrderByToken(b.token)) });
  }
  const site = new URL(o.site_url);
  const pref = await mp(c.mpToken, "/checkout/preferences", {
    method: "POST",
    body: JSON.stringify({
      items: [{
        id: "enfeite-pet",
        title: "Enfeite de Natal personalizado do seu pet",
        description: `Pedido ${o.code}`,
        quantity: 1,
        currency_id: "BRL",
        unit_price: pl.price / 100,
      }, ...pl.extras.slice(0, ex.n).map((cents, i) => ({
        id: "enfeite-adicional-" + (i + 2),
        title: `${i + 2}º enfeite` + (kind === "copia" ? " (igual)" : " (outro pet)"),
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
      payer: { name: o.name, email: o.email },
      external_reference: o.id,
      back_urls: { success: studio + "&pago=1", pending: studio + "&pago=1", failure: studio + "&pagamento=falhou" },
      ...(site.protocol === "https:" ? { auto_return: "approved" } : {}),
      notification_url: `${FUNCTION_URL}?action=mp-webhook`,
      statement_descriptor: "PATINHA NATAL",
      payment_methods: { excluded_payment_types: [{ id: "ticket" }], installments: 3 },
    }),
  });
  await db.from("pn_orders").update({ mp_preference_id: pref.id }).eq("id", o.id);
  return json({ redirect: pref.init_point });
}

async function choose(b: Body) {
  const order = await getOrderByToken(b.token);
  if (order.payment_status !== "paid" && !(order.trial && order.payment_status === "pending")) throw new HttpError(402, "O pagamento ainda não foi confirmado.");
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

// Upsell no fim da criação: mais enfeites (outro pet ou mais um igual) no mesmo pacote.
async function addExtras(b: Body) {
  const order = await getOrderByToken(b.token);
  if (order.payment_status !== "paid") throw new HttpError(402, "O pagamento ainda não foi confirmado.");
  if (order.confirmed_at || order.production_status !== "aguardando") throw new HttpError(409, "Este pedido já foi finalizado. Fale com a gente pelo WhatsApp.");
  const c = cfg(await loadSettings());
  const list = order.local_deal ? c.local.extraPrices : c.extraPrices;
  const room = list[0] > 0 ? c.extraMax - (order.extras ?? 0) : 0;
  const qty = parseInt(String(b.qty ?? 1), 10) || 0;
  if (room <= 0) throw new HttpError(400, "Este pedido já tem o máximo de enfeites.");
  if (!(qty >= 1 && qty <= room)) throw new HttpError(400, `Escolha de 1 a ${room} enfeite(s).`);
  const amount = list.slice(order.extras ?? 0, (order.extras ?? 0) + qty).reduce((a, v) => a + v, 0);
  const kind = ["novo", "copia"].includes(b.kind) ? b.kind : null;

  const { data: up, error } = await db.from("pn_upsells").insert({ order_id: order.id, qty, amount_cents: amount, kind }).select("id").single();
  if (error || !up) throw new HttpError(500, "Não foi possível adicionar. Tente de novo.");

  if (order.is_test) {
    await db.rpc("pn_apply_upsell", { p_upsell: up.id, p_payment: "teste", p_credits: c.extraCredits });
    return json({ order: await orderView(await getOrderByToken(b.token)) });
  }
  if (!c.mpToken) throw new HttpError(503, "Pagamento indisponível no momento.");
  const studio = `${order.site_url}criar.html?t=${order.token}&mais=1`;
  const site = new URL(order.site_url);
  try {
    const pref = await mp(c.mpToken, "/checkout/preferences", {
      method: "POST",
      body: JSON.stringify({
        items: [{
          id: "enfeite-adicional",
          title: (qty === 1 ? "Enfeite a mais" : `${qty} enfeites a mais`) + (kind === "copia" ? " (igual ao primeiro)" : kind === "novo" ? " (outro pet)" : ""),
          description: `Pedido ${order.code}`,
          quantity: 1,
          currency_id: "BRL",
          unit_price: amount / 100,
        }],
        payer: { name: order.name, email: order.email },
        external_reference: "up:" + up.id,
        back_urls: { success: studio, pending: studio, failure: studio },
        ...(site.protocol === "https:" ? { auto_return: "approved" } : {}),
        notification_url: `${FUNCTION_URL}?action=mp-webhook`,
        statement_descriptor: "PATINHA NATAL",
        payment_methods: { excluded_payment_types: [{ id: "ticket" }], installments: 1 },
      }),
    });
    await db.from("pn_upsells").update({ mp_preference_id: pref.id }).eq("id", up.id);
    return json({ redirect: pref.init_point });
  } catch (err) {
    await db.from("pn_upsells").delete().eq("id", up.id);
    throw err;
  }
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
  if (!order.confirmed_at) {
    const c = cfg(await loadSettings());
    await notify("confirmed", saved, c);
    await pushOwner(c, `🎄 Pedido ${orderNo(saved)} pronto para produzir`, `${saved.name}${saved.pet_name ? " · " + saved.pet_name : ""}${saved.extras ? ` · ${saved.extras + 1} enfeites` : ""} · ${saved.delivery_method === "retirada" ? "retirada" : saved.city + "/" + saved.state}`, saved.site_url ? saved.site_url + "admin.html" : undefined);
  }
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
    trial_credits: c.trialCredits,
    trial_daily_cap: c.trialDailyCap,
    trial_ip_limit: c.trialIpLimit,
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
    extra_prices_cents: c.extraPrices,
    extra_max: c.extraMax,
    extra_credits: c.extraCredits,
    free_shipping_up_to_cents: c.shipping.freeUpTo,
    ntfy_topic: c.ntfyTopic,
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
  // testes grátis só aparecem depois que o cliente deixa os dados (viram "leads")
  else q = q.or("trial.eq.false,lead_at.not.is.null,payment_status.neq.pending");
  const { data: orders, error } = await q;
  if (error) throw new HttpError(500, "Erro ao carregar pedidos.");

  const ids = (orders ?? []).map((o) => o.id);
  const { data: gens } = ids.length
    ? await db.from("pn_generations").select("id, order_id, status, species, item, source_path, result_path, created_at").in("order_id", ids).order("created_at")
    : { data: [] };
  const urls = await signedUrls((gens ?? []).flatMap((g) => [g.source_path, g.result_path]));
  const { data: partners } = await db.from("pn_partners").select("id, name");
  const partnerName = Object.fromEntries((partners ?? []).map((p) => [p.id, p.name]));
  const { data: allItems } = ids.length
    ? await db.from("pn_order_items").select("order_id, position, kind, chosen_generation, pet_name").in("order_id", ids).order("position")
    : { data: [] };

  return json({
    orders: (orders ?? []).map((o) => ({
      id: o.id, code: o.code, order_no: o.order_no ?? null, trial: !!o.trial, lead_at: o.lead_at, created_at: o.created_at, paid_at: o.paid_at, confirmed_at: o.confirmed_at,
      name: o.name, email: o.email, whatsapp: o.whatsapp, amount_cents: o.amount_cents,
      shipping_cents: o.shipping_cents, shipping_label: o.shipping_label, shipping_cost_cents: o.shipping_cost_cents, delivery_method: o.delivery_method,
      payment_status: o.payment_status, is_test: o.is_test, mp_payment_id: o.mp_payment_id,
      credits_total: o.credits_total, credits_used: o.credits_used,
      pet_name: o.pet_name, recipient: o.recipient, cep: o.cep, street: o.street, number: o.number,
      complement: o.complement, district: o.district, city: o.city, state: o.state,
      production_status: o.production_status, tracking_code: o.tracking_code, admin_notes: o.admin_notes,
      customer_notes: o.customer_notes,
      chosen_generation: o.chosen_generation,
      extras: o.extras, extras_cents: o.extras_cents,
      partner: o.partner_id ? partnerName[o.partner_id] ?? "loja parceira" : null,
      partner_commission_cents: o.partner_commission_cents ?? null,
      pickup_label: o.pickup_label ?? null, local_deal: !!o.local_deal,
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
  for (const [k, min, max, label] of [["trial_credits", 1, 5, "Artes grátis no teste: de 1 a 5."], ["trial_daily_cap", 0, 100000, "Limite diário de testes inválido."], ["trial_ip_limit", 1, 100, "Limite por rede: de 1 a 100."]] as const) {
    if (b[k] === undefined) continue;
    const v = parseInt(b[k], 10);
    if (!(v >= min && v <= max)) throw new HttpError(400, label);
    await saveSetting(k, String(v));
  }
  if (b.max_colors !== undefined) {
    const v = parseInt(b.max_colors, 10);
    if (!(v >= 2 && v <= 6)) throw new HttpError(400, "Número de cores inválido (2 a 6).");
    await saveSetting("max_colors", String(v));
  }
  if (b.test_mode !== undefined) await saveSetting("test_mode", b.test_mode ? "true" : "false");
  if (typeof b.shipping_mode === "string" && SHIP_MODES.includes(b.shipping_mode)) {
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
      ["tiktok_pixel_id", "tiktok_pixel_id", 40],
    ];
    for (const [field, key, max] of text) if (typeof st[field] === "string") await saveSetting(key, clean(st[field], max));
    if (typeof st.whatsapp === "string") {
      let w = digits(st.whatsapp);
      if (w && w.length <= 11) w = "55" + w;
      if (w && (w.length < 12 || w.length > 13)) throw new HttpError(400, "WhatsApp inválido. Use DDD + número.");
      await saveSetting("store_whatsapp", w);
    }
  }
  if (Array.isArray(b.extra_prices_cents)) {
    const l = b.extra_prices_cents.slice(0, 3).map((v: unknown) => Math.round(Number(v) || 0));
    if (l.some((v: number) => !(v === 0 || (v >= 100 && v <= 1000000)))) throw new HttpError(400, "Preço do enfeite a mais inválido.");
    await saveSetting("extra_prices_cents", l.join(","));
  }
  if (b.extra_max !== undefined) {
    const v = parseInt(b.extra_max, 10);
    if (!(v >= 0 && v <= 3)) throw new HttpError(400, "Máximo de adicionais: de 0 a 3.");
    await saveSetting("extra_max", String(v));
  }
  if (b.free_shipping_up_to_cents !== undefined) {
    const v = Math.round(Number(b.free_shipping_up_to_cents) || 0);
    if (!(v >= 0 && v <= 100000)) throw new HttpError(400, "Valor de frete grátis inválido.");
    await saveSetting("free_shipping_up_to_cents", String(v));
  }
  if (typeof b.ntfy_topic === "string") {
    const v = b.ntfy_topic.trim();
    if (v && !/^[A-Za-z0-9_-]{6,64}$/.test(v)) throw new HttpError(400, "Tópico de notificação inválido (use letras, números, - ou _).");
    await saveSetting("ntfy_topic", v);
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
  if (b.local && typeof b.local === "object") {
    const L = b.local;
    if (L.price_cents !== undefined) {
      const v = parseInt(L.price_cents, 10);
      if (!(v >= 100 && v <= 1000000)) throw new HttpError(400, "Preço de balcão inválido.");
      await saveSetting("local_price_cents", String(v));
    }
    if (Array.isArray(L.extra_prices)) {
      const l = L.extra_prices.slice(0, 3).map((v: unknown) => Math.round(Number(v) || 0));
      if (l.some((v: number) => !(v === 0 || (v >= 100 && v <= 1000000)))) throw new HttpError(400, "Preço de balcão do enfeite a mais inválido.");
      await saveSetting("local_extra_prices_cents", l.join(","));
    }
    if (typeof L.ceps === "string") {
      const list = L.ceps.split(/[\s,;]+/).map(digits).filter(Boolean);
      if (list.some((v: string) => v.length < 2 || v.length > 8)) throw new HttpError(400, "CEPs da entrega em mãos: use o começo do CEP, ex.: 13150.");
      await saveSetting("local_ceps", list.join(","));
    }
    if (L.delivery_cents !== undefined) {
      const v = Math.round(Number(L.delivery_cents) || 0);
      if (!(v >= 0 && v <= 100000)) throw new HttpError(400, "Taxa de entrega em mãos inválida.");
      await saveSetting("local_delivery_cents", String(v));
    }
    if (L.ready_days !== undefined) {
      const v = parseInt(L.ready_days, 10);
      if (!(v >= 0 && v <= 30)) throw new HttpError(400, "Prazo de retirada: de 0 a 30 dias.");
      await saveSetting("pickup_days", String(v));
    }
  }
  if (typeof b.new_password === "string" && b.new_password) {
    if (b.new_password.length < 8) throw new HttpError(400, "A nova senha precisa ter pelo menos 8 caracteres.");
    await saveSetting("admin_password_hash", await sha256Hex("pn:" + b.new_password));
  }
  return json({ settings: settingsView(await loadSettings()) });
}

// ───────────────────────── parceiros (pet shops) ─────────────────────────
//
// Cada loja tem um código curto (link/QR: site/?p=CODIGO) e uma chave secreta para a página
// dela (parceiro.html?k=CHAVE). A comissão é uma % sobre os enfeites (sem o frete), gravada
// quando o pagamento entra, e só conta enquanto o pedido estiver pago.

const partnerCode = (v: unknown) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);

// Id da loja ativa a partir do código que o site guardou (ou null).
async function partnerIdOf(code: unknown): Promise<string | null> {
  const c = partnerCode(code);
  if (c.length < 3) return null;
  const { data } = await db.from("pn_partners").select("id").eq("code", c).eq("active", true).maybeSingle();
  return data?.id ?? null;
}

// Recalcula a comissão de um pedido pago (no pagamento e quando entra um enfeite a mais).
async function updatePartnerCommission(orderId: string): Promise<{ name: string; cents: number } | null> {
  const { data: o } = await db.from("pn_orders")
    .select("partner_id, payment_status, is_test, amount_cents, shipping_cents").eq("id", orderId).maybeSingle();
  if (!o?.partner_id || o.payment_status !== "paid") return null;
  const { data: p } = await db.from("pn_partners").select("name, commission_pct").eq("id", o.partner_id).maybeSingle();
  if (!p) return null;
  const base = Math.max(0, (o.amount_cents ?? 0) - (o.shipping_cents ?? 0));
  const cents = o.is_test ? 0 : Math.round(base * Number(p.commission_pct) / 100);
  await db.from("pn_orders").update({ partner_commission_cents: cents }).eq("id", orderId);
  return { name: p.name, cents };
}

// Visita vinda do QR: conta uma vez por navegador e devolve o nome da loja (para o "Indicado por").
async function partnerHit(b: Body) {
  const c = partnerCode(b.code);
  if (c.length < 3) return json({});
  if (b.count !== false) await db.rpc("pn_partner_hit", { p_code: c });
  const { data: p } = await db.from("pn_partners").select("name, pickup, address, hours").eq("code", c).eq("active", true).maybeSingle();
  if (!p) return json({});
  const s = cfg(await loadSettings());
  return json({
    name: p.name,
    pickup: p.pickup && p.address ? { name: p.name, address: p.address, hours: p.hours || "", partner: true } : null,
    price_cents: s.local.priceCents,
    extra_prices: s.extraMax > 0 ? s.local.extraPrices.slice(0, s.extraMax) : [],
    normal_price_cents: s.priceCents,
    delivery_cents: s.local.deliveryCents,
    ready_days: s.local.readyDays,
  });
}

// Números de várias lojas de uma vez: testes, vendas, enfeites e comissão.
// deno-lint-ignore no-explicit-any
async function partnerStats(ids: string[]): Promise<Record<string, any>> {
  // deno-lint-ignore no-explicit-any
  const out: Record<string, any> = {};
  for (const id of ids) out[id] = { tests: 0, leads: 0, sales: 0, ornaments: 0, revenue_cents: 0, earned_cents: 0, paid_out_cents: 0, balance_cents: 0, month_earned_cents: 0, sales_list: [], payouts: [] };
  if (!ids.length) return out;
  const { data: orders } = await db.from("pn_orders")
    .select("partner_id, order_no, code, created_at, paid_at, payment_status, is_test, extras, amount_cents, shipping_cents, partner_commission_cents, lead_at")
    .in("partner_id", ids).order("created_at", { ascending: false }).limit(5000);
  const { data: payouts } = await db.from("pn_partner_payouts").select("partner_id, amount_cents, note, paid_at").in("partner_id", ids).order("paid_at", { ascending: false });
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(3, 0, 0, 0); // meia-noite de Brasília
  for (const o of orders ?? []) {
    const s = out[o.partner_id];
    s.tests++;
    if (o.lead_at) s.leads++;
    if (o.payment_status === "pending" || o.is_test) continue;
    const paid = o.payment_status === "paid";
    const com = o.partner_commission_cents ?? 0;
    if (paid) {
      s.sales++;
      s.ornaments += (o.extras ?? 0) + 1;
      s.revenue_cents += Math.max(0, o.amount_cents - (o.shipping_cents ?? 0));
      s.earned_cents += com;
      if (o.paid_at && new Date(o.paid_at) >= monthStart) s.month_earned_cents += com;
    }
    if (s.sales_list.length < 100) {
      s.sales_list.push({
        order: o.order_no ? "#" + String(o.order_no).padStart(3, "0") : o.code,
        paid_at: o.paid_at, ornaments: (o.extras ?? 0) + 1,
        commission_cents: com, status: paid ? "pago" : "reembolsado",
      });
    }
  }
  for (const p of payouts ?? []) {
    const s = out[p.partner_id];
    s.paid_out_cents += p.amount_cents;
    s.payouts.push({ amount_cents: p.amount_cents, note: p.note, paid_at: p.paid_at });
  }
  for (const id of ids) out[id].balance_cents = out[id].earned_cents - out[id].paid_out_cents;
  return out;
}

// Página do parceiro (sem login: a chave secreta do link é a senha).
async function partnerView(b: Body) {
  const k = String(b.k ?? "");
  if (!/^[0-9a-f]{32}$/.test(k)) {
    await sleep(500);
    throw new HttpError(404, "Link de parceiro inválido. Peça um novo para a Patinha de Natal.");
  }
  const { data: p } = await db.from("pn_partners").select("*").eq("secret", k).maybeSingle();
  if (!p) {
    await sleep(500);
    throw new HttpError(404, "Link de parceiro inválido. Peça um novo para a Patinha de Natal.");
  }
  const c = cfg(await loadSettings());
  const s = (await partnerStats([p.id]))[p.id];
  // Pedidos que o cliente retira nesta loja (só o necessário para entregar: nº, primeiro nome, pet).
  const { data: po } = await db.from("pn_orders")
    .select("id, order_no, code, name, pet_name, extras, production_status, paid_at, is_test")
    .eq("partner_id", p.id).eq("payment_status", "paid").eq("delivery_method", "retirada")
    .like("pickup_label", p.name.replace(/[%_\\]/g, "") + " — %")
    .order("paid_at", { ascending: false }).limit(60);
  const twoWeeks = Date.now() - 14 * 24 * 3600 * 1000;
  const pickups = (po ?? []).filter((o) => o.production_status !== "entregue" || new Date(o.paid_at).getTime() > twoWeeks).map((o) => {
    const parts = String(o.name || "").trim().split(/\s+/);
    return {
      id: o.id, order: o.order_no ? "#" + String(o.order_no).padStart(3, "0") : o.code,
      customer: parts[0] + (parts.length > 1 ? " " + parts[parts.length - 1][0] + "." : ""),
      pet_name: o.pet_name, ornaments: (o.extras ?? 0) + 1, status: o.production_status, paid_at: o.paid_at, is_test: o.is_test,
    };
  });
  return json({
    pickups,
    ready_days: c.local.readyDays,
    partner: { name: p.name, code: p.code, commission_pct: Number(p.commission_pct), active: p.active, hits: p.hits, has_pix: !!p.pix_key, pickup: p.pickup && !!p.address, address: p.address, hours: p.hours },
    stats: s,
    price_cents: c.priceCents,
    extra_prices: c.extraMax > 0 ? c.extraPrices.slice(0, c.extraMax) : [],
    whatsapp: c.store.whatsapp,
  });
}

// A loja confirma que o cliente retirou o pedido.
async function partnerDelivered(b: Body) {
  const k = String(b.k ?? "");
  if (!/^[0-9a-f]{32}$/.test(k) || !isUuid(b.order)) throw new HttpError(400, "Pedido inválido.");
  const { data: p } = await db.from("pn_partners").select("id").eq("secret", k).maybeSingle();
  if (!p) throw new HttpError(404, "Link de parceiro inválido.");
  const { data, error } = await db.from("pn_orders").update({ production_status: "entregue" })
    .eq("id", b.order).eq("partner_id", p.id).eq("payment_status", "paid").eq("delivery_method", "retirada").select("id");
  if (error || !data?.length) throw new HttpError(400, "Não foi possível marcar este pedido.");
  return await partnerView(b);
}

// deno-lint-ignore no-explicit-any
async function partnerById(id: string): Promise<any | null> {
  const { data } = await db.from("pn_partners").select("id, name, pickup, address, hours, active").eq("id", id).maybeSingle();
  return data ?? null;
}

const isLocalCep = (c: ReturnType<typeof cfg>, cep: unknown) => !!cep && c.local.ceps.some((pre) => String(cep).startsWith(pre));

// Onde o cliente retira: na loja parceira (se ela for ponto de retirada) ou no ponto padrão.
// deno-lint-ignore no-explicit-any
function pickupFor(c: ReturnType<typeof cfg>, partner: any): { name: string; address: string; hours: string; partner: boolean } | null {
  if (partner?.pickup && partner.address) return { name: partner.name, address: partner.address, hours: partner.hours || "", partner: true };
  return c.pickup.enabled ? { name: c.pickup.name, address: c.pickup.address, hours: "", partner: false } : null;
}

// Preço de balcão: quem veio pela loja parceira e não usa Correios (retira ou recebe em mãos na cidade).
// Antes de informar o endereço vale o balcão (a opção padrão é retirar na loja). Depois de pago, fica o que foi cobrado.
// deno-lint-ignore no-explicit-any
function isLocalDeal(c: ReturnType<typeof cfg>, order: any, partner: any): boolean {
  if (order.payment_status !== "pending") return !!order.local_deal;
  if (!partner) return false;
  if (order.delivery_method === "retirada" || !order.cep) return true;
  return isLocalCep(c, order.cep);
}

function priceList(c: ReturnType<typeof cfg>, local: boolean) {
  return local ? { price: c.local.priceCents, extras: c.local.extraPrices } : { price: c.priceCents, extras: c.extraPrices };
}

async function adminPartners() {
  const { data: list, error } = await db.from("pn_partners").select("*").order("created_at", { ascending: false });
  if (error) throw new HttpError(500, "Erro ao carregar parceiros.");
  const stats = await partnerStats((list ?? []).map((p) => p.id));
  return json({
    partners: (list ?? []).map((p) => ({
      id: p.id, code: p.code, name: p.name, contact_name: p.contact_name, whatsapp: p.whatsapp, pix_key: p.pix_key,
      city: p.city, commission_pct: Number(p.commission_pct), secret: p.secret, active: p.active, hits: p.hits,
      notes: p.notes, created_at: p.created_at, stats: stats[p.id],
      pickup: p.pickup, address: p.address, hours: p.hours,
    })),
    local: await (async () => {
      const c = cfg(await loadSettings());
      return { price_cents: c.local.priceCents, extra_prices: c.local.extraPrices, ceps: c.local.ceps.join(", "), delivery_cents: c.local.deliveryCents, ready_days: c.local.readyDays, normal_price_cents: c.priceCents, normal_extra_prices: c.extraPrices, extra_max: c.extraMax };
    })(),
  });
}

async function adminSavePartner(b: Body) {
  const name = clean(b.name, 80);
  if (name.length < 2) throw new HttpError(400, "Digite o nome da loja.");
  const pct = Number(String(b.commission_pct ?? "15").replace(",", "."));
  if (!(pct >= 0 && pct <= 50)) throw new HttpError(400, "Comissão: de 0 a 50%.");
  let whatsapp = digits(b.whatsapp);
  if (whatsapp && whatsapp.length <= 11) whatsapp = "55" + whatsapp;
  if (whatsapp && (whatsapp.length < 12 || whatsapp.length > 13)) throw new HttpError(400, "WhatsApp da loja inválido. Use DDD + número.");
  const row = {
    name,
    contact_name: clean(b.contact_name, 80) || null,
    whatsapp: whatsapp || null,
    pix_key: clean(b.pix_key, 120) || null,
    city: clean(b.city, 80) || null,
    commission_pct: Math.round(pct * 100) / 100,
    active: b.active !== false,
    notes: clean(b.notes, 500) || null,
    pickup: b.pickup !== false,
    address: clean(b.address, 200) || null,
    hours: clean(b.hours, 120) || null,
  };
  if (isUuid(b.id)) {
    const patch: Record<string, unknown> = { ...row };
    if (b.new_secret === true) patch.secret = randomHex(16);
    const { error } = await db.from("pn_partners").update(patch).eq("id", b.id);
    if (error) throw new HttpError(500, "Não foi possível salvar a loja.");
    return await adminPartners();
  }
  // Código curto e fácil de ler: do nome da loja (sem "pet shop") ou o que o dono digitou.
  // (NFD separa os acentos; partnerCode descarta o que não é A-Z/0-9)
  const generic = /\b(PET\s*SHOP|PETSHOP|PET|SHOP|CLINICA|VETERINARIA|AGROPECUARIA|BANHO|TOSA|E|DE|DO|DA|DOS|DAS)\b/g;
  const wanted = partnerCode(b.code);
  if (b.code && wanted.length < 3) throw new HttpError(400, "O código precisa ter de 3 a 12 letras ou números.");
  const fromName = partnerCode(name.toUpperCase().normalize("NFD").replace(generic, " ")).slice(0, 10);
  const base = wanted || (fromName.length >= 3 ? fromName : partnerCode(name.normalize("NFD")).slice(0, 10)) || "LOJA";
  for (let i = 0; i < 20; i++) {
    const code = i === 0 && base.length >= 3 ? base : base.slice(0, 8) + String(Math.floor(Math.random() * 90) + 10);
    const { error } = await db.from("pn_partners").insert({ ...row, code, secret: randomHex(16) });
    if (!error) return await adminPartners();
    if (error.code !== "23505") throw new HttpError(500, "Não foi possível cadastrar a loja.");
    if (wanted) throw new HttpError(409, "Esse código já é de outra loja. Escolha outro.");
  }
  throw new HttpError(500, "Não foi possível criar um código para a loja. Digite um código.");
}

// Registra um Pix de comissão pago à loja (valor negativo corrige um lançamento errado).
async function adminPartnerPayout(b: Body) {
  if (!isUuid(b.partner_id)) throw new HttpError(400, "Loja inválida.");
  const cents = Math.round(Number(b.amount_cents) || 0);
  if (!cents || Math.abs(cents) > 10000000) throw new HttpError(400, "Valor inválido.");
  const { error } = await db.from("pn_partner_payouts").insert({ partner_id: b.partner_id, amount_cents: cents, note: clean(b.note, 200) || null });
  if (error) throw new HttpError(500, "Não foi possível registrar o pagamento.");
  return await adminPartners();
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
      case "trial-start": return await trialStart(req, body);
      case "lead": return await lead(body);
      case "pay": return await pay(body);
      case "choose": return await choose(body);
      case "item-kind": return await itemKind(body);
      case "add-extras": return await addExtras(body);
      case "confirm": return await confirm(body);
      case "partner-hit": return await partnerHit(body);
      case "partner-view": return await partnerView(body);
      case "partner-delivered": return await partnerDelivered(body);
      case "admin-partners": await requireAdmin(req); return await adminPartners();
      case "admin-save-partner": await requireAdmin(req); return await adminSavePartner(body);
      case "admin-partner-payout": await requireAdmin(req); return await adminPartnerPayout(body);
      case "admin-login": return json({ settings: settingsView(await requireAdmin(req)) });
      case "admin-orders": await requireAdmin(req); return await adminOrders(body);
      case "admin-update-order": await requireAdmin(req); return await adminUpdateOrder(body);
      case "admin-save-settings": await requireAdmin(req); return await adminSaveSettings(body);
      case "admin-test-notify": {
        const c = cfg(await requireAdmin(req));
        if (!c.ntfyTopic) throw new HttpError(400, "Salve o tópico antes de testar.");
        await pushOwner(c, "🔔 Teste da Patinha de Natal", "As notificações de pedidos estão funcionando!");
        return json({ ok: true });
      }
      default: throw new HttpError(400, "Ação desconhecida.");
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error("erro inesperado", err);
    return json({ error: "Algo deu errado do nosso lado. Tente de novo em instantes." }, 500);
  }
});
