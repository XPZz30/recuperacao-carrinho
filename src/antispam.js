const axios = require('axios');
const db = require('./database');

// Cache in-memory
const groupCache = new Map(); // groupId -> { timestamp, subject, participants: [] }
const userMessageHistory = new Map(); // key: groupId:participant -> [{ timestamp, body }]

/**
 * Retorna uma instância do axios configurada dinamicamente com as credenciais do WAHA
 */
function getWahaClient() {
  const url = db.getSetting('waha_api_url') || process.env.WAHA_API_URL || 'http://localhost:3000';
  const apiKey = db.getSetting('waha_api_key') || process.env.WAHA_API_KEY || '';
  const session = db.getSetting('waha_session') || process.env.WAHA_SESSION || 'default';

  const client = axios.create({
    baseURL: url.replace(/\/+$/, ''),
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'X-Api-Key': apiKey } : {}),
    },
  });

  return { client, session };
}

/**
 * Normaliza qualquer ID/JID do WhatsApp para comparação limpa de números/LIDs
 */
function cleanIdentifier(id) {
  if (!id) return '';
  return String(id).replace(/@(c\.us|s\.whatsapp\.net|lid|g\.us)$/i, '').replace(/\D/g, '');
}

/**
 * Busca e armazena metadados e lista de participantes do grupo
 */
async function getGroupMetadata(groupId, forceRefresh = false) {
  const now = Date.now();
  const cached = groupCache.get(groupId);

  if (!forceRefresh && cached && (now - cached.timestamp < 5 * 60 * 1000)) {
    return cached;
  }

  const { client, session } = getWahaClient();
  try {
    const res = await client.get(`/api/${session}/groups/${encodeURIComponent(groupId)}`);
    const data = res.data || {};
    const metadata = {
      timestamp: now,
      subject: data.subject || 'Grupo WhatsApp',
      announce: data.announce || false,
      joinApprovalMode: data.joinApprovalMode || false,
      participants: data.participants || [],
    };
    groupCache.set(groupId, metadata);
    return metadata;
  } catch (error) {
    console.error(`[AntiSpam] Erro ao buscar metadados do grupo ${groupId}:`, error.response?.data || error.message);
    return cached || { timestamp: 0, subject: 'Grupo WhatsApp', participants: [] };
  }
}

/**
 * Checa se o participante que enviou a mensagem é Administrador do grupo
 */
function isSenderAdmin(participant, participantsList) {
  if (!participant) return false;

  const rawSender = String(participant).trim();
  const cleanSender = cleanIdentifier(rawSender);

  // 1. Super-Whitelist: O número do administrador/dono (imune em qualquer grupo)
  const alertPhoneClean = cleanIdentifier(db.getSetting('antispam_alert_phone') || '5518996161744');
  if (cleanSender === alertPhoneClean || cleanSender === '5518996161744' || cleanSender === '236725829910627') {
    return true;
  }

  // 2. Checa administradores da lista de participantes do grupo
  if (!Array.isArray(participantsList)) return false;

  for (const p of participantsList) {
    const isAdmin = p.isAdmin || p.isSuperAdmin || p.admin === 'admin' || p.admin === 'superadmin';
    if (!isAdmin) continue;

    // Checa pelo JID original (@lid ou @s.whatsapp.net ou @c.us)
    if (rawSender === p.id || rawSender === p.phoneNumber) {
      return true;
    }

    // Checa pelo número limpo normalizado
    const cleanPId = cleanIdentifier(p.id);
    const cleanPhone = cleanIdentifier(p.phoneNumber);
    if ((cleanSender && cleanSender === cleanPId) || (cleanSender && cleanSender === cleanPhone)) {
      return true;
    }
  }

  return false;
}

/**
 * Checa se o bot tem privilégio de admin no grupo para poder moderar
 */
function isBotAdmin(participantsList) {
  if (!Array.isArray(participantsList)) return false;
  return participantsList.some(p => {
    const isAdmin = p.isAdmin || p.isSuperAdmin || p.admin === 'admin' || p.admin === 'superadmin';
    if (!isAdmin) return false;
    const cleanId = cleanIdentifier(p.id);
    const cleanPhone = cleanIdentifier(p.phoneNumber);
    return cleanId === '4141137051722' || cleanPhone === '5518998140806' || p.isMe === true || p.admin === 'superadmin';
  });
}

/**
 * Retorna lista de IDs de grupos que devem ser ativamente monitorados
 */
