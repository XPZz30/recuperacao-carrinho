# INFINITY GAMES — Implantação da recuperação de carrinho e confirmação de pagamento

A INFINITY GAMES usa **o mesmo sistema** da SA GAMES, mas em um **deploy separado**:
banco de dados, painel, número de WhatsApp e mensagens próprios. Nada é compartilhado,
então um problema em uma loja não afeta a outra.

O que o sistema faz para a loja:

| Evento na Bestfy | Ação |
|---|---|
| Checkout abandonado / PIX ou boleto pendente / cartão recusado | Agenda a 1ª mensagem de recuperação (padrão: 25 min), com texto por etapa do checkout |
| Cliente ainda não pagou após 4h | 2ª mensagem (follow-up) |
| Pagamento aprovado | Cancela as cobranças pendentes, marca como recuperado e envia a **confirmação de pagamento** |

Proteções já incluídas: horário de silêncio (23h–8h), não repetir mensagem em 4h,
simulação de digitação, variação de texto (spintax) e checagem de WhatsApp ativo.

---

## 1. WhatsApp (WAHA)

1. No painel do WAHA, crie uma nova sessão (ex.: `infinity`).
2. Leia o QR Code com o WhatsApp do número da INFINITY GAMES.
3. Anote: URL do WAHA, nome da sessão e a API key.

## 2. Novo serviço no Railway

1. Mesmo repositório GitHub, branch de produção (`main`).
2. Crie um **novo serviço** (ou novo projeto) chamado `recuperacao-infinity-games`.
3. **Adicione um volume** montado em `/data` — sem volume, todo redeploy apaga o banco.
4. Desative o "App Sleeping" (o agendador precisa rodar a cada minuto).
5. Gere um domínio público.

### Variáveis de ambiente

```
STORE_NAME=INFINITY GAMES
STORE_PROOF_URL=            # link de depoimentos/Instagram (opcional)
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=<senha forte>
WAHA_API_URL=<url do WAHA>
WAHA_SESSION=infinity
WAHA_API_KEY=<api key do WAHA>
```

`RAILWAY_VOLUME_MOUNT_PATH` é preenchida pelo Railway quando o volume é anexado.

## 3. Webhook na Bestfy (conta da INFINITY GAMES)

Em Configurações → Webhooks, cadastre:

```
https://<dominio-infinity>.up.railway.app/webhook/bestfy
```

Marque os eventos de transação (criada, pendente, aprovada/paga, recusada) e de checkout abandonado.
O endereço exato também aparece no painel, na tela de Configurações.

## 4. Ajustes no painel

Acesse `https://<dominio-infinity>` com o usuário e senha definidos e revise em **Configurações**:

- Mensagens de recuperação por etapa (contato, entrega, forma de pagamento, pagamento não concluído)
- **Mensagem de pagamento confirmado** — ajuste como a INFINITY GAMES entrega o acesso
- Mensagem de follow-up e o tempo (padrão 4h)
- Dados do WAHA (já vêm das variáveis de ambiente)

As mensagens padrão já usam o nome da loja; depois do primeiro boot elas ficam salvas no banco
e passam a ser editadas só pelo painel.

## 5. Teste

1. Faça um checkout de teste na loja e não pague → em ~25 min chega a mensagem de recuperação.
2. Pague um pedido de teste → chega a confirmação de pagamento e o carrinho aparece como recuperado.
3. Acompanhe em **Logs** e **Eventos de webhook** no painel.
