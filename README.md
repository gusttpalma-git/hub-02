# Patinha de Natal 🎄🐾

Loja de um produto só: o cliente paga, envia a foto do pet, a IA cria a arte
(sempre na mesma pose, dentro do aro), ele escolhe uma entre até 3 e informa o
endereço. Você recebe o pedido no painel com o SVG pronto para a impressora 3D.

## O que tem aqui

| Pasta | O que é |
|---|---|
| `site/` | O site inteiro (HTML/CSS/JS puro, sem build). **É esta pasta que vai para a hospedagem.** |
| `supabase/migrations/` | Estrutura do banco (pedidos, artes, configurações). |
| `supabase/functions/pn-api/` | A API: pagamento (Mercado Pago), IA de imagem (OpenAI), painel. |

Páginas do site:

- `index.html` — página de vendas + formulário de compra
- `criar.html` — onde o cliente envia a foto, escolhe a arte, informa o endereço e acompanha o envio
- `admin.html` — seu painel: pedidos, download de PNG/SVG, rastreio e configurações
- `politicas.html` — trocas, entrega e privacidade

## Colocar no ar

### 1. Backend (Supabase)

1. No SQL Editor do projeto, rode `supabase/migrations/001_patinha_de_natal.sql`.
2. Publique a função `supabase/functions/pn-api` com o nome **`pn-api`** e a opção
   **Verify JWT desligada** (a função faz a própria autenticação).
   Pela CLI: `supabase functions deploy pn-api --no-verify-jwt`
3. Crie a senha do painel (troque `SUA-SENHA`):

   ```sql
   insert into pn_settings (key, value)
   values ('admin_password_hash', encode(digest('pn:' || 'SUA-SENHA', 'sha256'), 'hex'))
   on conflict (key) do update set value = excluded.value;
   ```

### 2. Site

1. Abra `site/js/config.js` e preencha `API_URL` com
   `https://<seu-projeto>.supabase.co/functions/v1/pn-api`, além do WhatsApp e dos dados da empresa.
2. Envie **o conteúdo** da pasta `site/` para a hospedagem (public_html). O site precisa estar em **https**.

### 3. Chaves (pelo painel, sem mexer em código)

Abra `seusite.com.br/admin.html` → **Configurações**:

- **Mercado Pago — Access Token de produção**
  (mercadopago.com.br/developers → Suas integrações → Credenciais de produção)
- **OpenAI — API Key** (platform.openai.com → API keys; é a conta de API com créditos,
  não a assinatura do ChatGPT). Modelo padrão: `gpt-image-2`.
- Preço, número de artes por pedido e senha do painel.

Sem o token do Mercado Pago o site mostra "vendas ainda não abertas". Sem a chave da
OpenAI o cliente não consegue criar a arte.

### Testar antes de anunciar

Ligue o **Modo de teste** em Configurações: os pedidos passam direto, sem cobrança.
Com a chave da OpenAI preenchida a arte é gerada de verdade; sem ela aparece uma arte
de exemplo. **Desligue o modo de teste antes de divulgar o site.**

## Dia a dia

1. O pedido aparece em **Para produzir** quando o cliente escolhe a arte e confirma o endereço.
2. **Baixar SVG** vetoriza a arte em 3–10 cores chapadas (escolha a quantidade) para importar no fatiador.
3. Mude a situação para **Em produção** → **Enviado** e cole o código de rastreio. O cliente vê tudo em `criar.html`.
4. Se o cliente não gostou de nenhuma arte, use **+1 tentativa de arte** no pedido.

## Como funciona por dentro

- O site nunca fala com o banco: tudo passa pela função `pn-api`. As tabelas têm RLS ligado e nenhuma policy.
- Cada pedido tem um link secreto (`criar.html?t=...`), salvo no aparelho do cliente. Se ele perder,
  entra de novo com e-mail + WhatsApp em "Já comprei".
- O pagamento é confirmado direto na API do Mercado Pago (webhook + conferência quando o cliente volta),
  nunca pelo que o navegador diz.
- Cada geração gasta 1 tentativa; se a IA falhar, a tentativa é devolvida automaticamente.
- O texto que define o estilo da arte está em `ART_PROMPT`, no início de `pn-api/index.ts`.

## Antes de anunciar, revise

- `TAMANHO` e `PRAZO_PRODUCAO` em `config.js` (aparecem na página e nas políticas).
- As fotos de exemplo em `site/img/` — troque por fotos reais dos enfeites impressos quando tiver.
- `politicas.html` — confira se os prazos e condições batem com o que você pratica.
