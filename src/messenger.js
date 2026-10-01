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
 * Set/update a setting value in the database
 */
function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value));
}

/**
 * Format a phone number to WhatsApp format (55XXXXXXXXXXX@c.us)
 */
function formatPhone(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (!cleaned.startsWith('55')) {
    cleaned = '55' + cleaned;
  }
  return cleaned + '@c.us';
}

/**
 * Parse Spintax text (e.g. "{Olá|Oi|Opa} {nome}!")
 * Tags like {nome}, {produtos}, {valor}, {link} are preserved because they don't contain '|'
 */
function parseSpintax(text) {
  if (!text) return '';
  const spintaxRegex = /\{([^{}|]+(?:\|[^{}|]+)+)\}/g;
  let prev = text;
  let parsed = text.replace(spintaxRegex, (match, options) => {
    const choices = options.split('|');
    return choices[Math.floor(Math.random() * choices.length)].trim();
  });

  // Handle possible nested spintax
  while (parsed !== prev) {
    prev = parsed;
    parsed = parsed.replace(spintaxRegex, (match, options) => {
      const choices = options.split('|');
      return choices[Math.floor(Math.random() * choices.length)].trim();
    });
  }

  return parsed;
}

/**
 * Auto-detect and resolve an active working WAHA session
 */
async function resolveWorkingSession(wahaUrl, apiKey, preferredSession) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;

  // First check if preferred session exists and is working
  try {
    const res = await axios.get(`${wahaUrl}/api/sessions`, { headers, timeout: 5000 });
    const sessions = res.data || [];
    
    if (Array.isArray(sessions) && sessions.length > 0) {
      // Find matching session if available
      const exact = sessions.find((s) => s.name === preferredSession && (s.status === 'WORKING' || s.status === 'STARTING'));
      if (exact) return exact.name;

      // Fallback: pick any session that is WORKING
      const working = sessions.find((s) => s.status === 'WORKING');
      if (working) {
        console.log(`[WAHA] Sessão ativa detectada: "${working.name}" (substituindo "${preferredSession}")`);
        setSetting('waha_session', working.name);
        return working.name;
      }
      
      // If none working, return the first one available
      return sessions[0].name || preferredSession;
    }
  } catch (err) {
    console.warn(`[WAHA] Aviso ao verificar sessões: ${err.message}`);
  }

  return preferredSession || 'default';
}

/**
 * Check if current time is within quiet hours (e.g. 23:00 to 08:00 BRT)
 * Protects WhatsApp number from user annoyance and spam reports.
 */
function isQuietHours() {
  const isEnabled = getSetting('quiet_hours_active');
  if (isEnabled === 'false') return false;

  const now = new Date();
  const brHourStr = now.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false });
  const brHour = parseInt(brHourStr, 10);

  const start = parseInt(getSetting('quiet_hours_start') || '23', 10);
  const end = parseInt(getSetting('quiet_hours_end') || '8', 10);

  if (start > end) {
    // Crosses midnight (e.g. 23h to 8h)
    return brHour >= start || brHour < end;
  } else {
    return brHour >= start && brHour < end;
  }
}

/**
 * Simulate human typing before sending message (Anti-Ban measure)
 */
async function simulateTyping(wahaUrl, session, apiKey, chatId, message) {
  const isTypingEnabled = getSetting('anti_ban_typing') !== 'false';
  if (!isTypingEnabled) return;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;

  // Typing duration between 2.5s and 5.5s with random jitter based on message length
  const durationMs = Math.min(5500, Math.max(2500, Math.floor(message.length * 18) + Math.floor(Math.random() * 1200)));

  try {
    await axios.post(
      `${wahaUrl}/api/startTyping`,
      { chatId, session },
      { headers, timeout: 6000 }
    );
    console.log(`[Anti-Ban] ✍️ Simulando digitação por ${(durationMs / 1000).toFixed(1)}s para ${chatId}...`);
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  } catch (err) {
    // Graceful fallback - never fail message delivery if typing endpoint errors
    console.warn(`[Anti-Ban] Aviso ao simular digitação: ${err.message}`);
  }
}

/**
 * Build the recovery message from template with Spintax
 */
