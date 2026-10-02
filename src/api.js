const express = require('express');
const db = require('./database');

const router = express.Router();

// ============================================================
// Dashboard Stats
// ============================================================

/**
 * GET /api/stats
 * Returns dashboard statistics
 */
router.get('/stats', (req, res) => {
  try {
    const totalCarts = db.prepare('SELECT COUNT(*) as count FROM abandoned_carts').get().count;
    const pendingCarts = db.prepare("SELECT COUNT(*) as count FROM abandoned_carts WHERE status = 'pending'").get().count;
    const sentCarts = db.prepare("SELECT COUNT(*) as count FROM abandoned_carts WHERE status = 'sent'").get().count;
    const recoveredCarts = db.prepare("SELECT COUNT(*) as count FROM abandoned_carts WHERE recovered = 1").get().count;
    const failedCarts = db.prepare("SELECT COUNT(*) as count FROM abandoned_carts WHERE status = 'failed'").get().count;

    const totalAmount = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM abandoned_carts').get().total;
    const recoveredAmount = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM abandoned_carts WHERE recovered = 1').get().total;

    const recoveryRate = totalCarts > 0 ? ((recoveredCarts / totalCarts) * 100).toFixed(1) : '0.0';

    // Recent activity (last 7 days)
    const recentCarts = db.prepare(`
      SELECT COUNT(*) as count FROM abandoned_carts
      WHERE created_at >= datetime('now', '-7 days')
    `).get().count;

    const recentRecovered = db.prepare(`
      SELECT COUNT(*) as count FROM abandoned_carts
      WHERE recovered = 1 AND recovered_at >= datetime('now', '-7 days')
    `).get().count;

    res.json({
      totalCarts,
      pendingCarts,
      sentCarts,
      recoveredCarts,
      failedCarts,
      totalAmount,
      recoveredAmount,
      recoveryRate,
      recentCarts,
      recentRecovered,
    });
  } catch (error) {
    console.error('[API] Erro ao buscar stats:', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ============================================================
// Abandoned Carts List
// ============================================================

/**
 * GET /api/carts
 * Returns list of abandoned carts with filtering and pagination
 */
router.get('/carts', (req, res) => {
  try {
    const { status, page = 1, limit = 20, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let whereClause = '1=1';
    const params = [];

    if (status && status !== 'all') {
      whereClause += ' AND status = ?';
      params.push(status);
    }

    if (search) {
      whereClause += ' AND (customer_name LIKE ? OR customer_phone LIKE ? OR customer_email LIKE ?)';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
    }

    const total = db.prepare(`SELECT COUNT(*) as count FROM abandoned_carts WHERE ${whereClause}`).get(...params).count;

    const carts = db.prepare(`
      SELECT * FROM abandoned_carts
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    // Parse items_json for each cart
    const cartsWithItems = carts.map((cart) => ({
      ...cart,
      items: JSON.parse(cart.items_json),
      amount_formatted: 'R$ ' + (cart.amount / 100).toFixed(2).replace('.', ','),
    }));

    res.json({
      carts: cartsWithItems,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (error) {
    console.error('[API] Erro ao buscar carrinhos:', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

/**
 * GET /api/carts/:id
 * Returns a single cart with its message logs
 */
router.get('/carts/:id', (req, res) => {
  try {
    const cart = db.prepare('SELECT * FROM abandoned_carts WHERE id = ?').get(req.params.id);
    if (!cart) return res.status(404).json({ error: 'Carrinho não encontrado' });

    const logs = db.prepare('SELECT * FROM message_log WHERE cart_id = ? ORDER BY sent_at DESC').all(cart.id);

    res.json({
      ...cart,
      items: JSON.parse(cart.items_json),
      amount_formatted: 'R$ ' + (cart.amount / 100).toFixed(2).replace('.', ','),
      logs,
    });
  } catch (error) {
    console.error('[API] Erro ao buscar carrinho:', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

/**
 * POST /api/carts/:id/resend
 * Resend recovery message for a specific cart
 */
router.post('/carts/:id/resend', async (req, res) => {
  try {
    const cart = db.prepare('SELECT * FROM abandoned_carts WHERE id = ?').get(req.params.id);
    if (!cart) return res.status(404).json({ error: 'Carrinho não encontrado' });

    const { processCart } = require('./messenger');
    // Reset to pending so it gets processed
    db.prepare("UPDATE abandoned_carts SET status = 'pending', message_sent = 0, scheduled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(cart.id);

    const updatedCart = db.prepare('SELECT * FROM abandoned_carts WHERE id = ?').get(cart.id);
    const result = await processCart(updatedCart);

    res.json({ success: result.success, message: result.success ? 'Mensagem reenviada!' : 'Falha ao reenviar' });
  } catch (error) {
    console.error('[API] Erro ao reenviar:', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

/**
 * POST /api/carts/:id/send-paid
 * Send payment confirmation message for a specific cart
 */
router.post('/carts/:id/send-paid', async (req, res) => {
  try {
    const cart = db.prepare('SELECT * FROM abandoned_carts WHERE id = ?').get(req.params.id);
    if (!cart) return res.status(404).json({ error: 'Carrinho não encontrado' });

    const { sendPaymentConfirmation } = require('./messenger');
    const result = await sendPaymentConfirmation(cart);

    res.json({
      success: result.success,
      message: result.success ? 'Confirmação de pagamento enviada com sucesso!' : (result.error || 'Falha ao enviar confirmação')
    });
  } catch (error) {
    console.error('[API] Erro ao enviar confirmação de pagamento:', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

/**
 * DELETE /api/carts/:id
 * Delete a cart record
 */
router.delete('/carts/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM message_log WHERE cart_id = ?').run(req.params.id);
    const result = db.prepare('DELETE FROM abandoned_carts WHERE id = ?').run(req.params.id);

    if (result.changes === 0) return res.status(404).json({ error: 'Carrinho não encontrado' });

    res.json({ success: true });
  } catch (error) {
    console.error('[API] Erro ao deletar:', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

/**
 * PATCH /api/carts/:id
 * Update cart status/fields
 */
router.patch('/carts/:id', (req, res) => {
  try {
    const { status, payment_status, recovered } = req.body;
    db.prepare(`
      UPDATE abandoned_carts
      SET status = COALESCE(?, status),
          payment_status = COALESCE(?, payment_status),
          recovered = COALESCE(?, recovered),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      status || null,
      payment_status || null,
      recovered !== undefined ? Number(recovered) : null,
      req.params.id
    );

    res.json({ success: true });
  } catch (error) {
    console.error('[API] Erro ao atualizar carrinho:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// Settings
// ============================================================

/**
 * GET /api/settings
 * Returns all settings
 */
router.get('/settings', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM settings').all();
    const settings = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    res.json(settings);
  } catch (error) {
    console.error('[API] Erro ao buscar settings:', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

/**
 * PUT /api/settings
 * Update settings
 */
router.put('/settings', (req, res) => {
  try {
    const updates = req.body;
    const stmt = db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `);

    const updateMany = db.transaction((items) => {
      for (const [key, value] of Object.entries(items)) {
        stmt.run(key, String(value));
      }
    });

    updateMany(updates);
    res.json({ success: true });
  } catch (error) {
    console.error('[API] Erro ao atualizar settings:', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ============================================================
// Message Logs
// ============================================================

/**
 * GET /api/logs
 * Returns message logs
 */
router.get('/logs', (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const total = db.prepare('SELECT COUNT(*) as count FROM message_log').get().count;
    const logs = db.prepare(`
      SELECT ml.*, ac.customer_name, ac.transaction_id
      FROM message_log ml
      LEFT JOIN abandoned_carts ac ON ml.cart_id = ac.id
      ORDER BY ml.sent_at DESC
      LIMIT ? OFFSET ?
    `).all(parseInt(limit), offset);

    res.json({ logs, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (error) {
    console.error('[API] Erro ao buscar logs:', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

/**
 * GET /api/webhook-events
 * Returns raw webhook events received
 */
router.get('/webhook-events', (req, res) => {
  try {
    const events = db.prepare('SELECT * FROM webhook_events ORDER BY created_at DESC LIMIT 50').all();
    res.json(events);
  } catch (error) {
    console.error('[API] Erro ao buscar webhook events:', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
