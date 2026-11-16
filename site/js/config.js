// ════════════════════════════════════════════════════════════════
//  CONFIGURAÇÃO DO SITE — é o único arquivo que você precisa editar
// ════════════════════════════════════════════════════════════════
window.PN_CONFIG = {
  // Endereço da API (Supabase Edge Function "pn-api").
  API_URL: "https://SEU-PROJETO.supabase.co/functions/v1/pn-api",

  // Nome da loja, mostrado no topo e no rodapé.
  MARCA: "Patinha de Natal",

  // WhatsApp de atendimento, só números com 55 + DDD (ex.: "5511999998888").
  // Deixe "" para esconder os botões de WhatsApp.
  WHATSAPP: "",

  // Informações do produto mostradas na página. Ajuste para a sua peça real.
  TAMANHO: "8 cm",
  PRAZO_PRODUCAO: "5 dias úteis",

  // Dados da empresa para o rodapé e a página de políticas.
  RAZAO_SOCIAL: "",
  CNPJ: "",
  EMAIL_CONTATO: "",
};
