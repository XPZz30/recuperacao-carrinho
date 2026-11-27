const axios = require('axios');
const db = require('./database');
const { getCleanPhone, isSameCustomerPhone, isSameOrder, CHECKOUT_STAGES } = require('./utils');

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

// ============================================================
// Send pacing (anti-ban): every message starts or continues a chat with a
// customer who never saved our number, so volume and rhythm are what get the
// number restricted. All sends share one budget: at most 1 message per cron
// tick, a random gap between messages, and hourly/daily caps.
// ============================================================

function intSetting(key, fallback) {
  const n = parseInt(getSetting(key), 10);
  return Number.isNaN(n) ? fallback : n;
}

function floatSetting(key, fallback) {
  const n = parseFloat(getSetting(key));
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Messages actually delivered in the last hour and since midnight (Brasília, UTC-3)
 */
function countRecentSends() {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM message_log
        WHERE status = 'sent' AND sent_at >= datetime('now', '-1 hour')) AS hour,
      (SELECT COUNT(*) FROM message_log
        WHERE status = 'sent' AND sent_at >= datetime('now', '-3 hours', 'start of day', '+3 hours')) AS day
  `).get();
  return { hour: row.hour || 0, day: row.day || 0 };
}

/**
 * Whether a new message may be sent right now. Returns { ok, reason }.
 */
function getSendBudget() {
  const paused = getSetting('auto_pause_reason');
  if (paused) return { ok: false, reason: `pausado automaticamente: ${paused}` };

  const nextAt = intSetting('send_next_at', 0);
  if (Date.now() < nextAt) {
    return { ok: false, reason: `aguardando intervalo (${Math.ceil((nextAt - Date.now()) / 1000)}s)` };
  }

  const perHour = intSetting('send_limit_per_hour', 6);
  const perDay = intSetting('send_limit_per_day', 40);
  const sent = countRecentSends();
  if (sent.day >= perDay) return { ok: false, reason: `limite diário atingido (${sent.day}/${perDay})` };
  if (sent.hour >= perHour) return { ok: false, reason: `limite por hora atingido (${sent.hour}/${perHour})` };

  return { ok: true };
}

/**
 * Push the next allowed send to a random moment between the configured min and max gap
 */
function scheduleNextSend() {
  const minMin = Math.max(0.5, floatSetting('send_gap_min_minutes', 2));
  const maxMin = Math.max(minMin, floatSetting('send_gap_max_minutes', 5));
  const gapMs = (minMin + Math.random() * (maxMin - minMin)) * 60 * 1000;
  setSetting('send_next_at', String(Date.now() + Math.floor(gapMs)));
}

// Errors that mean WhatsApp itself is refusing us: stop everything at once
const RESTRICTION_ERROR = /restrict|banned|spam|forbidden|not.?authori[sz]ed|blocked|bloquead/i;
const MAX_FAILURE_STREAK = 3;

/**
 * Stop all sending until someone turns the system back on in the dashboard
 */
function autoPause(reason) {
  const stamped = `${reason} (${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })})`;
  setSetting('auto_pause_reason', stamped);
  setSetting('active', 'false');
  console.warn(`[Anti-Ban] ⛔ ENVIOS PAUSADOS AUTOMATICAMENTE: ${stamped}. Reative no painel depois de verificar o número.`);
}

/**
 * Track consecutive delivery failures and pause on a restriction or a failure streak
 */
function recordSendOutcome(result) {
  if (result.success) {
    setSetting('send_failure_streak', '0');
    return;
  }
  // A customer without WhatsApp says nothing about our number's health
  if (/não possui WhatsApp/i.test(String(result.error))) return;

  if (RESTRICTION_ERROR.test(String(result.error))) {
    autoPause(`WhatsApp recusou o envio: ${String(result.error).slice(0, 200)}`);
    return;
  }

  const streak = intSetting('send_failure_streak', 0) + 1;
  setSetting('send_failure_streak', String(streak));
  if (streak >= MAX_FAILURE_STREAK) {
    autoPause(`${streak} falhas de envio seguidas. Última: ${String(result.error).slice(0, 200)}`);
  }
}

/**
 * Format a phone number to WhatsApp format (55XXXXXXXXXXX@c.us)
 */
function formatPhone(phone) {
  let cleaned = String(phone || '').replace(/\D/g, '');
  if (!cleaned) return '';
  if (!cleaned.startsWith('55') && cleaned.length >= 10 && cleaned.length <= 11) {
    cleaned = '55' + cleaned;
  }
  return cleaned + '@c.us';
}

/**
 * Resolve the real canonical WhatsApp chatId (JID) via WAHA check-exists.
 * Fixes Brazilian 9th digit discrepancies where WhatsApp registered the account
 * with or without the 9th digit (e.g. 557197434028@c.us vs 5571997434028@c.us).
 */
async function resolveChatId(phone, wahaUrl, session, apiKey) {
  const fallback = formatPhone(phone);
  if (!phone) return { chatId: fallback, exists: false };

  let cleaned = String(phone).replace(/\D/g, '');
  if (!cleaned.startsWith('55') && cleaned.length >= 10 && cleaned.length <= 11) {
    cleaned = '55' + cleaned;
  }

  const reqHeaders = { 'Content-Type': 'application/json' };
  if (apiKey) reqHeaders['X-Api-Key'] = apiKey;

  try {
    const res = await axios.get(`${wahaUrl}/api/contacts/check-exists`, {
      headers: reqHeaders,
      params: { session, phone: cleaned },
      timeout: 6000,
    });

    if (res.data && res.data.numberExists && res.data.chatId) {
      if (res.data.chatId !== fallback) {
        console.log(`[WAHA] JID canônico resolvido para ${phone}: "${res.data.chatId}" (era "${fallback}")`);
      }
      return { chatId: res.data.chatId, exists: true };
    }

    // If not found and it's a Brazilian mobile (55 + 2 DDD + 9 digits = 13 digits)
    // Try without the 9th digit (55 + 2 DDD + 8 digits = 12 digits)
    if (cleaned.startsWith('55') && cleaned.length === 13) {
      const without9 = cleaned.slice(0, 4) + cleaned.slice(5);
      const resAlt = await axios.get(`${wahaUrl}/api/contacts/check-exists`, {
        headers: reqHeaders,
        params: { session, phone: without9 },
        timeout: 6000,
      });
      if (resAlt.data && resAlt.data.numberExists && resAlt.data.chatId) {
        console.log(`[WAHA] JID canônico resolvido alternando 9º dígito (${without9}): "${resAlt.data.chatId}"`);
        return { chatId: resAlt.data.chatId, exists: true };
      }
    } else if (cleaned.startsWith('55') && cleaned.length === 12) {
      // Try with 9th digit
      const with9 = cleaned.slice(0, 4) + '9' + cleaned.slice(4);
      const resAlt = await axios.get(`${wahaUrl}/api/contacts/check-exists`, {
        headers: reqHeaders,
        params: { session, phone: with9 },
        timeout: 6000,
      });
      if (resAlt.data && resAlt.data.numberExists && resAlt.data.chatId) {
        console.log(`[WAHA] JID canônico resolvido adicionando 9º dígito (${with9}): "${resAlt.data.chatId}"`);
        return { chatId: resAlt.data.chatId, exists: true };
      }
    }

    if (res.data && res.data.numberExists === false) {
      return { chatId: fallback, exists: false };
    }
  } catch (err) {
    console.warn(`[WAHA] Aviso ao verificar existência do número ${phone}: ${err.message}`);
  }

  return { chatId: fallback, exists: true };
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
function buildMessage(cart, settingKey = 'recovery_message') {
  const rawTemplate = getSetting(settingKey) || (settingKey === 'recovery_message' ? process.env.RECOVERY_MESSAGE : '') || '';
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
      const priceCents = item.priceInCents || item.productPriceInCents || item.unitPriceInCents || item.unitPrice || 0;
      const price = (priceCents / 100).toFixed(2).replace('.', ',');
      return `  • ${title} (${qty}x) - R$ ${price}`;
    })
    .join('\n');

  let amountCents = Number(cart.amount) || 0;
  if (amountCents <= 0 && items.length > 0) {
    amountCents = items.reduce((sum, item) => {
      const p = item.productPriceInCents || item.priceInCents || item.unitPriceInCents || item.price || item.unitPrice || 0;
      const q = item.productQuantity || item.quantity || 1;
      const priceVal = (Number(p) < 1000 && String(p).includes('.')) ? Math.round(Number(p) * 100) : Number(p);
      return sum + (priceVal * Number(q));
    }, 0);
  }

  const totalAmount = (amountCents / 100).toFixed(2).replace('.', ',');
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
      const priceCents = item.priceInCents || item.productPriceInCents || item.unitPriceInCents || item.unitPrice || 0;
      const price = (priceCents / 100).toFixed(2).replace('.', ',');
      return `  • ${title} (${qty}x) - R$ ${price}`;
    })
    .join('\n');

  let amountCents = Number(cart.amount) || 0;
  if (amountCents <= 0 && items.length > 0) {
    amountCents = items.reduce((sum, item) => {
      const p = item.productPriceInCents || item.priceInCents || item.unitPriceInCents || item.price || item.unitPrice || 0;
      const q = item.productQuantity || item.quantity || 1;
      const priceVal = (Number(p) < 1000 && String(p).includes('.')) ? Math.round(Number(p) * 100) : Number(p);
      return sum + (priceVal * Number(q));
    }, 0);
  }

  const totalAmount = (amountCents / 100).toFixed(2).replace('.', ',');
  const firstName = cart.customer_name ? cart.customer_name.split(' ')[0] : 'cliente';

  return template
    .replace(/\{nome\}/g, firstName)
    .replace(/\{produtos\}/g, productList)
    .replace(/\{valor\}/g, totalAmount)
    .replace(/\{link\}/g, cart.secure_url || '');
}

/**
 * Send a WhatsApp message, honoring the automatic pause and feeding the pacing state.
 * Every outgoing message (recovery, follow-up, payment confirmation) goes through here.
 */
async function sendWhatsAppMessage(phone, message) {
  const paused = getSetting('auto_pause_reason');
  if (paused) {
    return { success: false, paused: true, error: `Envios pausados automaticamente: ${paused}` };
  }

  const result = await deliverWhatsAppMessage(phone, message);
  recordSendOutcome(result);
  // Space out the next message even after a failure, so retries never come in bursts
  if (!/não possui WhatsApp/i.test(String(result.error || ''))) scheduleNextSend();
  return result;
}

/**
 * Send a WhatsApp message via WAHA (typing simulation, canonical chatId)
 */
async function deliverWhatsAppMessage(phone, message) {
  const wahaUrl = getSetting('waha_api_url') || process.env.WAHA_API_URL;
  const configuredSession = getSetting('waha_session') || process.env.WAHA_SESSION || 'default';
  const apiKey = getSetting('waha_api_key') || process.env.WAHA_API_KEY;

  // Resolve active session
  const session = await resolveWorkingSession(wahaUrl, apiKey, configuredSession);

  // Resolve canonical WhatsApp chatId (fixes 9th digit discrepancies)
  const resolved = await resolveChatId(phone, wahaUrl, session, apiKey);
  if (!resolved.exists) {
    console.warn(`[WAHA] ⚠️ Número ${phone} (${resolved.chatId}) não possui conta de WhatsApp ativa.`);
    return { success: false, error: 'Número não possui WhatsApp ativo', chatId: resolved.chatId };
  }

  const chatId = resolved.chatId;

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

    return { success: true, data: response.data, chatId };
  } catch (error) {
    const errorMsg = error.response
      ? JSON.stringify(error.response.data)
      : error.message;

    console.error(`[WAHA] Erro ao enviar mensagem para ${phone} (${chatId}):`, errorMsg);

    // Try to stop typing even on error
    axios.post(`${wahaUrl}/api/stopTyping`, { chatId, session }, { headers, timeout: 4000 }).catch(() => {});

    return { success: false, error: errorMsg, chatId };
  }
}

/**
 * Check if a recovery message was sent to this customer in the last X hours (cooldown)
 */
function hasRecentRecoveryMessage(phone, cooldownHours = 4) {
  if (!phone) return false;
  const clean = getCleanPhone(phone);
  if (clean.length < 8) return false;
  const last8 = clean.slice(-8);

  const hoursStr = String(cooldownHours);

  // Check message_log for recovery messages
  const recentLog = db.prepare(`
    SELECT ml.id, ml.sent_at 
    FROM message_log ml
    WHERE (digits(ml.phone) LIKE ? OR digits(ml.phone) LIKE ?)
      AND ml.status = 'sent'
      AND ml.sent_at >= datetime('now', '-' || ? || ' hours')
      AND ml.message NOT LIKE '%confirmado%'
      AND ml.message NOT LIKE '%Muito obrigado%'
    ORDER BY ml.sent_at DESC
    LIMIT 1
  `).get(`%${last8}%`, `%${clean}%`, hoursStr);

  if (recentLog) return true;

  // Check abandoned_carts where message_sent = 1
  const recentCart = db.prepare(`
    SELECT id, message_sent_at
    FROM abandoned_carts
    WHERE (digits(customer_phone) LIKE ? OR digits(customer_phone) LIKE ?)
      AND message_sent = 1
      AND message_sent_at >= datetime('now', '-' || ? || ' hours')
    ORDER BY message_sent_at DESC
    LIMIT 1
  `).get(`%${last8}%`, `%${clean}%`, hoursStr);

  if (recentCart) return true;

  return false;
}

/**
 * Check if customer already paid for this order in another cart (within last 48h)
 */
function isCustomerOrderAlreadyPaid(cart) {
  if (!cart || !cart.customer_phone) return null;
  const phone = cart.customer_phone;
  const clean = getCleanPhone(phone);
  if (clean.length < 8) return null;
  const last8 = clean.slice(-8);

  const paidCarts = db.prepare(`
    SELECT * FROM abandoned_carts
    WHERE (recovered = 1 OR payment_status = 'paid')
      AND (digits(customer_phone) LIKE ? OR digits(customer_phone) LIKE ?)
      AND created_at >= datetime('now', '-48 hours')
    ORDER BY created_at DESC
  `).all(`%${last8}%`, `%${clean}%`);

  for (const p of paidCarts) {
    if (isSameCustomerPhone(p.customer_phone, phone) || (cart.customer_email && p.customer_email && cart.customer_email.toLowerCase() === p.customer_email.toLowerCase())) {
      if (isSameOrder(cart, p)) {
        return p;
      }
    }
  }
  return null;
}

/**
 * Process a single abandoned cart - send recovery message with retry safety
 */
/**
 * First (recovery) message template for the cart's abandonment stage.
 * Falls back to the generic `recovery_message` when the stage is unknown or its template is empty.
 */
function getRecoveryTemplateKey(cart) {
  const stage = cart && cart.checkout_stage;
  if (stage && CHECKOUT_STAGES.includes(stage)) {
    const key = `recovery_stage_${stage}_message`;
    if (getSetting(key)) return key;
  }
  return 'recovery_message';
}

async function processCart(cart) {
  console.log(`[Processando] Carrinho #${cart.id} - ${cart.customer_name} (${cart.customer_phone})`);

  try {
    const message = buildMessage(cart, getRecoveryTemplateKey(cart));
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
    if (result.success) {
      db.prepare(`
        UPDATE abandoned_carts
        SET message_sent = 1,
            message_sent_at = datetime('now'),
            status = 'sent',
            retry_count = 0,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(cart.id);

      console.log(`[✓] Mensagem enviada com sucesso para ${cart.customer_phone}`);
    } else {
      const retries = (cart.retry_count || 0) + 1;
      const isFinalFail = retries >= 3;

      db.prepare(`
        UPDATE abandoned_carts
        SET message_sent = ?,
            status = ?,
            retry_count = ?,
            cancel_reason = ?,
            scheduled_at = CASE WHEN ? = 0 THEN datetime('now', '+10 minutes') ELSE scheduled_at END,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(
        isFinalFail ? 1 : 0,
        isFinalFail ? 'failed' : 'pending',
        retries,
        isFinalFail ? `Falhou após 3 tentativas: ${result.error}` : null,
        isFinalFail ? 1 : 0,
        cart.id
      );

      console.log(`[✗] Falha ao enviar mensagem para ${cart.customer_phone} (tentativa ${retries}/3): ${result.error}`);
    }

    return result;
  } catch (error) {
    console.error(`[Processando] Erro inesperado ao processar carrinho #${cart.id}:`, error.message);
    const retries = (cart.retry_count || 0) + 1;
    const isFinalFail = retries >= 3;

    try {
      db.prepare(`
        UPDATE abandoned_carts
        SET message_sent = ?,
            status = ?,
            retry_count = ?,
            cancel_reason = ?,
            scheduled_at = CASE WHEN ? = 0 THEN datetime('now', '+10 minutes') ELSE scheduled_at END,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(
        isFinalFail ? 1 : 0,
        isFinalFail ? 'failed' : 'pending',
        retries,
        `Erro inesperado: ${error.message}`,
        isFinalFail ? 1 : 0,
        cart.id
      );
    } catch (dbErr) {
      console.error('[Processando] Erro ao salvar falha no banco:', dbErr.message);
    }

    return { success: false, error: error.message };
  }
}

/**
 * Mark a cart's follow-up as handled (1 = sent, 2 = skipped/failed) and log the reason
 */
function markFollowUp(cart, state, logMessage, logStatus, errorMessage) {
  db.prepare(`
    UPDATE abandoned_carts
    SET followup_sent = ?,
        followup_sent_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(state, cart.id);

  if (logMessage) {
    try {
      db.prepare(`
        INSERT INTO message_log (cart_id, phone, message, status, error_message)
        VALUES (?, ?, ?, ?, ?)
      `).run(cart.id, cart.customer_phone, logMessage, logStatus, errorMessage || null);
    } catch (e) {}
  }
}

// Carts eligible for the 2nd message (first message sent, not paid, follow-up not handled yet)
const FOLLOWUP_BASE_WHERE = `
  status = 'sent'
  AND message_sent = 1
  AND recovered = 0
  AND COALESCE(followup_sent, 0) = 0
  AND message_sent_at IS NOT NULL
`;

/**
 * Any paid cart from the same customer created after this cart (any order)
 */
function findLaterPurchase(cart) {
  const clean = getCleanPhone(cart.customer_phone);
  if (clean.length < 8) return null;
  const candidates = db.prepare(`
    SELECT * FROM abandoned_carts
    WHERE id != ?
      AND (recovered = 1 OR payment_status = 'paid')
      AND (digits(customer_phone) LIKE ? OR digits(customer_phone) LIKE ?)
      AND datetime(created_at) >= datetime(?)
  `).all(cart.id, `%${clean.slice(-8)}%`, `%${clean}%`, cart.created_at);
  return candidates.find((p) => isSameCustomerPhone(p.customer_phone, cart.customer_phone)) || null;
}

/**
 * Count carts that a backfill of the last `days` days would cover (before per-customer filters)
 */
function countFollowUpBackfill(days) {
  const delayHours = Math.max(1, parseInt(getSetting('followup_delay_hours') || '4', 10));
  const rows = db.prepare(`
    SELECT customer_phone FROM abandoned_carts
    WHERE ${FOLLOWUP_BASE_WHERE}
      AND datetime(message_sent_at) <= datetime('now', '-' || ? || ' hours')
      AND datetime(message_sent_at) >= datetime('now', '-' || ? || ' days')
  `).all(delayHours, days);
  const customers = new Set(rows.map((r) => getCleanPhone(r.customer_phone).slice(-8)));
  return { carts: rows.length, customers: customers.size };
}

/**
 * Send the second (follow-up) message to carts whose first recovery message
 * was sent `followup_delay_hours` ago and that still haven't been paid.
 */
async function processFollowUps() {
  if (getSetting('followup_active') === 'false') return;
  if (!getSetting('followup_message')) return;

  const delayHours = Math.max(1, parseInt(getSetting('followup_delay_hours') || '4', 10));
  // Grace window: only send if the first message was sent at most 12h past the due time.
  // Prevents a burst of stale follow-ups after downtime/deploy.
  const windowHours = delayHours + 12;

  const dueCarts = db.prepare(`
    SELECT * FROM abandoned_carts
    WHERE ${FOLLOWUP_BASE_WHERE}
      AND datetime(message_sent_at) <= datetime('now', '-' || ? || ' hours')
      AND datetime(message_sent_at) >= datetime('now', '-' || ? || ' hours')
    ORDER BY message_sent_at ASC
    LIMIT 10
  `).all(delayHours, windowHours);

  // Backfill (manual): older carts, sent very slowly to protect the number:
  // 1 message per random interval, daily cap, business hours only, auto-pause on failures
  const backfillSince = getSetting('followup_backfill_since');
  if (backfillSince) {
    const today = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    if (getSetting('followup_backfill_day') !== today) {
      setSetting('followup_backfill_day', today);
      setSetting('followup_backfill_count', '0');
    }
    const sentToday = parseInt(getSetting('followup_backfill_count') || '0', 10);
    const dailyLimit = parseInt(getSetting('followup_backfill_daily_limit') || '30', 10);
    const brHour = parseInt(new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }), 10);
    const startHour = parseInt(getSetting('followup_backfill_start_hour') || '10', 10);
    const endHour = parseInt(getSetting('followup_backfill_end_hour') || '20', 10);
    const inHours = brHour >= startHour && brHour < endHour;
    const nextAt = parseInt(getSetting('followup_backfill_next_at') || '0', 10);
    const due = inHours && sentToday < dailyLimit && Date.now() >= nextAt;

    const backlog = db.prepare(`
      SELECT * FROM abandoned_carts
      WHERE ${FOLLOWUP_BASE_WHERE}
        AND datetime(message_sent_at) < datetime('now', '-' || ? || ' hours')
        AND datetime(message_sent_at) >= datetime(?)
      ORDER BY message_sent_at DESC
      LIMIT 1
    `).get(windowHours, backfillSince);

    if (!backlog) {
      console.log('[Follow-up] ✅ Envio retroativo da 2ª mensagem concluído.');
      setSetting('followup_backfill_since', '');
    } else if (due && dueCarts.length < 10) {
      backlog._backfill = true;
      dueCarts.push(backlog);
    }
  }

  if (dueCarts.length > 0) {
    console.log(`[Follow-up] ${dueCarts.length} carrinho(s) aguardando a 2ª mensagem`);
  }

  for (const cart of dueCarts) {
    // Backfill pacing: next attempt in a random 4–9 min (skips included, so the queue keeps moving)
    if (cart._backfill) {
      const baseMin = Math.max(2, parseInt(getSetting('followup_backfill_interval_min') || '4', 10));
      const waitMs = (baseMin + Math.random() * (baseMin + 1)) * 60 * 1000;
      setSetting('followup_backfill_next_at', String(Date.now() + Math.floor(waitMs)));
    }

    // Customer already paid this order (possibly in another cart), or bought anything after this cart
    const paidMatch = isCustomerOrderAlreadyPaid(cart) || findLaterPurchase(cart);
    if (paidMatch) {
      console.log(`[Follow-up] 🚫 Carrinho #${cart.id}: cliente já concluiu a compra no carrinho #${paidMatch.id}`);
      markFollowUp(cart, 2, null);
      continue;
    }

    const clean = getCleanPhone(cart.customer_phone);
    const last8 = clean.slice(-8);

    // A newer cart of the same customer already got a recovery message: that cart owns the follow-up now
    const newerCart = db.prepare(`
      SELECT id FROM abandoned_carts
      WHERE id != ?
        AND (digits(customer_phone) LIKE ? OR digits(customer_phone) LIKE ?)
        AND message_sent = 1
        AND datetime(message_sent_at) > datetime(?)
      LIMIT 1
    `).get(cart.id, `%${last8}%`, `%${clean}%`, cart.message_sent_at);

    // Customer already received a follow-up in the last 24h
    const recentFollowUp = db.prepare(`
      SELECT id FROM abandoned_carts
      WHERE id != ?
        AND (digits(customer_phone) LIKE ? OR digits(customer_phone) LIKE ?)
        AND followup_sent = 1
        AND datetime(followup_sent_at) >= datetime('now', '-24 hours')
      LIMIT 1
    `).get(cart.id, `%${last8}%`, `%${clean}%`);

    if (newerCart || recentFollowUp) {
      console.log(`[Follow-up] ⏭️ Carrinho #${cart.id}: ignorado (${newerCart ? `carrinho mais recente #${newerCart.id}` : '2ª mensagem já enviada nas últimas 24h'})`);
      markFollowUp(cart, 2, null);
      continue;
    }

    // Backfill: never message a customer who got any other message from us in the last 24h
    if (cart._backfill) {
      const recentAny = db.prepare(`
        SELECT id FROM message_log
        WHERE cart_id != ?
          AND (digits(phone) LIKE ? OR digits(phone) LIKE ?)
          AND status = 'sent'
          AND sent_at >= datetime('now', '-24 hours')
        LIMIT 1
      `).get(cart.id, `%${last8}%`, `%${clean}%`);
      if (recentAny) {
        console.log(`[Follow-up] ⏭️ Carrinho #${cart.id}: ignorado (cliente recebeu outra mensagem nas últimas 24h)`);
        markFollowUp(cart, 2, null);
        continue;
      }
    }

    // Anti-Ban pacing: one message per tick, spaced and capped (shared with 1st messages)
    const budget = getSendBudget();
    if (!budget.ok) {
      logBudgetWait(budget.reason);
      return;
    }

    // Re-check: the customer may have paid in the meantime
    const fresh = db.prepare('SELECT recovered, status FROM abandoned_carts WHERE id = ?').get(cart.id);
    if (!fresh || fresh.recovered === 1 || fresh.status !== 'sent') {
      markFollowUp(cart, 2, null);
      continue;
    }

    // A 2nd unanswered message is what gets reported as spam: by default only
    // follow up with customers who answered the 1st one
    if (getSetting('followup_only_if_replied') !== 'false') {
      const replied = await customerRepliedSince(cart.customer_phone, cart.message_sent_at);
      if (!replied) {
        console.log(`[Follow-up] ⏭️ Carrinho #${cart.id}: ignorado (cliente não respondeu à 1ª mensagem)`);
        markFollowUp(cart, 2, null);
        continue;
      }
    }

    try {
      const message = buildMessage(cart, 'followup_message');
      console.log(`[Follow-up] Enviando 2ª mensagem para #${cart.id} - ${cart.customer_name} (${cart.customer_phone})`);
      const result = await sendWhatsAppMessage(cart.customer_phone, message);

      if (result.success) {
        db.prepare(`
          INSERT INTO message_log (cart_id, phone, message, status, waha_response)
          VALUES (?, ?, ?, 'sent', ?)
        `).run(cart.id, cart.customer_phone, message, JSON.stringify(result.data));
        markFollowUp(cart, 1, null);
        console.log(`[✓] 2ª mensagem enviada para ${cart.customer_phone}${cart._backfill ? ' (retroativa)' : ''}`);
        if (cart._backfill) {
          setSetting('followup_backfill_count', String(parseInt(getSetting('followup_backfill_count') || '0', 10) + 1));
          setSetting('followup_backfill_failures', '0');
        }
      } else {
        markFollowUp(cart, 2, message, 'failed', result.error);
        console.log(`[✗] Falha na 2ª mensagem para ${cart.customer_phone}: ${result.error}`);
        // Safety: repeated delivery errors may mean the number is restricted — stop the backfill
        if (cart._backfill && !/não possui WhatsApp/i.test(String(result.error))) {
          const failures = parseInt(getSetting('followup_backfill_failures') || '0', 10) + 1;
          setSetting('followup_backfill_failures', String(failures));
          if (failures >= 3) {
            setSetting('followup_backfill_since', '');
            setSetting('followup_backfill_paused_reason', `Pausado automaticamente após ${failures} falhas seguidas (${new Date().toISOString()})`);
            console.warn('[Follow-up] ⛔ Envio retroativo PAUSADO após 3 falhas seguidas para proteger o número.');
          }
        }
      }
    } catch (err) {
      console.error(`[Follow-up] Erro inesperado no carrinho #${cart.id}:`, err.message);
      markFollowUp(cart, 2, null);
    }
    // One message per tick: the rest waits for the next tick and the random gap
    return;
  }
}

/**
 * Whether the customer sent us any message after `sinceDb` (SQLite UTC datetime).
 * Reads the chat from WAHA; any error counts as "no reply" so we never risk a cold 2nd message.
 */
async function customerRepliedSince(phone, sinceDb) {
  const wahaUrl = getSetting('waha_api_url') || process.env.WAHA_API_URL;
  const configuredSession = getSetting('waha_session') || process.env.WAHA_SESSION || 'default';
  const apiKey = getSetting('waha_api_key') || process.env.WAHA_API_KEY;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;

  try {
    const session = await resolveWorkingSession(wahaUrl, apiKey, configuredSession);
    const { chatId, exists } = await resolveChatId(phone, wahaUrl, session, apiKey);
    if (!exists) return false;

    const res = await axios.get(
      `${wahaUrl}/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages`,
      { headers, params: { limit: 30, downloadMedia: false }, timeout: 10000 }
    );
    const sinceSec = parseDbDate(sinceDb) / 1000;
    const messages = Array.isArray(res.data) ? res.data : [];
    return messages.some((m) => m && m.fromMe === false && Number(m.timestamp) >= sinceSec);
  } catch (err) {
    console.warn(`[Follow-up] Não foi possível verificar resposta de ${phone}: ${err.message}`);
    return false;
  }
}

/**
 * Whether the 1st message template used for this cart (stage or generic) has the {link} tag
 */
function recoveryMessageNeedsLink(cart) {
  const key = getRecoveryTemplateKey(cart);
  const template = getSetting(key) || (key === 'recovery_message' ? process.env.RECOVERY_MESSAGE : '') || '';
  return template.includes('{link}');
}

/**
 * Parse a SQLite datetime('now') string (UTC, no zone) or an ISO string to epoch ms
 */
function parseDbDate(value) {
  if (!value) return Date.now();
  const str = String(value);
  const iso = str.includes('T') ? str : str.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Date.now() : t;
}

// Log a pacing wait only when its reason changes, not on every 1-minute tick
let lastBudgetLog = '';
function logBudgetWait(reason) {
  const kind = reason.replace(/\(.*\)/, '').trim();
  if (kind === lastBudgetLog) return;
  lastBudgetLog = kind;
  console.log(`[Anti-Ban] ⏸️ Envio adiado: ${reason}`);
}

// Global lock to prevent overlapping runs from 1-minute cron
let isProcessingCarts = false;

/**
 * Check and process all pending carts that are due with human jitter delays
 */
async function processPendingCarts() {
  const isActive = getSetting('active');
  if (isActive !== 'true') {
    return;
  }

  // Mutex lock to prevent overlapping runs from 1-minute cron
  if (isProcessingCarts) {
    console.log('[Scheduler] ⏳ Processamento anterior ainda em execução. Aguardando próximo ciclo...');
    return;
  }
  isProcessingCarts = true;

  try {
    // Anti-Ban: Check quiet hours (e.g. 23:00 - 08:00)
    if (isQuietHours()) {
      console.log('[Anti-Ban] 🌙 Horário de silêncio ativo. Disparos de carrinho pausados durante a noite para evitar denúncias de spam.');
      return;
    }

    // Expire ancient carts so old carts don't fire in a sudden burst after restart or downtime
    const maxAgeHours = parseInt(getSetting('cart_max_age_hours') || '12', 10);
    try {
      const expiredInfo = db.prepare(`
        UPDATE abandoned_carts
        SET status = 'expired',
            cancel_reason = 'Tempo limite de recuperação excedido (' || ? || 'h)',
            updated_at = datetime('now')
        WHERE status = 'pending'
          AND message_sent = 0
          AND datetime(scheduled_at) < datetime('now', '-' || ? || ' hours')
      `).run(maxAgeHours, maxAgeHours);

      if (expiredInfo.changes > 0) {
        console.log(`[Scheduler] ⚠️ ${expiredInfo.changes} carrinho(s) antigo(s) expirados para evitar disparos em lote.`);
      }
    } catch (e) {
      console.error('[Scheduler] Erro ao expirar carrinhos antigos:', e.message);
    }

    const pendingCarts = db.prepare(`
      SELECT * FROM abandoned_carts
      WHERE status = 'pending'
        AND message_sent = 0
        AND recovered = 0
        AND datetime(scheduled_at) <= datetime('now')
      ORDER BY scheduled_at ASC
      LIMIT 10
    `).all();

    if (pendingCarts.length > 0) {
      console.log(`[Scheduler] ${pendingCarts.length} carrinho(s) pendente(s) para processar`);
    }

    const cooldownHours = parseInt(getSetting('cart_cooldown_hours') || '4', 10);

    for (let i = 0; i < pendingCarts.length; i++) {
      const cart = pendingCarts[i];

      // Condition 1: Check if customer already completed/paid this order in another cart
      const paidMatch = isCustomerOrderAlreadyPaid(cart);
      if (paidMatch) {
        console.log(`[Scheduler] 🚫 Carrinho #${cart.id} CANCELADO: cliente (${cart.customer_phone}) já concluiu o pedido no carrinho #${paidMatch.id}`);
        db.prepare(`
          UPDATE abandoned_carts
          SET status = 'cancelled',
              payment_status = 'cancelled_paid_elsewhere',
              cancel_reason = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(`Cliente concluiu a compra no carrinho #${paidMatch.id}`, cart.id);

        try {
          db.prepare(`
            INSERT INTO message_log (cart_id, phone, message, status, error_message, sent_at)
            VALUES (?, ?, ?, 'cancelled', 'Cancelado: cliente concluiu a compra em outro carrinho', datetime('now'))
          `).run(
            cart.id,
            cart.customer_phone,
            `[Sistema] Envio cancelado: cliente concluiu a compra no carrinho #${paidMatch.id} com o mesmo pedido.`
          );
        } catch (e) {}
        continue;
      }

      // Condition 2: Cooldown limit - send only 1 recovery message every 4 hours per customer
      if (hasRecentRecoveryMessage(cart.customer_phone, cooldownHours)) {
        console.log(`[Cooldown] ⏱️ Carrinho #${cart.id} CANCELADO: cliente (${cart.customer_phone}) já recebeu mensagem nas últimas ${cooldownHours}h.`);
        db.prepare(`
          UPDATE abandoned_carts
          SET status = 'cancelled',
              cancel_reason = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(`Limite de 1 mensagem a cada ${cooldownHours}h atingido`, cart.id);

        try {
          db.prepare(`
            INSERT INTO message_log (cart_id, phone, message, status, error_message, sent_at)
            VALUES (?, ?, ?, 'cancelled', 'Cancelado: limite de 1 mensagem a cada 4h atingido', datetime('now'))
          `).run(
            cart.id,
            cart.customer_phone,
            `[Sistema] Envio cancelado: cliente já recebeu mensagem de recuperação nas últimas ${cooldownHours} horas.`
          );
        } catch (e) {}
        continue;
      }

      // Condition 3: the 1st message must always carry the recovery link. Bestfy transaction
      // postbacks (PENDING/EXPIRED) have no URL; the checkout postback with recoveryUrl usually
      // arrives ~30 min later (when the PIX expires), so wait for it instead of sending without link.
      if (!cart.secure_url && recoveryMessageNeedsLink(cart)) {
        const waitMinutes = parseInt(getSetting('link_wait_minutes') || '60', 10);
        const delayMinutes = parseInt(getSetting('recovery_delay_minutes') || process.env.RECOVERY_DELAY_MINUTES || '30', 10);
        const ageMinutes = (Date.now() - parseDbDate(cart.created_at)) / 60000;

        if (ageMinutes < delayMinutes + waitMinutes) {
          db.prepare(`
            UPDATE abandoned_carts
            SET scheduled_at = datetime('now', '+5 minutes'),
                updated_at = datetime('now')
            WHERE id = ?
          `).run(cart.id);
          console.log(`[Scheduler] 🔗 Carrinho #${cart.id} sem link de recuperação ainda - aguardando webhook de checkout (reagendado +5min)`);
        } else {
          db.prepare(`
            UPDATE abandoned_carts
            SET status = 'cancelled',
                cancel_reason = ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).run(`Sem link de recuperação após ${waitMinutes}min de espera`, cart.id);
          console.log(`[Scheduler] 🚫 Carrinho #${cart.id} CANCELADO: nenhum link de recuperação recebido.`);
        }
        continue;
      }

      // Anti-Ban pacing: at most one message per tick, spaced and capped (see getSendBudget)
      const budget = getSendBudget();
      if (!budget.ok) {
        logBudgetWait(budget.reason);
        return;
      }

      await processCart(cart);
      // The next cart waits for the next tick and the random gap
      return;
    }

    // Second message (follow-up) only when no first message was waiting to go out
    await processFollowUps();
  } finally {
    isProcessingCarts = false;
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
  resolveChatId,
  getSetting,
  setSetting,
  parseSpintax,
  isQuietHours,
  resolveWorkingSession,
  hasRecentRecoveryMessage,
  isCustomerOrderAlreadyPaid,
  countFollowUpBackfill,
};
