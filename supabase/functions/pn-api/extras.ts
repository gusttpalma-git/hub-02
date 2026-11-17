// Frete e e-mails. Ficam fora do index.ts para ele continuar legível.

export type Quote = { cents: number; label: string; days: number | null };

// ───────────────────────── CEP → estado / região ─────────────────────────

const CEP_RANGES: [number, number, string][] = [
  [1000, 19999, "SP"], [20000, 28999, "RJ"], [29000, 29999, "ES"], [30000, 39999, "MG"],
  [40000, 48999, "BA"], [49000, 49999, "SE"], [50000, 56999, "PE"], [57000, 57999, "AL"],
  [58000, 58999, "PB"], [59000, 59999, "RN"], [60000, 63999, "CE"], [64000, 64999, "PI"],
  [65000, 65999, "MA"], [66000, 68899, "PA"], [68900, 68999, "AP"], [69000, 69299, "AM"],
  [69300, 69399, "RR"], [69400, 69899, "AM"], [69900, 69999, "AC"], [70000, 72799, "DF"],
  [72800, 72999, "GO"], [73000, 73699, "DF"], [73700, 76799, "GO"], [76800, 76999, "RO"],
  [77000, 77999, "TO"], [78000, 78899, "MT"], [79000, 79999, "MS"], [80000, 87999, "PR"],
  [88000, 89999, "SC"], [90000, 99999, "RS"],
];

const REGION: Record<string, string> = {
  SP: "sudeste", RJ: "sudeste", ES: "sudeste", MG: "sudeste",
  PR: "sul", SC: "sul", RS: "sul",
  DF: "centro_oeste", GO: "centro_oeste", MT: "centro_oeste", MS: "centro_oeste",
  BA: "nordeste", SE: "nordeste", PE: "nordeste", AL: "nordeste", PB: "nordeste", RN: "nordeste", CE: "nordeste", PI: "nordeste", MA: "nordeste",
  PA: "norte", AP: "norte", AM: "norte", RR: "norte", AC: "norte", RO: "norte", TO: "norte",
};

export const REGIONS = ["sudeste", "sul", "centro_oeste", "nordeste", "norte"] as const;
export const REGION_LABEL: Record<string, string> = {
  sudeste: "Sudeste", sul: "Sul", centro_oeste: "Centro-Oeste", nordeste: "Nordeste", norte: "Norte",
};

export function stateFromCep(cep: string): string | null {
  if (!/^\d{8}$/.test(cep)) return null;
  const prefix = parseInt(cep.slice(0, 5), 10);
  for (const [from, to, uf] of CEP_RANGES) if (prefix >= from && prefix <= to) return uf;
  return null;
}