function buildMessage(cart) {
  const rawTemplate = getSetting('recovery_message') || process.env.RECOVERY_MESSAGE || '';
  const template = parseSpintax(rawTemplate);

  let items = [];
  try {
    items = JSON.parse(cart.items_json);
  } catch (e) {
    items = [];
  }

  const productList = items
    .map((item) => {
      const title = item.title || item.name || item.productName || 'Produto';
      const qty = item.quantity || item.productQuantity || 1;
      const priceCents = item.priceInCents || item.productPriceInCents || item.unitPrice || 0;
      const price = (priceCents / 100).toFixed(2).replace('.', ',');
      return `  • ${title} (${qty}x) - R$ ${price}`;
    })
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
 * Build payment confirmed message with Spintax
 */
function buildPaidMessage(cart) {
  const rawTemplate = getSetting('paid_message') || process.env.PAID_MESSAGE || '';
  const template = parseSpintax(rawTemplate);

  let items = [];
  try {
    items = JSON.parse(cart.items_json);
  } catch (e) {
    items = [];
  }

  const productList = items
    .map((item) => {
      const title = item.title || item.name || item.productName || 'Produto';
      const qty = item.quantity || item.productQuantity || 1;
      const priceCents = item.priceInCents || item.productPriceInCents || item.unitPrice || 0;
      const price = (priceCents / 100).toFixed(2).replace('.', ',');
      return `  • ${title} (${qty}x) - R$ ${price}`;
    })
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
 * Send a WhatsApp message via WAHA with full anti-ban protections
 */
async function sendWhatsAppMessage(phone, message) {
  const wahaUrl = getSetting('waha_api_url') || process.env.WAHA_API_URL;
  const configuredSession = getSetting('waha_session') || process.env.WAHA_SESSION || 'default';
  const apiKey = getSetting('waha_api_key') || process.env.WAHA_API_KEY;

  // Resolve active session
  const session = await resolveWorkingSession(wahaUrl, apiKey, configuredSession);
  const chatId = formatPhone(phone);

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['X-Api-Key'] = apiKey;
  }

  // 1. Anti-Ban: Simulate human typing indicator
  await simulateTyping(wahaUrl, session, apiKey, chatId, message);

  // 2. Send the message text
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

    // Stop typing indicator (fire-and-forget)
    axios.post(`${wahaUrl}/api/stopTyping`, { chatId, session }, { headers, timeout: 4000 }).catch(() => {});

    return { success: true, data: response.data };
  } catch (error) {
    const errorMsg = error.response
      ? JSON.stringify(error.response.data)
      : error.message;

    console.error(`[WAHA] Erro ao enviar mensagem para ${phone}:`, errorMsg);

    // Try to stop typing even on error
    axios.post(`${wahaUrl}/api/stopTyping`, { chatId, session }, { headers, timeout: 4000 }).catch(() => {});

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
 * Check and process all pending carts that are due with human jitter delays
 */
async function processPendingCarts() {
  const isActive = getSetting('active');
  if (isActive !== 'true') {
    return;
  }

  // Anti-Ban: Check quiet hours (e.g. 23:00 - 08:00)
  if (isQuietHours()) {
    console.log('[Anti-Ban] 🌙 Horário de silêncio ativo. Disparos de carrinho pausados durante a noite para evitar denúncias de spam.');
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

  const minDelaySec = parseInt(getSetting('anti_ban_delay_min') || '8', 10);
  const maxDelaySec = parseInt(getSetting('anti_ban_delay_max') || '18', 10);

  for (let i = 0; i < pendingCarts.length; i++) {
    const cart = pendingCarts[i];
    await processCart(cart);

    // If more carts remain in batch, apply human random delay between messages
    if (i < pendingCarts.length - 1) {
      const jitterMs = Math.floor(Math.random() * ((maxDelaySec - minDelaySec) * 1000 + 1)) + (minDelaySec * 1000);
      console.log(`[Anti-Ban] ⏳ Aguardando delay humano de ${(jitterMs / 1000).toFixed(1)}s antes do próximo envio...`);
      await new Promise((resolve) => setTimeout(resolve, jitterMs));
    }
  }
}

/**
 * Send WhatsApp payment confirmation message
 */
async function sendPaymentConfirmation(cart) {
  const isEnabled = getSetting('paid_message_active');
  if (isEnabled === 'false') {
    console.log('[Confirmação] Envio de pagamento desativado nas configurações.');
    return { skipped: true, reason: 'Disabled in settings' };
  }

  if (!cart.customer_phone) {
    console.log('[Confirmação] Sem telefone do cliente para enviar confirmação.');
    return { skipped: true, reason: 'No phone' };
  }

  console.log(`[Confirmação de Pagamento] Enviando para #${cart.id} - ${cart.customer_name} (${cart.customer_phone})`);

  const message = buildPaidMessage(cart);
  const result = await sendWhatsAppMessage(cart.customer_phone, message);

  // Log in message_log
  try {
    db.prepare(`
      INSERT INTO message_log (cart_id, phone, message, status, error_message, waha_response)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      cart.id,
      cart.customer_phone,
      message,
      result.success ? 'sent' : 'failed',
      result.success ? null : result.error,
      result.success ? JSON.stringify(result.data) : null
    );
  } catch (e) {
    console.error('[Confirmação] Erro ao gravar log de confirmação:', e.message);
  }

  return result;
}

module.exports = {
  sendWhatsAppMessage,
  processCart,
  processPendingCarts,
  buildMessage,
  buildPaidMessage,
  sendPaymentConfirmation,
  formatPhone,
  getSetting,
  setSetting,
  parseSpintax,
  isQuietHours,
  resolveWorkingSession,
};
