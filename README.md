# 🛒 Sistema de Recuperação de Carrinho Abandonado (Bestfy + WAHA WhatsApp)

Sistema inteligente, autônomo e de alta conversão para recuperação de carrinhos abandonados e pós-venda, integrando a plataforma de pagamentos **Bestfy** ao WhatsApp via **WAHA (WhatsApp HTTP API)**.

---

## 📋 Sumário
1. [Visão Geral](#-visão-geral)
2. [Como o Sistema Funciona (Fluxo Passo a Passo)](#-como-o-sistema-funciona-fluxo-passo-a-passo)
3. [Mecanismos de Proteção Anti-Ban e Inteligência](#-mecanismos-de-proteção-anti-ban-e-inteligência)
4. [Arquitetura e Tecnologias](#-arquitetura-e-tecnologias)
5. [Estrutura de Pastas e Arquivos](#-estrutura-de-pastas-e-arquivos)
6. [Banco de Dados (SQLite)](#-banco-de-dados-sqlite)
7. [Variáveis de Ambiente (.env)](#-variáveis-de-ambiente-env)
8. [Como Rodar Localmente](#-como-rodar-localmente)
9. [Deploy em Produção (Railway / Docker)](#-deploy-em-produção-railway--docker)
10. [Configuração do Webhook na Bestfy](#-configuração-do-webhook-na-bestfy)
11. [Dashboard Administrativo](#-dashboard-administrativo)

---

## 🎯 Visão Geral

Quando um cliente inicia uma compra na Bestfy mas não conclui o pagamento (seja por boleto não pago, PIX pendente, cartão recusado ou abandono de checkout), o sistema:
1. **Captura o evento via Webhook** em tempo real.
2. **Normaliza e higieniza os dados** do cliente (nome, telefone brasileiro com/sem nono dígito, itens e valores).
3. **Agenda o disparo** de uma mensagem personalizada de recuperação respeitando o tempo configurado (ex: 25 minutos).
4. **Verifica regras anti-spam e de segurança**: se o cliente já comprou, se está em horário de silêncio, se já recebeu mensagem recente.
5. **Simula digitação humana e dispara via WhatsApp** usando Spintax (mensagens variadas) para evitar bloqueios de conta.
6. **Detecta pagamentos aprovados**: cancela mensagens pendentes de cobrança e (opcionalmente) envia mensagem de confirmação e agradecimento com entrega de acesso.

---

## 🔄 Como o Sistema Funciona (Fluxo Passo a Passo)

```
[Cliente no Checkout Bestfy]
              │
              ▼
   (Abandono / Pix / Boleto / Recusado)
              │
              ▼
    [Webhook da Bestfy] ─── POST /webhook/bestfy ───► [Servidor Express]
                                                               │
                                                               ▼
                                                  [Validação e Deduplicação]
                                                               │
                             ┌─────────────────────────────────┴─────────────────────────────────┐
                             ▼                                                                   ▼
                     [Status = Paid / Pago]                                         [Status = Pendente / Abandonado]
                             │                                                                   │
                             ▼                                                                   ▼
                   Marca como Recuperado                                                Agenda Envio no Banco
                 Cancela cobranças pendentes                                            (ex: Agora + 25 minutos)
                 (Opcional) Envia msg de Sucesso                                                 │
                                                                                                 ▼
                                                                                   [Cron Scheduler (a cada 1 min)]
                                                                                                 │
                                                                   ┌─────────────────────────────┴─────────────────────────────┐
                                                                   ▼                                                           ▼
                                                         [Carrinho no Prazo?]                                      [Dentro de Horário de Silêncio?]
                                                                   │                                                           │
                                                                  SIM                                                         SIM -> Aguarda amanhecer
                                                                   ▼                                                           │
                                                       [Validações de Segurança]                                              NÃO
                                                       - Já pagou esse pedido?                                                 │
                                                       - Recebeu msg nas últimas 4h?                                           │
                                                       - Número tem WhatsApp ativo?                                            │
                                                       - Valida 9º dígito no WAHA                                              │
                                                                   │                                                           │
                                                                  OK ◄─────────────────────────────────────────────────────────┘
                                                                   │
                                                                   ▼
                                                       [Simula Digitação Humana] (2.5s a 5.5s)
                                                                   │
                                                                   ▼
                                                       [Disparo via WAHA WhatsApp]
                                                       (Spintax + Nome + Itens + Link)
                                                                   │
                                                                   ▼
                                                       [Atualiza Status no Dashboard]
```

### 1. Recepção do Webhook (`src/webhook.js`)
- Recebe requisições da Bestfy nas rotas `/webhook/bestfy`, `/webhook`, `/api/webhook` ou na raiz `/`.
- Registra o evento bruto na tabela `webhook_events` para auditoria e diagnóstico.
- Suporta múltiplos formatos de payload da Bestfy (transações, checkouts abandonados, payloads aninhados em `data`, etc.).

### 2. Tratamento e Deduplicação (`src/utils.js`)
- **Deduplicação de Pedidos**: se o mesmo cliente gerar 3 tentativas do mesmo carrinho seguidas, o sistema atualiza o carrinho existente em vez de criar múltiplos agendamentos e mandar várias mensagens.
- **Detecção de Pedido Já Pago**: se o cliente já tiver concluído a compra nos últimos 2 dias, o sistema ignora tentativas pendentes residuais.

### 3. Agendamento e Execução (`src/server.js` + `src/messenger.js`)
- Um cron roda **a cada 1 minuto** (`* * * * *`) executando `processPendingCarts()`.
- Busca no banco SQLite todos os carrinhos com `status = 'pending'`, `message_sent = 0` e `scheduled_at <= datetime('now')`.

### 4. Notificação de Pagamento Confirmado
- Quando a Bestfy notifica `paid` / `approved`, o carrinho é marcado como `recovered = 1`.
- Se a opção `paid_message_active` estiver ativada, envia automaticamente uma mensagem confirmando o pagamento e informando sobre o acesso.

---

## 🛡️ Mecanismos de Proteção Anti-Ban e Inteligência

O sistema foi desenhado para proteger o seu número de WhatsApp contra bloqueios e evitar desconforto aos clientes:

1. **Simulação de Digitação Humana (`simulateTyping`)**:
   - Antes de enviar a mensagem, o sistema aciona o evento `startTyping` no WhatsApp por 2.5 a 5.5 segundos (com jitter dinâmico proporcional ao tamanho da mensagem).
2. **Resolução de JID Canônico e 9º Dígito (`resolveChatId`)**:
   - No Brasil, alguns números de WhatsApp foram cadastrados com 8 dígitos e outros com 9 dígitos.
   - O sistema consulta `/api/contacts/check-exists` no WAHA para descobrir exatamente como o WhatsApp reconhece aquele número (`@c.us`), testando alternâncias do 9º dígito antes de enviar.
3. **Spintax Dinâmico (`parseSpintax`)**:
   - Permite criar templates como `{Olá|Oi|Opa} {nome}! {Notamos|Vimos} que...`.
   - Cada mensagem é gerada com palavras e estruturas diferentes, impedindo que o algoritmo do WhatsApp detecte mensagens idênticas em massa.
4. **Horário de Silêncio (`isQuietHours`)**:
   - Evita enviar mensagens em horários impróprios (padrão: 23:00 às 08:00 no fuso de Brasília `America/Sao_Paulo`).
   - Carrinhos que vencerem de madrugada ficam em espera e são disparados suavemente pela manhã.
5. **Cooldown por Cliente (`hasRecentRecoveryMessage`)**:
   - Se o mesmo cliente abandonar múltiplos carrinhos dentro da janela de cooldown (ex: 4 horas), ele não receberá mensagens repetidas.
6. **Expiração Automática de Carrinhos Antigos**:
   - Carrinhos com mais de 12 horas (configurável) que não foram enviados são marcados como expirados para não cobrar clientes dias depois.
7. **Controle de Retentativas Seguras**:
   - Máximo de 3 tentativas em caso de instabilidade na API do WAHA.

---

## 🏗️ Arquitetura e Tecnologias

- **Linguagem**: Node.js (v22+)
- **Framework Web**: Express 5
- **Banco de Dados**: SQLite via `better-sqlite3` (rápido, embarcado, sem dependência de banco externo e com modo WAL ativado para concorrência)
- **Agendamento**: `node-cron`
- **Comunicação HTTP**: `axios`
- **WhatsApp Gateway**: WAHA (WhatsApp HTTP API)
- **Frontend / Dashboard**: HTML5, CSS3 moderno, Vanilla JavaScript (sem dependências pesadas, ultra rápido)

---

## 📁 Estrutura de Pastas e Arquivos

```
recuperacao-de-carrinho/
├── data/                      # Diretório do banco SQLite (cart-recovery.db)
├── public/                    # Frontend do Dashboard
│   ├── index.html             # Interface visual administrativa
│   ├── styles.css             # Estilos do dashboard (Dark/Modern UI)
│   └── app.js                 # Lógica de consumo da API e reatividade
├── src/                       # Código-fonte backend
│   ├── server.js              # Ponto de entrada Express e inicialização do Cron
│   ├── webhook.js             # Roteador de Webhooks da Bestfy e parsing de eventos
│   ├── messenger.js           # Motor de mensagens, regras anti-ban e WAHA
│   ├── database.js            # Inicialização do SQLite, tabelas e migrações
│   ├── api.js                 # Endpoints REST para o Dashboard (/api/stats, /api/carts...)
│   └── utils.js               # Funções auxiliares (telefones, deduplicação de pedidos)
├── .env.example               # Modelo de variáveis de ambiente
├── Dockerfile                 # Configuração para containerização Docker
├── nixpacks.toml              # Configuração para deploy direto no Railway
├── package.json               # Dependências e scripts do projeto
└── README.md                  # Documentação completa do sistema
```

---

## 🗄️ Banco de Dados (SQLite)

O banco é criado automaticamente na primeira execução no arquivo `data/cart-recovery.db`.

### Principais Tabelas:
- **`abandoned_carts`**: Armazena transações/checkouts recebidos, dados do cliente, valor, status (`pending`, `sent`, `recovered`, `failed`, `cancelled`, `expired`), data de agendamento e data de recuperação.
- **`message_log`**: Histórico detalhado de todas as mensagens disparadas ou falhas, com resposta do WAHA e data/hora.
- **`settings`**: Parâmetros do sistema gerenciáveis pelo Dashboard (tempo de delay, templates de mensagens, flags anti-ban, URLs e chaves).
- **`webhook_events`**: Histórico dos payloads brutos recebidos da Bestfy para auditoria.

---

## ⚙️ Variáveis de Ambiente (.env)

Crie um arquivo `.env` na raiz baseado no `.env.example`:

```env
# Porta do Servidor
PORT=3000

# Chave Secreta da Bestfy (opcional, para validação)
BESTFY_SECRET_KEY=sua_chave_secreta_aqui

# Configurações do WAHA (WhatsApp HTTP API)
WAHA_API_URL=http://localhost:3001
WAHA_SESSION=default
WAHA_API_KEY=sua_api_key_aqui

# Tempo padrão de espera para recuperação (em minutos)
RECOVERY_DELAY_MINUTES=25

# Diretório de dados persistentes (opcional, útil para Railway/Docker)
DATA_DIR=./data
```

---

## 🚀 Como Rodar Localmente

### Pré-requisitos:
- **Node.js** v22 ou superior instalado.
- Instância do **WAHA** rodando e conectada ao WhatsApp via QR Code.

### Passo a passo:

1. **Instalar as dependências**:
   ```bash
   npm install
   ```

2. **Configurar as variáveis de ambiente**:
   ```bash
   cp .env.example .env
   # Edite o arquivo .env com a URL e credenciais do seu WAHA
   ```

3. **Iniciar em modo de desenvolvimento**:
   ```bash
   npm run dev
   ```

4. **Iniciar em produção**:
   ```bash
   npm start
   ```

5. **Acessar o Dashboard**:
   - Abra o navegador em: `http://localhost:3000`

---

## ☁️ Deploy em Produção (Railway / Docker)

### Deploy no Railway (Recomendado):
1. Crie um novo projeto no **Railway** apontando para o repositório.
2. Adicione um **Volume Persistente** montado no caminho `/app/data` (para preservar o banco SQLite entre deploys).
3. Configure as variáveis de ambiente no painel do Railway (`WAHA_API_URL`, `WAHA_SESSION`, `WAHA_API_KEY`, etc.).
4. O arquivo `nixpacks.toml` já está configurado para instalar as dependências nativas do SQLite e iniciar o servidor.

### Deploy com Docker:
```bash
# Construir a imagem
docker build -t cart-recovery .

# Executar o container persistindo os dados
docker run -d \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  --name cart-recovery-app \
  cart-recovery
```

---

## 🔗 Configuração do Webhook na Bestfy

1. Acesse o painel da **Bestfy** > **Configurações** > **Webhooks** (ou Postbacks).
2. Cadastre uma nova URL apontando para a rota pública do seu sistema:
   ```
   https://seu-dominio.com/webhook/bestfy
   ```
3. Selecione os eventos:
   - **Checkout Abandonado** (`cart.abandoned` / `checkout.created`)
   - **Transação Criada / Pendente** (`transaction.created` / `waiting_payment`)
   - **Transação Recusada** (`transaction.refused`)
   - **Transação Paga / Aprovada** (`transaction.paid` / `approved`)

---

## 🖥️ Dashboard Administrativo

O dashboard pode ser acessado diretamente na raiz do servidor (`/`).

### Recursos inclusos:
- **Visão Geral com KPIs**: Total de carrinhos, mensagens pendentes, mensagens enviadas, carrinhos recuperados, taxa de conversão (%) e valor total recuperado em R$.
- **Tabela de Carrinhos**: Listagem paginada com busca por cliente/telefone, filtros de status (`pending`, `sent`, `recovered`, etc.) e ação para **Disparar Agora** manualmente.
- **Histórico de Logs**: Registro de cada envio com payload, resposta do WAHA e eventuais erros.
- **Painel de Configurações**:
  - Edição do tempo de delay de recuperação (em minutos).
  - Editor com preview para a mensagem de recuperação com suporte a **Spintax** e variáveis (`{nome}`, `{produtos}`, `{valor}`, `{link}`).
  - Mensagem de confirmação de compra aprovada.
  - Alternador de horário de silêncio (Quiet Hours) e digitação humana simulada.
  - Teste de envio de WhatsApp em tempo real.