// Hoje no horário de Brasília (AAAA-MM-DD).
function todayBR(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// Confere se entregamos nesse CEP (e, na compra, se ainda dá tempo para a data-limite da região).
export function checkRegion(c: ShippingConfig, cep: string, checkDeadline = true): { uf: string; region: string } {
  const uf = stateFromCep(cep);
  if (!uf) throw new Error("Não encontramos esse CEP. Confira os números.");
  const region = REGION[uf];
  const rule = c.regions?.[region];
  if (rule && !rule.on) {
    throw new Error(`Por enquanto não entregamos na região ${REGION_LABEL[region]} (${uf}). Fale com a gente pelo WhatsApp.`);
  }
  if (checkDeadline && rule?.until && todayBR() > rule.until) {
    const [y, m, d] = rule.until.split("-");
    void y;
    throw new Error(`Os pedidos para a região ${REGION_LABEL[region]} encerraram em ${d}/${m}, para chegar antes do Natal.`);
  }
  return { uf, region };
}

// ───────────────────────── cálculo do frete ─────────────────────────

export type ShippingConfig = {
  regions: Record<string, { on: boolean; until: string }>;
  packageCm: { length: number; width: number; height: number };
  mode: string;                 // incluso | tabela | melhor_envio
  table: Record<string, number>; // centavos por região
  originCep: string;
  melhorEnvioToken: string;
  weightGrams: number;
  contactEmail: string;
};

function tableQuote(c: ShippingConfig, cep: string): Quote {
  const uf = stateFromCep(cep);
  if (!uf) throw new Error("CEP inválido");
  const cents = c.table[REGION[uf]];
  if (!(cents >= 0)) throw new Error("tabela de frete incompleta");
  return { cents, label: `Envio para ${uf}`, days: null };
}

// Cotação em tempo real no Melhor Envio (Correios e transportadoras). Fica com a mais barata.
async function melhorEnvioQuote(c: ShippingConfig, cep: string): Promise<Quote> {
  const res = await fetch("https://melhorenvio.com.br/api/v2/me/shipment/calculate", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${c.melhorEnvioToken}`,
      "User-Agent": `Patinha de Natal (${c.contactEmail || "contato@loja.com.br"})`,
    },
    body: JSON.stringify({
      from: { postal_code: c.originCep },
      to: { postal_code: cep },
      package: { height: c.packageCm.height, width: c.packageCm.width, length: c.packageCm.length, weight: Math.max(0.01, c.weightGrams / 1000) },
    }),
    signal: AbortSignal.timeout(12000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(body)) throw new Error(`melhor envio ${res.status}`);
  // deno-lint-ignore no-explicit-any
  const options = body.filter((s: any) => !s.error && Number(s.price) > 0)
    // deno-lint-ignore no-explicit-any
    .map((s: any) => ({ cents: Math.round(Number(s.price) * 100), label: `${s.company?.name ?? ""} ${s.name ?? ""}`.trim(), days: Number(s.delivery_time) || null }));
  if (!options.length) throw new Error("melhor envio sem opções");
  return options.reduce((a, b) => (b.cents < a.cents ? b : a));
}

export async function quoteShipping(c: ShippingConfig, cep: string): Promise<Quote> {
  if (c.mode === "incluso") return { cents: 0, label: "Frete incluso", days: null };
  if (!stateFromCep(cep)) throw new Error("CEP inválido");
  if (c.mode === "melhor_envio" && c.melhorEnvioToken && /^\d{8}$/.test(c.originCep)) {
    try {
      return await melhorEnvioQuote(c, cep);
    } catch (err) {
      console.error("cotação Melhor Envio falhou; usando a tabela", err);
    }
  }
  return tableQuote(c, cep);
}

// ───────────────────────── e-mails (Resend) ─────────────────────────

export type MailConfig = { apiKey: string; from: string; brand: string };

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));

export function mailLayout(brand: string, title: string, lines: string[], button?: { text: string; url: string }): string {
  const cta = button
    ? `<p style="margin:26px 0"><a href="${esc(button.url)}" style="background:#c42b2b;color:#fff;text-decoration:none;font-weight:bold;padding:16px 28px;border-radius:999px;display:inline-block;font-size:18px">${esc(button.text)}</a></p>`
    : "";
  return `<div style="background:#fff8ee;padding:28px 14px;font-family:Arial,Helvetica,sans-serif;color:#22302a">
<div style="max-width:520px;margin:0 auto;background:#fff;border:2px solid #eadfcb;border-radius:18px;padding:28px 24px;font-size:17px;line-height:1.55">
<p style="margin:0 0 6px;font-weight:bold;color:#124a2f">🐾 ${esc(brand)}</p>
<h1 style="font-size:24px;margin:0 0 14px">${esc(title)}</h1>
${lines.map((l) => `<p style="margin:0 0 12px">${l}</p>`).join("\n")}
${cta}
</div></div>`;
}

// Nunca derruba o pedido: se o e-mail falhar, só registra no log.
export async function sendMail(c: MailConfig, to: string, subject: string, html: string): Promise<void> {
  if (!c.apiKey || !c.from || !to) return;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: c.from, to: [to], subject, html }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) console.error("e-mail não enviado", res.status, (await res.text()).slice(0, 300));
  } catch (err) {
    console.error("e-mail não enviado", err);
  }
}

export { esc };
