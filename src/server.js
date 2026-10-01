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
const webhookRoutes = require('./webhook');
app.use('/webhook', webhookRoutes);

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

// SPA fallback - serve index.html for all unmatched routes
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
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
  console.log(`║   📡 Webhook:   ${baseUrl}/webhook/bestfy`);
  console.log(`║   📊 API:       ${baseUrl}/api`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║   ⏰ Scheduler: Verificando a cada 1 minuto             ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
});

module.exports = app;
