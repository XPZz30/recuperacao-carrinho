require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (dashboard)
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
const apiRoutes = require('./api');
app.use('/api', apiRoutes);

// Webhook routes
const { handleWahaWebhook, startSpamWatcher } = require('./antispam');
const webhookRoutes = require('./webhook');

// WAHA Anti-Spam webhook (prioridade)
app.post(['/webhook/waha', '/api/webhook/waha'], handleWahaWebhook);

// Bestfy checkout/cart webhook
app.use('/webhook/bestfy', webhookRoutes);
app.use('/webhook', webhookRoutes);
app.use('/api/webhook', webhookRoutes);

// Fallback: if webhook is posted to root URL
app.post('/', (req, res, next) => {
  if (req.body && (req.body.event === 'message' || req.body.event === 'message.any')) {
    return handleWahaWebhook(req, res);
  }
  if (req.body && (req.body.type || req.body.event || req.body.data || req.body.status || req.body.id)) {
    return webhookRoutes(req, res, next);
  }
  next();
});

// Initialize the messenger scheduler
const { processPendingCarts } = require('./messenger');

// Run every minute to check for pending recovery messages
cron.schedule('* * * * *', async () => {
  try {
    await processPendingCarts();
  } catch (error) {
    console.error('[Scheduler] Erro:', error.message);
  }
});

// Health check for Railway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// SPA fallback - serve index.html for all unmatched routes
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Prevent crashes on unexpected errors
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
});

// Start server
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   🛒 RECUPERAÇÃO DE CARRINHO ABANDONADO                 ║');
  console.log('║   Bestfy + WAHA WhatsApp                                ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║   🌐 Dashboard: ${baseUrl}`);
  console.log(`║   📡 Bestfy:    ${baseUrl}/webhook/bestfy`);
  console.log(`║   🛡️ AntiSpam:  ${baseUrl}/webhook/waha`);
  console.log(`║   📊 API:       ${baseUrl}/api`);
  const db = require('./database');
  const isAntiSpamOn = db.getSetting('antispam_active') === 'true';

  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║   ⏰ Scheduler: Carrinho Abandonado Ativo (1 min)        ║');
  console.log(`║   🛡️ Anti-Spam: ${isAntiSpamOn ? 'Ativo em Tempo Real' : 'Desligado'}                              ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // Inicia monitor 24/7 de spam nos grupos apenas se ativado
  if (isAntiSpamOn) {
    startSpamWatcher();
  }
});

module.exports = app;