async function getMonitoredGroupIds() {
  const custom = (db.getSetting('antispam_target_groups') || '').trim();
  if (custom) {
    return custom.split(',').map(s => s.trim()).filter(Boolean);
  }

  const { client, session } = getWahaClient();
  try {
    const res = await client.get(`/api/${session}/groups`);
    const data = res.data || {};
    const groupEntries = Array.isArray(data) ? data.map(g => [g.id, g]) : Object.entries(data);

    const monitored = [];
    for (const [id] of groupEntries) {
      const meta = await getGroupMetadata(id);
      if (isBotAdmin(meta.participants)) {
        monitored.push(id);
      }
    }
    return monitored.length > 0 ? monitored : ['120363411570104365@g.us', '120363405736419547@g.us'];
  } catch (err) {
    return ['120363411570104365@g.us', '120363405736419547@g.us'];
  }
}

let isWatching = false;
const processedMessageIds = new Set();

/**
 * Monitor ativo 24/7 (Polling de mensagens recentes no WAHA)
 * Funciona imediatamente mesmo se webhook público não estiver configurado
 */
async function startSpamWatcher() {
  if (isWatching) return;
  isWatching = true;
  console.log('[AntiSpam] 🛡️ Monitor de Spam 24/7 Ativado (Varredura Contínua)');

  // Pre-carrega IDs das mensagens recentes para não processar histórico antigo
  try {
    const groups = await getMonitoredGroupIds();
    const { client, session } = getWahaClient();
    for (const gid of groups) {
      try {
        const res = await client.get(`/api/${session}/chats/${encodeURIComponent(gid)}/messages?limit=25`);
        if (Array.isArray(res.data)) {
          res.data.forEach(m => { if (m.id) processedMessageIds.add(m.id); });
        }
      } catch (e) {}
    }
  } catch (err) {
    console.error('[AntiSpam] Erro ao pré-carregar histórico:', err.message);
  }

  // Loop contínuo a cada 2.5 segundos
  setInterval(async () => {
    try {
      const isAntispamActive = db.getSetting('antispam_active') !== 'false';
      if (!isAntispamActive) return;

      const groups = await getMonitoredGroupIds();
      const { client, session } = getWahaClient();

      for (const gid of groups) {
        try {
          const res = await client.get(`/api/${session}/chats/${encodeURIComponent(gid)}/messages?limit=10`);
          const messages = res.data || [];

          for (const msg of messages) {
            if (!msg || !msg.id || processedMessageIds.has(msg.id)) continue;
            processedMessageIds.add(msg.id);

            // Limpa o Set caso fique muito grande
            if (processedMessageIds.size > 2000) {
              const it = processedMessageIds.values();
              for (let i = 0; i < 500; i++) processedMessageIds.delete(it.next().value);
            }

            if (msg.fromMe) continue;

            const payload = {
              id: msg.id,
              from: msg.from || gid,
              participant: msg.participant,
              body: msg.body,
              hasMedia: !!(msg.hasMedia || (msg.media && msg.media.url)),
              media: msg.media,
              mentionedIds: msg._data?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [],
              fromMe: msg.fromMe,
            };

            await processarEventoWaha('message', payload);
          }
        } catch (chatErr) {}
      }
    } catch (loopErr) {}
  }, 2500);
}

const groupLockCooldown = new Map(); // chatId -> timestamp do último lock executado
const adminAlertCooldown = new Map(); // chatId -> timestamp do último alerta enviado

/**
 * Executa as contra-medidas imediatas para neutralizar o ataque
 * Ordem estrita de execução:
 * 1. Trancar o grupo imediatamente (ou expulsar atacante)
 * 2. Expulsar invasor
 * 3. Apagar mensagem
 * 4. Enviar apenas UM aviso de alerta para o administrador por ataque
 */
