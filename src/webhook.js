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
router.post('/bestfy', (req, res) => {
  try {
    const payload = req.body || {};
    const type = (payload.type || payload.event || '').toLowerCase();
    const objectId = payload.objectId || (payload.data && payload.data.id) || payload.id || 'N/A';
    console.log(`[Webhook] Postback recebido - Tipo/Evento: "${type}", ID: ${objectId}`);

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
      } else {
        console.log('[Webhook] Estrutura genérica recebida:', JSON.stringify(payload).slice(0, 200));
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[Webhook] Erro ao processar postback:', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

/**
 * Handle a transaction postback from Bestfy
 */
function handleTransactionPostback(payload) {
  const tx = payload.data || payload;
  if (!tx) return;

  const status = tx.status;
  const txId = String(tx.id);

  // If the transaction was paid, mark it as recovered
  if (status === 'paid' || status === 'approved') {
    markAsRecovered(txId);
    return;
  }

  // If the transaction is in a "pending" state, schedule recovery
  const pendingStatuses = ['waiting_payment', 'processing', 'refused', 'failed', 'pending'];
  if (pendingStatuses.includes(status)) {
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

  // If there's a transaction associated with the checkout
  if (tx) {
    if (tx.status === 'paid' || tx.status === 'approved') {
      markAsRecovered(String(tx.id));
      return;
    }

    const pendingStatuses = ['waiting_payment', 'processing', 'refused', 'failed', 'pending'];
    if (pendingStatuses.includes(tx.status)) {
      scheduleRecovery(tx, 'checkout', checkout);
    }
    return;
  }

  // Pure abandoned cart (customer left before creating transaction)
  const customer = checkout.customer || checkout.buyer;
  if (!customer || !customer.phone) {
    console.log(`[Webhook] Carrinho ${checkout.id || ''} sem telefone do cliente, ignorando.`);
    return;
  }

  const cartId = String(checkout.id || checkout.checkoutId || `cart_${Date.now()}`);
  const existing = db.prepare('SELECT id, status FROM abandoned_carts WHERE checkout_id = ? OR transaction_id = ?').get(cartId, cartId);
  if (existing) {
    console.log(`[Webhook] Carrinho ${cartId} já cadastrado (status: ${existing.status})`);
    return;
  }

  const delayMinutes = parseInt(getSetting('recovery_delay_minutes') || process.env.RECOVERY_DELAY_MINUTES || '30');
  const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
  const secureUrl = checkout.secureUrl || checkout.recoveryUrl || checkout.url || '';
  const items = checkout.items || [];
  const amount = checkout.amount || checkout.total || 0;

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
    customer.name || 'Cliente',
    customer.email || '',
    customer.phone,
    amount,
    JSON.stringify(items),
    secureUrl,
    scheduledAt
  );

  console.log(`[Webhook] ✓ Carrinho abandonado agendado para recuperação em ${delayMinutes}min - Cliente: ${customer.name} (${customer.phone})`);
}

/**
 * Schedule a recovery message for an abandoned cart
 */
function scheduleRecovery(tx, type, checkout = null) {
  const customer = tx.customer;
  if (!customer || !customer.phone) {
    console.log(`[Webhook] Transação ${tx.id} sem telefone do cliente, ignorando.`);
    return;
  }

  const txId = String(tx.id);

  // Check if we already have this cart
  const existing = db.prepare('SELECT id, status FROM abandoned_carts WHERE transaction_id = ?').get(txId);
  if (existing) {
    // Update status if needed
    if (existing.status === 'sent' || existing.status === 'recovered') {
      console.log(`[Webhook] Transação ${txId} já processada (status: ${existing.status})`);
      return;
    }
    // Update the payment status
    db.prepare('UPDATE abandoned_carts SET payment_status = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(tx.status, existing.id);
    console.log(`[Webhook] Transação ${txId} atualizada para status: ${tx.status}`);
    return;
  }

  // Calculate scheduled time for recovery message
  const delayMinutes = parseInt(getSetting('recovery_delay_minutes') || process.env.RECOVERY_DELAY_MINUTES || '30');
  const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();

  // Get the best URL for the customer to complete payment
  let secureUrl = tx.secureUrl || '';
  if (checkout && checkout.secureUrl) {
    secureUrl = checkout.secureUrl;
  }

  const items = tx.items || (checkout ? checkout.items : []) || [];

  const stmt = db.prepare(`
    INSERT INTO abandoned_carts (
      transaction_id, checkout_id, customer_name, customer_email,
      customer_phone, amount, items_json, secure_url,
      status, payment_status, scheduled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `);

  stmt.run(
    txId,
    checkout ? String(checkout.id) : null,
    customer.name || 'Cliente',
    customer.email || '',
    customer.phone,
    tx.amount,
    JSON.stringify(items),
    secureUrl,
    tx.status,
    scheduledAt
  );

  console.log(`[Webhook] ✓ Carrinho agendado para recuperação em ${delayMinutes}min - Cliente: ${customer.name} (${customer.phone})`);
}

/**
 * Mark a transaction as recovered (paid)
 */
function markAsRecovered(txId) {
  const cart = db.prepare('SELECT id, status FROM abandoned_carts WHERE transaction_id = ?').get(txId);
  if (!cart) return;

  db.prepare(`
    UPDATE abandoned_carts
    SET recovered = 1,
        recovered_at = datetime('now'),
        status = 'recovered',
        updated_at = datetime('now')
    WHERE id = ?
  `).run(cart.id);

  console.log(`[Webhook] 🎉 Transação ${txId} RECUPERADA! Pagamento confirmado.`);
}

module.exports = router;
