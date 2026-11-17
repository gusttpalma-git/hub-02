# Patinha de Natal 🎄🐾

Loja de um produto só: o cliente paga, envia a foto do pet, a IA cria a arte
(sempre na mesma pose, dentro do aro), ele escolhe uma entre até 4 e informa o
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

1. No SQL Editor do projeto, rode os arquivos de `supabase/migrations/` em ordem.
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

### Frete, e-mails e anúncios (opcionais, também pelo painel)

- **Frete**: em Configurações escolha "incluso", "valor fixo por região" ou "cálculo automático pelo CEP".
  O automático usa o Melhor Envio (conta grátis; token com permissão de calcular fretes) e cai na
  tabela por região se a cotação falhar. Com frete cobrado, o cliente informa o CEP antes de pagar.
- **E-mails**: com uma API Key do Resend e um remetente de domínio validado, o cliente recebe o link do
  pedido ao pagar, a confirmação e o rastreio; você recebe um aviso a cada pedido pronto para produzir.
- **Anúncios**: preencha `META_PIXEL_ID` e/ou `GOOGLE_TAG_ID` em `site/js/config.js` para o site
  registrar início de compra e venda concluída.

### Peça 3D, cores e regiões (também pelo painel)

- **Filamentos**: cadastre só as cores que você tem (`Nome #RRGGBB`). A IA é orientada por elas e a arte
  final é reduzida a essas cores exatas (até 4 por padrão), então o cliente já vê o que será impresso.
- **Tipo de pet**: o cliente escolhe gato, cachorro, ave ou roedor antes da foto; cada um tem um prompt
  próprio (ex.: gato mantém a cor real dos olhos e o nariz rosa).
- **Modelo 3D**: no pedido, "Modelo 3D (3MF)" ou "STLs por cor (.zip)". Base branca com alça e furo,
  nome do pet e marca gravados no fundo (espelhados, virados para a mesa), e cada cor em relevo numa
  faixa de altura própria — uma cor por camada, poucas trocas de filamento. O zip traz um LEIA-ME com as
  alturas de troca. Diâmetro, base e relevo por cor ficam em Configurações.
- **Regiões**: desmarque as regiões que não atende e defina o último dia para pedir em cada uma.
  O CEP é conferido antes do pagamento.
- **Embalagem**: 16 × 11 × 2 cm e 50 g por padrão, dentro do Mini Envios dos Correios.

## Dia a dia

1. O pedido aparece em **Para produzir** quando o cliente escolhe a arte e confirma o endereço.
2. **Modelo 3D (3MF)** ou **STLs por cor** gera a peça pronta para o fatiador; SVG e PNG continuam disponíveis.
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
