const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Use custom data dir, Railway volume, or local data dir
const dataDir = process.env.DATA_DIR 
  || process.env.RAILWAY_VOLUME_MOUNT_PATH 
  || path.join(__dirname, '..', 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'cart-recovery.db'));

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS abandoned_carts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id TEXT UNIQUE NOT NULL,
    checkout_id TEXT,
    customer_name TEXT,
    customer_email TEXT,
    customer_phone TEXT NOT NULL,
    amount INTEGER NOT NULL,
    items_json TEXT NOT NULL,
    secure_url TEXT,
    status TEXT DEFAULT 'pending',
    payment_status TEXT NOT NULL,
    message_sent INTEGER DEFAULT 0,
    message_sent_at TEXT,
    scheduled_at TEXT NOT NULL,
    recovered INTEGER DEFAULT 0,
    recovered_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS message_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cart_id INTEGER NOT NULL,
    phone TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    error_message TEXT,
    waha_response TEXT,
    sent_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (cart_id) REFERENCES abandoned_carts(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT,
    method TEXT,
    payload_json TEXT,
    processed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_carts_status ON abandoned_carts(status);
  CREATE INDEX IF NOT EXISTS idx_carts_scheduled ON abandoned_carts(scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_carts_phone ON abandoned_carts(customer_phone);
`);

// Insert default settings if they don't exist
const insertSetting = db.prepare(`
  INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)
`);

const defaultSettings = {
  recovery_delay_minutes: '25',
  recovery_message: '{Olá|Oi|Opa} {nome}! 👋\n\n{Notamos|Vimos|Percebemos} que você não finalizou sua compra.\n\n🛒 *Itens no carrinho:*\n{produtos}\n\n💰 *Valor total:* R$ {valor}\n\n{Finalize agora mesmo clicando no link abaixo:|Conclua seu pedido pelo link abaixo:|Acesse aqui para finalizar:}\n👉 {link}\n\n{Se precisar de ajuda, é só responder esta mensagem! 😊|Qualquer dúvida, estamos à disposição por aqui! 😊|Pode responder esta mensagem se precisar de suporte! 😊}',
  paid_message_active: 'true',
  paid_message: '{Olá|Oi|Opa} {nome}! 🎉\n\nSeu pagamento foi confirmado com sucesso! ✅\n\n🛒 *Itens do seu pedido:*\n{produtos}\n\n💰 *Valor total:* R$ {valor}\n\n{Muito obrigado pela preferencia!|Agradecemos pela sua compra!|Obrigado pela preferência!} Aguarda a nossa equipe enviar o seu acesso pelo whatsapp.',
  anti_ban_typing: 'true',
  anti_ban_delay_min: '8',
  anti_ban_delay_max: '18',
  quiet_hours_active: 'true',
  quiet_hours_start: '23',
  quiet_hours_end: '8',
  active: 'true',
  waha_api_url: process.env.WAHA_API_URL || 'https://waha-production-e923.up.railway.app',
  waha_session: process.env.WAHA_SESSION || 'default',
  waha_api_key: process.env.WAHA_API_KEY || 'recupera123',
};

for (const [key, value] of Object.entries(defaultSettings)) {
  insertSetting.run(key, value);
}

module.exports = db;