async function neutralizarInvasor({ chatId, messageId, participant, reason, body, hasMedia }) {
  const { client, session } = getWahaClient();
  const alertPhone = db.getSetting('antispam_alert_phone') || '5518996161744';
  const shouldLock = db.getSetting('antispam_lock_group_on_attack') !== 'false';
  const shouldKick = db.getSetting('antispam_kick_attacker') !== 'false';
  const shouldDelete = db.getSetting('antispam_delete_message') !== 'false';

  const metadata = await getGroupMetadata(chatId);
  const groupName = metadata.subject || chatId;
  const messagePreview = (body || (hasMedia ? '[Mídia/Imagem/Vídeo/Figurinha]' : '')).slice(0, 150);

  console.warn(`[AntiSpam] ⚠️ ATAQUE DETECTADO no grupo "${groupName}" (${chatId})`);
  console.warn(`[AntiSpam] Invasor: ${participant} | Motivo: ${reason}`);

  const actionsTaken = [];
  const now = Date.now();

  // ============================================================
  // 1. PRIMEIRA AÇÃO PRIORITÁRIA: Trancar o grupo imediatamente
  // Corta instantaneamente qualquer nova mensagem no grupo
  // ============================================================
  if (shouldLock) {
    const lastLock = groupLockCooldown.get(chatId) || 0;
    // Só envia requisição de lock se não foi trancado nos últimos 5 minutos (evita 429 rate-overlimit)
    if (now - lastLock > 5 * 60 * 1000) {
      try {
        await client.put(`/api/${session}/groups/${encodeURIComponent(chatId)}/settings/security/messages-admin-only`, {
          adminsOnly: true,
        });
        groupLockCooldown.set(chatId, now);
        actionsTaken.push('Grupo trancado (Apenas Admins)');
        console.log(`[AntiSpam] 🔒 Grupo "${groupName}" trancado com prioridade máxima.`);
      } catch (err) {
        console.error('[AntiSpam] Erro ao trancar mensagens do grupo:', err.response?.data || err.message);
      }

      // Garante que só admins editam dados do grupo
      try {
        await client.put(`/api/${session}/groups/${encodeURIComponent(chatId)}/settings/security/info-admin-only`, {
          adminsOnly: true,
        });
      } catch (e) {}

      // Ativa aprovação de novos membros para impedir reentrada automática
      try {
        await client.put(`/api/${session}/groups/${encodeURIComponent(chatId)}/settings/security/membership-approval`, {
          newMembersApprovalRequired: true,
        });
        actionsTaken.push('Aprovação de entrada ativada');
      } catch (e) {}
    } else {
      actionsTaken.push('Grupo já estava trancado');
    }
  }

  // ============================================================
  // 2. SEGUNDA AÇÃO PRIORITÁRIA: Expulsar o atacante do grupo
  // ============================================================
  if (shouldKick && participant) {
    try {
      await client.post(`/api/${session}/groups/${encodeURIComponent(chatId)}/participants/remove`, {
        participants: [participant],
      });
      actionsTaken.push('Invasor banido');
      console.log(`[AntiSpam] 🚫 Invasor ${participant} expulso do grupo.`);
    } catch (err) {
      console.error('[AntiSpam] Erro ao expulsar invasor:', err.response?.data || err.message);
    }
  }

  // ============================================================
  // 3. TERCEIRA AÇÃO: Apagar a mensagem ofensiva para todos
  // ============================================================
  if (shouldDelete && messageId) {
    try {
      await client.delete(`/api/${session}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`);
      actionsTaken.push('Mensagem apagada');
      console.log(`[AntiSpam] 🗑️ Mensagem ${messageId} apagada com sucesso.`);
    } catch (err) {
      console.error('[AntiSpam] Erro ao apagar mensagem:', err.response?.data || err.message);
    }
  }

  // ============================================================
  // 4. Registro no banco de dados para auditoria interna
  // ============================================================
  try {
    db.prepare(`
      INSERT INTO antispam_logs (group_id, group_name, participant_id, participant_phone, message_id, reason, message_preview, action_taken)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chatId,
      groupName,
      participant,
      cleanIdentifier(participant),
      messageId || 'N/A',
      reason,
      messagePreview,
      actionsTaken.join(', ') || 'Nenhuma'
    );
  } catch (err) {
    console.error('[AntiSpam] Erro ao salvar log no banco:', err.message);
  }

  // ============================================================
  // 5. Enviar APENAS UMA MENSAGEM DE AVISO para o Administrador
  // Cooldown de 5 minutos por grupo para não inundar o privado
  // ============================================================
  if (alertPhone) {
    const lastAlert = adminAlertCooldown.get(chatId) || 0;
    const cooldownTime = 5 * 60 * 1000; // 5 minutos entre notificações no WhatsApp

    if (now - lastAlert > cooldownTime) {
      adminAlertCooldown.set(chatId, now);

      try {
        let formattedAlertPhone = alertPhone.includes('@') ? alertPhone : `${cleanIdentifier(alertPhone)}@c.us`;
        const alertMsg = 
          `🚨 *ALERTA DE SEGURANÇA: ATAQUE NO GRUPO* 🚨\n\n` +
          `👥 *Grupo:* ${groupName}\n` +
          `👤 *Invasor:* ${participant}\n` +
          `🛑 *Motivo:* ${reason}\n` +
          (messagePreview ? `💬 *Prévia:* "${messagePreview}"\n\n` : '\n') +
          `⚙️ *Ações executadas imediatamente:*\n` +
          `🔒 1. Envio de mensagens trancado (Apenas Admins)\n` +
          `🚫 2. Invasor banido do grupo\n` +
          `🗑️ 3. Mensagem ofensiva apagada para todos\n` +
          `🛡️ 4. Aprovação de novos membros ativada\n\n` +
          `ℹ️ *Nota:* O grupo permanece bloqueado para segurança. Destranque pelo painel após verificar. Demais mensagens de spam continuarão sendo neutralizadas silenciosamente sem repetir este aviso.`;

        await client.post('/api/sendText', {
          session,
          chatId: formattedAlertPhone,
          text: alertMsg,
        });
        console.log(`[AntiSpam] 📲 Único alerta de ataque enviado para o administrador (${formattedAlertPhone}).`);
      } catch (err) {
        console.error('[AntiSpam] Falha ao enviar alerta no WhatsApp:', err.response?.data || err.message);
      }
    } else {
      console.log(`[AntiSpam] 🔕 Alerta no WhatsApp omitido (cooldown de aviso único ativo).`);
    }
  }
}

/**
 * Analisa a mensagem com todas as regras de detecção de spam
 */
function avaliarSpam({ chatId, participant, body, hasMedia, mediaType, mentionedIds }) {
  const now = Date.now();
  const text = (body || '').toLowerCase().trim();

  // Regra 1: Bloqueio de qualquer mídia enviada por membro comum (Anti-Pornô instantâneo)
  const blockMedia = db.getSetting('antispam_block_all_media') !== 'false';
  if (blockMedia && hasMedia) {
    return 'Envio não autorizado de mídia/arquivo por membro comum';
  }

  // Regra 2: Vocabulário Adulto / Pornografia Explícita em Texto
  const nsfwRegex = /(nude|nudes|vazados|vazou|novinhas|novinha|putaria|porno|porn|onlyfans|privacy|xvideos|redtube|acompanhante|fatalmodel|jobzin|safadas|conteudo\s*adulto|fotos\s*intimas|gp\b|prostitu|pack\s*de\s*pe|caiu\s*na\s*net|camzap|chaturbate|boquete|suruba)/i;
  if (nsfwRegex.test(text)) {
    return 'Conteúdo adulto/pornográfico detectado em texto';
  }

  // Regra 3: Links proibidos (Grupos concorrentes, canais Telegram, encurtadores)
  const checkLinks = db.getSetting('antispam_anti_links') !== 'false';
  if (checkLinks) {
    const forbiddenLinkRegex = /(chat\.whatsapp\.com|t\.me\/|telegram\.me\/|discord\.gg\/|bit\.ly\/|tinyurl\.com\/|cutt\.ly\/|is\.gd\/|rb\.gy\/|abre\.ai\/|linktr\.ee\/)/i;
    if (forbiddenLinkRegex.test(text)) {
      return 'Divulgação de link/convite de grupo proibido';
    }
  }

  // Regra 4: Menção em massa (@everyone, @all ou múltiplos membros marcados)
  if (Array.isArray(mentionedIds) && mentionedIds.length >= 3) {
    return `Menção em massa (${mentionedIds.length} membros marcados)`;
  }
  if (text.includes('@everyone') || text.includes('@all') || text.includes('@todos')) {
    return 'Tentativa de menção global (@everyone/@all)';
  }

  // Regra 5: Anti-Flood e Mensagens Repetidas
  const checkFlood = db.getSetting('antispam_anti_flood') !== 'false';
  if (checkFlood) {
    const historyKey = `${chatId}:${participant}`;
    if (!userMessageHistory.has(historyKey)) {
      userMessageHistory.set(historyKey, []);
    }

    const history = userMessageHistory.get(historyKey);
    // Filtra histórico dos últimos 8 segundos
    const recent = history.filter(msg => now - msg.timestamp < 8000);

    // Se enviou 3 mensagens em 8 segundos -> Flood
    if (recent.length >= 3) {
      return 'Flood de mensagens (>3 mensagens em 8s)';
    }

    // Repetição de mensagem idêntica em curto intervalo
    if (text.length > 4 && recent.some(m => m.body === text)) {
      return 'Mensagem repetida idêntica (Spam Loop)';
    }

    recent.push({ timestamp: now, body: text });
    userMessageHistory.set(historyKey, recent);
  }

  return null;
}

/**
 * Handler principal chamado pelo webhook do WAHA
 */
async function processarEventoWaha(event, payload) {
  // Apenas processa mensagens recebidas
  if (!payload || (event !== 'message' && event !== 'message.any')) {
    return;
  }

  const {
    id: messageId,
    from: chatId,
    fromMe,
    participant,
    body,
    hasMedia,
    media,
    mentionedIds,
  } = payload;

  // Ignora mensagens enviadas pelo próprio bot
  if (fromMe) return;

  // Ignora se não for grupo (grupos no WhatsApp terminam com @g.us)
  if (!chatId || !chatId.endsWith('@g.us')) return;

  // Se o participante não veio informado, não há como moderar
  if (!participant) return;

  // Verifica se o AntiSpam está ativo nas configurações
  const isAntispamActive = db.getSetting('antispam_active') !== 'false';
  if (!isAntispamActive) return;

  // Verifica se há grupos específicos configurados
  const targetGroupsSetting = (db.getSetting('antispam_target_groups') || '').trim();
  if (targetGroupsSetting) {
    const allowedGroups = targetGroupsSetting.split(',').map(s => s.trim());
    if (!allowedGroups.includes(chatId)) {
      return; // Grupo não está na lista de monitoramento
    }
  }

  // Busca lista de participantes e metadados do grupo
  const groupData = await getGroupMetadata(chatId);

  // REGRA DE OURO: SE FOR ADMIN, PERMITE TUDO (SEM QUALQUER RESTRIÇÃO)
  if (isSenderAdmin(participant, groupData.participants)) {
    // console.log(`[AntiSpam] Mensagem de ADMIN permitida no grupo ${groupData.subject} (${participant})`);
    return;
  }

  // Avalia se a mensagem de membro comum constitui spam
  const motivoSpam = avaliarSpam({
    chatId,
    participant,
    body,
    hasMedia: !!(hasMedia || (media && media.url)),
    mentionedIds,
  });

  if (motivoSpam) {
    await neutralizarInvasor({
      chatId,
      messageId,
      participant,
      reason: motivoSpam,
      body,
      hasMedia: !!(hasMedia || (media && media.url)),
    });
  }
}

/**
 * Endpoint Express para o Webhook do WAHA
 */
async function handleWahaWebhook(req, res) {
  // Responde imediatamente com HTTP 200 para evitar timeout no WAHA
  res.status(200).json({ success: true });

  try {
    const { event, payload } = req.body || {};
    if (event && payload) {
      await processarEventoWaha(event, payload);
    }
  } catch (error) {
    console.error('[AntiSpam] Erro ao processar webhook:', error.message);
  }
}

/**
 * Tranca ou destranca um grupo manualmente
 */
async function setGroupLock(groupId, adminsOnly) {
  const { client, session } = getWahaClient();
  const res = await client.put(`/api/${session}/groups/${encodeURIComponent(groupId)}/settings/security/messages-admin-only`, {
    adminsOnly: Boolean(adminsOnly),
  });

  // Atualiza cache local
  if (groupCache.has(groupId)) {
    groupCache.get(groupId).announce = Boolean(adminsOnly);
  }

  return res.data;
}

/**
 * Registra/configura automaticamente o webhook do WAHA apontando para este servidor
 */
async function configureWahaWebhook(publicWebhookUrl) {
  const { client, session } = getWahaClient();
  try {
    // Busca configuração atual da sessão
    const sessionRes = await client.get(`/api/sessions/${session}`);
    const currentConfig = sessionRes.data?.config || {};
    const existingWebhooks = currentConfig.webhooks || [];

    // Checa se o webhook já está registrado
    const alreadyConfigured = existingWebhooks.some(w => w.url === publicWebhookUrl);
    if (alreadyConfigured) {
      return { success: true, message: 'Webhook já estava configurado no WAHA.' };
    }

    const updatedWebhooks = [
      ...existingWebhooks.filter(w => !w.url.includes('/webhook/waha')),
      {
        url: publicWebhookUrl,
        events: ['message'],
      },
    ];

    await client.put(`/api/sessions/${session}`, {
      name: session,
      config: {
        ...currentConfig,
        webhooks: updatedWebhooks,
      },
    });

    return { success: true, message: 'Webhook configurado no WAHA com sucesso!' };
  } catch (error) {
    console.error('[AntiSpam] Erro ao auto-configurar webhook no WAHA:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = {
  handleWahaWebhook,
  processarEventoWaha,
  getGroupMetadata,
  isSenderAdmin,
  neutralizarInvasor,
  setGroupLock,
  configureWahaWebhook,
  getWahaClient,
  startSpamWatcher,
};
