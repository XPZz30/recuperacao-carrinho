const express = require('express');
const db = require('./database');
const { getSetting } = require('./messenger');

const router = express.Router();

/**
 * POST /webhook/bestfy
 *
 * Receives postback events from Bestfy.
 * Detects abandoned carts based on transaction status:
 * - 'waiting_payment' -> pix/boleto not paid
 * - 'processing' -> card processing
 * - 'refused' -> card refused
 *
 * When a checkout/transaction is created with one of these statuses,
 * we schedule a recovery message.
 *
 * When a transaction becomes 'paid', we mark it as recovered.
 */
// Accept both '/' and '/bestfy'
router.post(['/', '/bestfy'], (req, res) => {
  try {
    const payload = req.body || {};
    const type = (payload.type || payload.event || '').toLowerCase();
    const objectId = payload.objectId || (payload.data && payload.data.id) || payload.id || 'N/A';
    console.log(`[Webhook] Postback recebido - Rota: "${req.originalUrl}", Tipo/Evento: "${type}", ID: ${objectId}`);

    // Log raw incoming webhook to DB for diagnostics
    try {
      db.prepare(`
        INSERT INTO webhook_events (path, method, payload_json)
        VALUES (?, ?, ?)
      `).run(req.originalUrl || req.url, req.method, JSON.stringify(payload));
    } catch (e) {
      console.error('[Webhook] Falha ao registrar evento bruto:', e.message);
    }

    if (type.includes('transaction') || type.includes('transacao') || type.includes('transação')) {
      handleTransactionPostback(payload);
    } else if (type.includes('checkout') || type.includes('cart') || type.includes('carrinho') || type.includes('abandoned')) {
      handleCheckoutPostback(payload);
    } else {
      // Fallback heuristic based on data structure
      if (payload.data && payload.data.status && !payload.data.items) {
        handleTransactionPostback(payload);
      } else if (payload.data && (payload.data.customer || payload.data.items)) {
        handleCheckoutPostback(payload);
      } else if (payload.status) {
        handleTransactionPostback({ data: payload });
      } else if (payload.transaction) {
        handleTransactionPostback({ data: payload.transaction });
      } else {
        console.log('[Webhook] Estrutura genérica recebida, tentando processar como carrinho:', JSON.stringify(payload).slice(0, 200));
        handleCheckoutPostback(payload);
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[Webhook] Erro ao processar postback:', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

/**
 * Extract phone from any common field name
 */
function extractPhone(customer, fallbackObj = null) {
  if (customer && typeof customer === 'object') {
    const p = customer.phone || customer.cellphone || customer.telephone || customer.mobile || customer.whatsapp || customer.phone_number || customer.contact;
    if (p) return String(p);
  }
  if (fallbackObj && typeof fallbackObj === 'object') {
    const p = fallbackObj.phone || fallbackObj.cellphone || fallbackObj.telephone || fallbackObj.mobile || fallbackObj.whatsapp;
    if (p) return String(p);
  }
  return null;
}

/**
 * Extract customer from any common field name
 */
function extractCustomer(obj) {
  if (!obj) return {};
  return obj.customer || obj.buyer || obj.client || obj.payer || obj;
}

/**
 * Extract amount in cents from object or calculate by summing items
 */
function extractAmount(obj, items = []) {
  if (!obj && (!items || items.length === 0)) return 0;

  let raw = obj ? (obj.totalAmountInCents || obj.amountInCents || obj.amount || obj.total || obj.value || obj.totalAmount) : 0;

  if (typeof raw === 'string') {
    raw = parseFloat(raw.replace(/[^\d.,]/g, '').replace(',', '.'));
  }

  const effectiveItems = (items && items.length > 0) ? items : (obj && (obj.cartItems || obj.items || obj.products) || []);

  if ((!raw || Number(raw) === 0) && Array.isArray(effectiveItems) && effectiveItems.length > 0) {
    raw = effectiveItems.reduce((sum, item) => {
      const price = item.productPriceInCents || item.priceInCents || item.unitPriceInCents || item.price || item.unitPrice || 0;
      const qty = item.productQuantity || item.quantity || 1;
      const priceCents = (Number(price) < 1000 && String(price).includes('.')) ? Math.round(Number(price) * 100) : Number(price);
      return sum + (priceCents * Number(qty));
    }, 0);
  }

  return Math.round(Number(raw) || 0);
}

/**
 * Handle a transaction postback from Bestfy
 */
function handleTransactionPostback(payload) {
  const tx = payload.data || payload;
  if (!tx) return;

  const status = (tx.status || '').toLowerCase().trim();
  const txId = String(tx.id || tx.transactionId || tx.financialTransactionId || tx.orderId || Date.now());

  // If the transaction was paid, mark it as recovered
  if (status === 'paid' || status === 'approved' || status === 'completed' || status === 'success') {
    markAsRecovered(txId, tx);
    return;
  }

  // If the transaction is in a "pending", "expired", "refused" or "unpaid" state, schedule recovery
  const pendingStatuses = [
    'waiting_payment', 'processing', 'refused', 'failed', 'pending',
    'unpaid', 'awaiting_payment', 'not_paid', 'created', 'authorized',
    'expired', 'canceled', 'cancelled'
  ];
  if (pendingStatuses.includes(status) || !status) {
    scheduleRecovery(tx, 'transaction');
  }
}

/**
 * Handle a checkout or abandoned cart postback from Bestfy
 */
function handleCheckoutPostback(payload) {
  const checkout = payload.data || payload;
  if (!checkout) return;

  const tx = checkout.transaction;

  // Check if checkout or transaction is paid / completed
  const step = String(checkout.step || '').toUpperCase().trim();
  const status = String(checkout.status || (tx && tx.status) || '').toLowerCase().trim();

  // Explicit check: if step/status indicates uncompleted, expired, refused or cancelled payment
  const isUnpaid = 
    step.includes('NOT') || 
    step.includes('REFUSED') || 
    step.includes('FAILED') ||
    step.includes('EXPIRED') ||
    step.includes('CANCEL') ||
    step === 'WAITING_PAYMENT' ||
    step === 'PENDING' ||
    step === 'UNPAID' ||
    status === 'expired' ||
    status === 'canceled' ||
    status === 'cancelled' ||
    status === 'refused' ||
    status === 'failed' ||
    status === 'waiting_payment' ||
    status === 'pending' ||
    status === 'unpaid';

  // Strict check: only consider paid if NOT unpaid and explicitly matches paid status
  const isPaid = !isUnpaid && (
    status === 'paid' || 
    status === 'approved' || 
    status === 'completed' || 
    status === 'success' ||
    step === 'PAYMENT_COMPLETED' ||
    step === 'PURCHASE_COMPLETED' ||
    step === 'ORDER_COMPLETED' ||
    step === 'PAID' ||
    step === 'APPROVED' ||
    (Boolean(checkout.recoveredAt) && String(checkout.recoveredAt).toLowerCase() !== 'null')
  );

  if (isPaid) {
    const cartId = String(
      checkout.abandonedCartId ||
      checkout.checkoutSessionId ||
      checkout.financialTransactionId ||
      (tx && (tx.id || tx.transactionId)) ||
      checkout.id ||
      checkout.cartToken ||
      `cart_${Date.now()}`
    );
    markAsRecovered(cartId, checkout);
    return;
  }

  // If there's an unpaid transaction associated with the checkout
  if (tx) {
    scheduleRecovery(tx, 'checkout', checkout);
    return;
  }

  // Pure abandoned cart (customer left before creating transaction)
  const customer = extractCustomer(checkout);
  const phone = extractPhone(customer, checkout);

  if (!phone) {
    console.log(`[Webhook] Carrinho ${checkout.id || ''} sem telefone do cliente, ignorando.`);
    return;
  }

  const cartId = String(checkout.abandonedCartId || checkout.id || checkout.checkoutId || `cart_${Date.now()}`);
  const existing = db.prepare('SELECT id, status FROM abandoned_carts WHERE checkout_id = ? OR transaction_id = ?').get(cartId, cartId);
  if (existing) {
    console.log(`[Webhook] Carrinho ${cartId} já cadastrado (status: ${existing.status})`);
    return;
  }

  const delayMinutes = parseInt(getSetting('recovery_delay_minutes') || process.env.RECOVERY_DELAY_MINUTES || '30');
  const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
  const secureUrl = checkout.recoveryUrl || checkout.secureUrl || checkout.url || checkout.checkoutUrl || '';
  const items = checkout.items || checkout.cartItems || checkout.products || [];
  const amount = extractAmount(checkout, items);

  const stmt = db.prepare(`
    INSERT INTO abandoned_carts (
      transaction_id, checkout_id, customer_name, customer_email,
      customer_phone, amount, items_json, secure_url,
      status, payment_status, scheduled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'abandoned', ?)
  `);

  stmt.run(
    cartId,
    cartId,
    customer.name || customer.fullName || 'Cliente',
    customer.email || '',
    phone,
    amount,
    JSON.stringify(items),
    secureUrl,
    scheduledAt
  );

  console.log(`[Webhook] ✓ Carrinho abandonado agendado para recuperação em ${delayMinutes}min - Cliente: ${customer.name || 'Cliente'} (${phone})`);
}

/**
 * Schedule a recovery message for an abandoned cart
 */
function scheduleRecovery(tx, type, checkout = null) {
  const customer = extractCustomer(tx) || extractCustomer(checkout);
  const phone = extractPhone(customer, tx) || extractPhone(checkout);

  if (!phone) {
    console.log(`[Webhook] Transação ${tx.id || ''} sem telefone do cliente, ignorando.`);
    return;
  }

  const txId = String(tx.id || tx.transactionId || Date.now());
  const items = tx.items || tx.cartItems || (checkout ? (checkout.items || checkout.cartItems || checkout.products) : []) || [];
  const amount = extractAmount(tx, items) || (checkout ? extractAmount(checkout, items) : 0);

  // Check if we already have this cart
  const existing = db.prepare('SELECT id, status, amount FROM abandoned_carts WHERE transaction_id = ?').get(txId);
  if (existing) {
    if (existing.status === 'sent' || existing.status === 'recovered') {
      console.log(`[Webhook] Transação ${txId} já processada (status: ${existing.status})`);
      return;
    }
    const updateAmount = (!existing.amount || existing.amount === 0) && amount > 0;
    db.prepare(`
      UPDATE abandoned_carts 
      SET payment_status = ?, 
          amount = CASE WHEN ? > 0 THEN ? ELSE amount END,
          items_json = CASE WHEN ? = 1 THEN ? ELSE items_json END,
          updated_at = datetime('now') 
      WHERE id = ?
    `).run(
      tx.status || 'pending',
      updateAmount ? amount : 0,
      amount,
      updateAmount ? 1 : 0,
      JSON.stringify(items),
      existing.id
    );
    console.log(`[Webhook] Transação ${txId} atualizada para status: ${tx.status}`);
    return;
  }

  const delayMinutes = parseInt(getSetting('recovery_delay_minutes') || process.env.RECOVERY_DELAY_MINUTES || '30');
  const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();

  let secureUrl = tx.secureUrl || tx.url || tx.pixQrCodeUrl || tx.paymentUrl || '';
  if (checkout && (checkout.secureUrl || checkout.recoveryUrl || checkout.url)) {
    secureUrl = checkout.secureUrl || checkout.recoveryUrl || checkout.url;
  }

  const stmt = db.prepare(`
    INSERT INTO abandoned_carts (
      transaction_id, checkout_id, customer_name, customer_email,
      customer_phone, amount, items_json, secure_url,
      status, payment_status, scheduled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `);

  stmt.run(
    txId,
    checkout ? String(checkout.id || checkout.checkoutId) : null,
    customer.name || customer.fullName || 'Cliente',
    customer.email || '',
    phone,
    amount,
    JSON.stringify(items),
    secureUrl,
    tx.status || 'waiting_payment',
    scheduledAt
  );

  console.log(`[Webhook] ✓ Transação ${txId} agendada para recuperação em ${delayMinutes}min - Cliente: ${customer.name || 'Cliente'} (${phone})`);
}

/**
 * Mark a transaction as recovered (paid) and trigger WhatsApp payment confirmation
 */
async function markAsRecovered(txId, tx = null) {
  // Safety guard: reject if the object explicitly indicates an unpaid, cancelled, or expired state
  if (tx) {
    const txStatus = String(tx.status || '').toLowerCase().trim();
    const txStep = String(tx.step || '').toUpperCase().trim();
    const isUnpaid = 
      txStep.includes('NOT') || 
      txStep.includes('REFUSED') || 
      txStep.includes('FAILED') ||
      txStep.includes('EXPIRED') ||
      txStep.includes('CANCEL') ||
      txStep === 'WAITING_PAYMENT' ||
      txStep === 'PENDING' ||
      txStep === 'UNPAID' ||
      txStatus === 'expired' ||
      txStatus === 'canceled' ||
      txStatus === 'cancelled' ||
      txStatus === 'refused' ||
      txStatus === 'failed' ||
      txStatus === 'waiting_payment' ||
      txStatus === 'pending' ||
      txStatus === 'unpaid';

    if (isUnpaid) {
      console.warn(`[Webhook] Bloqueado: tentativa de marcar como pago um pedido não pago (status="${txStatus}", step="${txStep}")`);
      return;
    }
  }

  const candidates = [
    txId,
    tx && tx.abandonedCartId,
    tx && tx.checkoutSessionId,
    tx && tx.financialTransactionId,
    tx && tx.cartToken,
    tx && tx.id,
    tx && tx.transactionId,
    tx && tx.orderId,
  ].filter(Boolean);

  let cart = null;
  for (const id of candidates) {
    cart = db.prepare('SELECT * FROM abandoned_carts WHERE transaction_id = ? OR checkout_id = ?').get(String(id), String(id));
    if (cart) break;
  }

  // Fallback: match by customer phone if there is a pending cart
  if (!cart && tx) {
    const customer = extractCustomer(tx);
    const phone = extractPhone(customer, tx);
    if (phone) {
      const cleanPhone = phone.replace(/\D/g, '');
      if (cleanPhone.length >= 8) {
        cart = db.prepare(`
          SELECT * FROM abandoned_carts 
          WHERE (customer_phone LIKE ? OR customer_phone LIKE ?)
            AND status = 'pending'
          ORDER BY created_at DESC LIMIT 1
        `).get(`%${cleanPhone}%`, `%${cleanPhone.slice(-8)}%`);
      }
    }
  }

  const items = (tx && (tx.items || tx.cartItems || tx.products)) || [];
  const amount = extractAmount(tx, items);

  if (cart) {
    const updateAmount = (!cart.amount || cart.amount === 0) && amount > 0;
    const updateItems = (!cart.items_json || cart.items_json === '[]') && items.length > 0;

    db.prepare(`
      UPDATE abandoned_carts
      SET recovered = 1,
          recovered_at = datetime('now'),
          status = 'recovered',
          payment_status = 'paid',
          amount = CASE WHEN ? > 0 THEN ? ELSE amount END,
          items_json = CASE WHEN ? = 1 THEN ? ELSE items_json END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      updateAmount ? amount : 0,
      amount,
      updateItems ? 1 : 0,
      JSON.stringify(items),
      cart.id
    );

    cart = db.prepare('SELECT * FROM abandoned_carts WHERE id = ?').get(cart.id);
  } else if (tx) {
    // Direct purchase without prior abandonment
    const customer = extractCustomer(tx);
    const phone = extractPhone(customer, tx);
    const secureUrl = tx.recoveryUrl || tx.secureUrl || tx.url || '';

    const stmt = db.prepare(`
      INSERT INTO abandoned_carts (
        transaction_id, checkout_id, customer_name, customer_email,
        customer_phone, amount, items_json, secure_url,
        status, payment_status, scheduled_at, recovered, recovered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recovered', 'paid', datetime('now'), 1, datetime('now'))
    `);

    const info = stmt.run(
      txId,
      tx.checkoutSessionId || tx.checkoutId || null,
      customer.name || customer.fullName || 'Cliente',
      customer.email || '',
      phone || '',
      amount,
      JSON.stringify(items),
      secureUrl
    );

    cart = db.prepare('SELECT * FROM abandoned_carts WHERE id = ?').get(info.lastInsertRowid);
  }

  console.log(`[Webhook] 🎉 Transação ${txId} PAGA / RECUPERADA!`);

  // Send WhatsApp payment confirmation
  if (cart && cart.customer_phone) {
    try {
      const alreadySent = db.prepare(`
        SELECT id FROM message_log 
        WHERE cart_id = ? AND (message LIKE '%confirmado%' OR message LIKE '%Muito obrigado%')
      `).get(cart.id);

      if (!alreadySent) {
        const { sendPaymentConfirmation } = require('./messenger');
        const sendResult = await sendPaymentConfirmation(cart);
        console.log(`[Webhook] Confirmação de pagamento enviada para ${cart.customer_phone}:`, sendResult.success ? '✓ Sucesso' : '✗ Falhou');
      } else {
        console.log(`[Webhook] Confirmação de pagamento já enviada para o carrinho #${cart.id}.`);
      }
    } catch (err) {
      console.error('[Webhook] Erro ao enviar mensagem de pagamento confirmado:', err.message);
    }
  }
}

module.exports = router;
