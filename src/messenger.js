const axios = require('axios');
const db = require('./database');

/**
 * Get a setting value from the database
 */
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * Format a phone number to WhatsApp format (55XXXXXXXXXXX@c.us)
 */
function formatPhone(phone) {
  // Remove everything that's not a digit
  let cleaned = phone.replace(/\D/g, '');

  // Add Brazil country code if not present
  if (!cleaned.startsWith('55')) {
    cleaned = '55' + cleaned;
  }

  // Ensure we have the right format
  return cleaned + '@c.us';
}

/**
 * Build the recovery message from the template
 */
function buildMessage(cart) {
  const template = getSetting('recovery_message') || process.env.RECOVERY_MESSAGE || '';
  const items = JSON.parse(cart.items_json);

  const productList = items
    .map((item) => `  • ${item.title} (${item.quantity}x) - R$ ${(item.unitPrice / 100).toFixed(2)}`)
    .join('\n');

  const totalAmount = (cart.amount / 100).toFixed(2).replace('.', ',');
  const firstName = cart.customer_name ? cart.customer_name.split(' ')[0] : 'cliente';

  return template
    .replace(/\{nome\}/g, firstName)
    .replace(/\{produtos\}/g, productList)
    .replace(/\{valor\}/g, totalAmount)
    .replace(/\{link\}/g, cart.secure_url || '');
}

/**
 * Send a WhatsApp message via WAHA
 */
async function sendWhatsAppMessage(phone, message) {
  const wahaUrl = getSetting('waha_api_url') || process.env.WAHA_API_URL;
  const session = getSetting('waha_session') || process.env.WAHA_SESSION || 'default';
  const apiKey = getSetting('waha_api_key') || process.env.WAHA_API_KEY;

  const chatId = formatPhone(phone);

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['X-Api-Key'] = apiKey;
  }

  try {
    const response = await axios.post(
      `${wahaUrl}/api/sendText`,
      {
        chatId,
        text: message,
        session,
      },
      { headers, timeout: 15000 }
    );

    return { success: true, data: response.data };
  } catch (error) {
    const errorMsg = error.response
      ? JSON.stringify(error.response.data)
      : error.message;

    console.error(`[WAHA] Erro ao enviar mensagem para ${phone}:`, errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Process a single abandoned cart - send recovery message
 */
async function processCart(cart) {
  console.log(`[Processando] Carrinho #${cart.id} - ${cart.customer_name} (${cart.customer_phone})`);

  const message = buildMessage(cart);
  const result = await sendWhatsAppMessage(cart.customer_phone, message);

  // Log the message
  const logStmt = db.prepare(`
    INSERT INTO message_log (cart_id, phone, message, status, error_message, waha_response)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  logStmt.run(
    cart.id,
    cart.customer_phone,
    message,
    result.success ? 'sent' : 'failed',
    result.success ? null : result.error,
    result.success ? JSON.stringify(result.data) : null
  );

  // Update cart status
  const updateStmt = db.prepare(`
    UPDATE abandoned_carts
    SET message_sent = 1,
        message_sent_at = datetime('now'),
        status = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `);

  updateStmt.run(result.success ? 'sent' : 'failed', cart.id);

  if (result.success) {
    console.log(`[✓] Mensagem enviada com sucesso para ${cart.customer_phone}`);
  } else {
    console.log(`[✗] Falha ao enviar mensagem para ${cart.customer_phone}: ${result.error}`);
  }

  return result;
}

/**
 * Check and process all pending carts that are due
 */
async function processPendingCarts() {
  const isActive = getSetting('active');
  if (isActive !== 'true') {
    return;
  }

  const pendingCarts = db.prepare(`
    SELECT * FROM abandoned_carts
    WHERE status = 'pending'
      AND message_sent = 0
      AND recovered = 0
      AND datetime(scheduled_at) <= datetime('now')
    ORDER BY scheduled_at ASC
  `).all();

  if (pendingCarts.length > 0) {
    console.log(`[Scheduler] ${pendingCarts.length} carrinho(s) pendente(s) para processar`);
  }

  for (const cart of pendingCarts) {
    await processCart(cart);
    // Small delay between messages to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

module.exports = {
  sendWhatsAppMessage,
  processCart,
  processPendingCarts,
  buildMessage,
  formatPhone,
  getSetting,
};
