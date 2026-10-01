// ================================================
// CartRecover — Dashboard Application
// ================================================

(function () {
  'use strict';

  // ==========================================
  // State
  // ==========================================
  let currentPage = 'dashboard';
  let cartsPage = 1;
  let logsPage = 1;
  let refreshInterval = null;

  // ==========================================
  // DOM References
  // ==========================================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ==========================================
  // API Helpers
  // ==========================================
  async function api(url, options = {}) {
    try {
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error(`API Error [${url}]:`, err);
      throw err;
    }
  }

  // ==========================================
  // Toast Notifications
  // ==========================================
  function showToast(message, type = 'info') {
    const container = $('#toastContainer');
    const icons = { success: '✅', error: '❌', info: 'ℹ️' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ==========================================
  // Navigation
  // ==========================================
  function navigate(page) {
    currentPage = page;

    // Update nav
    $$('.nav-item').forEach((item) => item.classList.remove('active'));
    $(`[data-page="${page}"]`).classList.add('active');

    // Update pages
    $$('.page').forEach((p) => p.classList.remove('active'));
    $(`#page-${page}`).classList.add('active');

    // Update title
    const titles = {
      dashboard: 'Dashboard',
      carts: 'Carrinhos Abandonados',
      logs: 'Logs de Mensagens',
      settings: 'Configurações',
    };
    $('#pageTitle').textContent = titles[page] || 'Dashboard';

    // Load page data
    if (page === 'dashboard') loadDashboard();
    if (page === 'carts') loadCarts();
    if (page === 'logs') loadLogs();
    if (page === 'settings') loadSettings();
  }

  // ==========================================
  // Dashboard
  // ==========================================
  async function loadDashboard() {
    try {
      const stats = await api('/api/stats');

      // Update stat cards with animation
      animateValue('statTotalCarts', stats.totalCarts);
      animateValue('statPendingCarts', stats.pendingCarts);
      animateValue('statSentCarts', stats.sentCarts);
      animateValue('statRecoveredCarts', stats.recoveredCarts);

      // Recovery rate circle
      const rate = parseFloat(stats.recoveryRate) || 0;
      const circumference = 327; // 2 * PI * 52
      const offset = circumference - (rate / 100) * circumference;
      const circle = $('#rateCircle');
      if (circle) {
        circle.style.transition = 'stroke-dashoffset 1s ease';
        circle.style.strokeDashoffset = offset;
      }
      $('#recoveryRate').textContent = `${rate}%`;

      // Money values
      const recoveredFormatted = (stats.recoveredAmount / 100).toFixed(2).replace('.', ',');
      const totalFormatted = (stats.totalAmount / 100).toFixed(2).replace('.', ',');
      $('#recoveredAmount').textContent = recoveredFormatted;
      $('#totalAmount').textContent = totalFormatted;

      // Recent stats
      $('#recentCarts').textContent = stats.recentCarts;
      $('#recentRecovered').textContent = stats.recentRecovered;

      // Load recent carts table
      loadRecentCarts();
    } catch (err) {
      console.error('Failed to load dashboard:', err);
    }
  }

  function animateValue(elementId, target) {
    const el = $(`#${elementId}`);
    const current = parseInt(el.textContent) || 0;
    const diff = target - current;
    if (diff === 0) return;

    const duration = 600;
    const steps = 30;
    const increment = diff / steps;
    let step = 0;

    const timer = setInterval(() => {
      step++;
      el.textContent = Math.round(current + increment * step);
      if (step >= steps) {
        el.textContent = target;
        clearInterval(timer);
      }
    }, duration / steps);
  }

  async function loadRecentCarts() {
    try {
      const data = await api('/api/carts?limit=5');
      const tbody = $('#recentCartsBody');

      if (!data.carts || data.carts.length === 0) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Nenhum carrinho registrado ainda. Configure o webhook da Bestfy para começar.</td></tr>';
        return;
      }

      tbody.innerHTML = data.carts
        .map((cart) => `
          <tr>
            <td><strong style="color: var(--text-primary)">${escHtml(cart.customer_name)}</strong></td>
            <td>${escHtml(cart.customer_phone)}</td>
            <td><strong style="color: var(--text-primary)">${cart.amount_formatted}</strong></td>
            <td>${getBadge(cart.status)}</td>
            <td>${formatDate(cart.created_at)}</td>
            <td>
              <button class="btn-action btn-resend" onclick="resendCart(${cart.id})" title="Reenviar">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>
              </button>
              <button class="btn-action" onclick="viewCart(${cart.id})" title="Detalhes">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
            </td>
          </tr>
        `)
        .join('');
    } catch (err) {
      console.error('Failed to load recent carts:', err);
    }
  }

  // ==========================================
  // Carts Page
  // ==========================================
  async function loadCarts() {
    try {
      const filter = $('#cartFilter').value;
      const search = $('#cartSearch').value;
      const data = await api(`/api/carts?status=${filter}&page=${cartsPage}&limit=15&search=${encodeURIComponent(search)}`);
      const tbody = $('#cartsBody');

      if (!data.carts || data.carts.length === 0) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="8">Nenhum carrinho encontrado</td></tr>';
        $('#cartsPagination').innerHTML = '';
        return;
      }

      tbody.innerHTML = data.carts
        .map((cart) => {
          const productNames = cart.items.map((i) => i.title).join(', ');
          return `
            <tr>
              <td style="color: var(--text-tertiary)">#${cart.id}</td>
              <td><strong style="color: var(--text-primary)">${escHtml(cart.customer_name)}</strong><br><small style="color: var(--text-tertiary)">${escHtml(cart.customer_email)}</small></td>
              <td>${escHtml(cart.customer_phone)}</td>
              <td><strong style="color: var(--text-primary)">${cart.amount_formatted}</strong></td>
              <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escHtml(productNames)}">${escHtml(productNames)}</td>
              <td>${getBadge(cart.status)}</td>
              <td>${formatDate(cart.scheduled_at)}</td>
              <td>
                <button class="btn-action btn-resend" onclick="resendCart(${cart.id})" title="Reenviar">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>
                </button>
                <button class="btn-action" onclick="viewCart(${cart.id})" title="Detalhes">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
                <button class="btn-action btn-delete" onclick="deleteCart(${cart.id})" title="Excluir">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                </button>
              </td>
            </tr>
          `;
        })
        .join('');

      // Pagination
      renderPagination('cartsPagination', data.page, data.totalPages, (p) => {
        cartsPage = p;
        loadCarts();
      });
    } catch (err) {
      console.error('Failed to load carts:', err);
    }
  }

  // ==========================================
  // Logs Page
  // ==========================================
  async function loadLogs() {
    try {
      const data = await api(`/api/logs?page=${logsPage}&limit=30`);
      const tbody = $('#logsBody');

      if (!data.logs || data.logs.length === 0) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Nenhum log de mensagem encontrado</td></tr>';
        return;
      }

      tbody.innerHTML = data.logs
        .map((log) => `
          <tr>
            <td>${formatDate(log.sent_at)}</td>
            <td>${escHtml(log.customer_name || 'N/A')}</td>
            <td>${escHtml(log.phone)}</td>
            <td>${log.status === 'sent'
              ? '<span class="badge badge-sent">Enviado</span>'
              : '<span class="badge badge-failed">Falhou</span>'
            }</td>
            <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escHtml(log.error_message || '—')}</td>
          </tr>
        `)
        .join('');

      renderPagination('logsPagination', data.page, data.totalPages, (p) => {
        logsPage = p;
        loadLogs();
      });
    } catch (err) {
      console.error('Failed to load logs:', err);
    }
  }

  // ==========================================
  // Settings
  // ==========================================
  async function loadSettings() {
    try {
      const settings = await api('/api/settings');

      $('#settingActive').checked = settings.active === 'true';
      $('#activeLabel').textContent = settings.active === 'true' ? 'Ativo' : 'Inativo';
      $('#settingDelay').value = settings.recovery_delay_minutes || '30';
      $('#settingWahaUrl').value = settings.waha_api_url || '';
      $('#settingWahaSession').value = settings.waha_session || 'default';
      $('#settingWahaKey').value = settings.waha_api_key || '';
      $('#settingMessage').value = settings.recovery_message || '';

      $('#settingPaidActive').checked = settings.paid_message_active !== 'false';
      $('#paidActiveLabel').textContent = settings.paid_message_active !== 'false' ? 'Ativo' : 'Inativo';
      $('#settingPaidMessage').value = settings.paid_message || '';

      updateMessagePreview();
      updatePaidMessagePreview();
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  }

  async function saveSettings(e) {
    e.preventDefault();

    try {
      const payload = {
        active: $('#settingActive').checked ? 'true' : 'false',
        recovery_delay_minutes: $('#settingDelay').value,
        waha_api_url: $('#settingWahaUrl').value,
        waha_session: $('#settingWahaSession').value,
        waha_api_key: $('#settingWahaKey').value,
        recovery_message: $('#settingMessage').value,
        paid_message_active: $('#settingPaidActive').checked ? 'true' : 'false',
        paid_message: $('#settingPaidMessage').value,
      };

      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });

      showToast('Configurações salvas com sucesso!', 'success');
    } catch (err) {
      showToast('Erro ao salvar configurações', 'error');
    }
  }

  function updateMessagePreview() {
    const template = $('#settingMessage').value || '';
    const preview = template
      .replace(/\{nome\}/g, 'Maria')
      .replace(/\{produtos\}/g, '  • Camiseta Básica (2x) - R$ 49,90\n  • Calça Jeans (1x) - R$ 129,90')
      .replace(/\{valor\}/g, '229,70')
      .replace(/\{link\}/g, 'https://link.compra.com.br/checkout/abc123');

    $('#messagePreview').textContent = preview;
  }

  function updatePaidMessagePreview() {
    const template = $('#settingPaidMessage').value || '';
    const preview = template
      .replace(/\{nome\}/g, 'Samuel')
      .replace(/\{produtos\}/g, '  • Overcooked (Mídia Digital) - PS4 (1x) - R$ 9,43')
      .replace(/\{valor\}/g, '9,43')
      .replace(/\{link\}/g, 'https://pagamento.sagamespro.com.br');

    $('#paidMessagePreview').textContent = preview;
  }

  // ==========================================
  // Cart Actions
  // ==========================================
  window.resendCart = async function (id) {
    try {
      const result = await api(`/api/carts/${id}/resend`, { method: 'POST' });
      showToast(result.message || 'Mensagem reenviada!', result.success ? 'success' : 'error');
      if (currentPage === 'dashboard') loadDashboard();
      if (currentPage === 'carts') loadCarts();
    } catch (err) {
      showToast('Erro ao reenviar mensagem', 'error');
    }
  };

  window.sendPaidConfirmation = async function (id) {
    try {
      const result = await api(`/api/carts/${id}/send-paid`, { method: 'POST' });
      showToast(result.message || 'Confirmação enviada!', result.success ? 'success' : 'error');
      if (currentPage === 'dashboard') loadDashboard();
      if (currentPage === 'carts') loadCarts();
      if (currentPage === 'logs') loadLogs();
    } catch (err) {
      showToast('Erro ao enviar confirmação', 'error');
    }
  };

  window.deleteCart = async function (id) {
    if (!confirm('Tem certeza que deseja excluir este carrinho?')) return;

    try {
      await api(`/api/carts/${id}`, { method: 'DELETE' });
      showToast('Carrinho excluído', 'success');
      if (currentPage === 'dashboard') loadDashboard();
      if (currentPage === 'carts') loadCarts();
    } catch (err) {
      showToast('Erro ao excluir', 'error');
    }
  };

  window.viewCart = async function (id) {
    try {
      const cart = await api(`/api/carts/${id}`);
      const items = cart.items || [];

      const itemsHtml = items
        .map((i) => `<li>${escHtml(i.title)} (${i.quantity}x) — R$ ${(i.unitPrice / 100).toFixed(2).replace('.', ',')}</li>`)
        .join('');

      const logsHtml = (cart.logs || [])
        .map((log) => `
          <div style="padding: 8px 0; border-bottom: 1px solid var(--surface-2); font-size: 12px;">
            <span style="color: ${log.status === 'sent' ? 'var(--success)' : 'var(--danger)'};">${log.status === 'sent' ? '✅ Enviado' : '❌ Falhou'}</span>
            <span style="color: var(--text-tertiary); margin-left: 8px;">${formatDate(log.sent_at)}</span>
            ${log.error_message ? `<br><small style="color: var(--danger)">${escHtml(log.error_message)}</small>` : ''}
          </div>
        `)
        .join('');

      $('#modalTitle').textContent = `Carrinho #${cart.id}`;
      $('#modalBody').innerHTML = `
        <div class="detail-row"><span class="detail-label">Cliente</span><span class="detail-value">${escHtml(cart.customer_name)}</span></div>
        <div class="detail-row"><span class="detail-label">E-mail</span><span class="detail-value">${escHtml(cart.customer_email || 'N/A')}</span></div>
        <div class="detail-row"><span class="detail-label">Telefone</span><span class="detail-value">${escHtml(cart.customer_phone)}</span></div>
        <div class="detail-row"><span class="detail-label">Valor</span><span class="detail-value" style="color: var(--success); font-weight: 700;">${cart.amount_formatted}</span></div>
        <div class="detail-row"><span class="detail-label">Status Pagamento</span><span class="detail-value">${escHtml(cart.payment_status)}</span></div>
        <div class="detail-row"><span class="detail-label">Status</span><span class="detail-value">${getBadge(cart.status)}</span></div>
        <div class="detail-row"><span class="detail-label">Agendado para</span><span class="detail-value">${formatDate(cart.scheduled_at)}</span></div>
        <div class="detail-row"><span class="detail-label">Criado em</span><span class="detail-value">${formatDate(cart.created_at)}</span></div>
        ${cart.secure_url ? `<div class="detail-row"><span class="detail-label">Link de Pagamento</span><span class="detail-value"><a href="${escHtml(cart.secure_url)}" target="_blank" style="color: var(--accent)">Abrir →</a></span></div>` : ''}
        <div style="margin-top: 16px;">
          <strong style="font-size: 13px;">Produtos:</strong>
          <ul style="padding-left: 20px; margin-top: 8px; color: var(--text-secondary); font-size: 13px;">${itemsHtml}</ul>
        </div>
        ${logsHtml ? `<div style="margin-top: 16px;"><strong style="font-size: 13px;">Histórico de Mensagens:</strong>${logsHtml}</div>` : ''}
        <div style="margin-top: 20px; display: flex; gap: 10px; flex-wrap: wrap;">
          <button class="btn btn-secondary" onclick="resendCart(${cart.id})" style="font-size: 12px; padding: 8px 14px;">
            📨 Reenviar Recuperação
          </button>
          <button class="btn btn-primary" onclick="sendPaidConfirmation(${cart.id})" style="font-size: 12px; padding: 8px 14px; background: var(--success); border-color: var(--success);">
            🎉 Disparar Pagamento Confirmado
          </button>
        </div>
      `;

      $('#modalOverlay').classList.add('active');
    } catch (err) {
      showToast('Erro ao carregar detalhes', 'error');
    }
  };

  // ==========================================
  // Helpers
  // ==========================================
  function getBadge(status) {
    const map = {
      pending: '<span class="badge badge-pending">Pendente</span>',
      sent: '<span class="badge badge-sent">Enviado</span>',
      recovered: '<span class="badge badge-recovered">Recuperado</span>',
      failed: '<span class="badge badge-failed">Falhou</span>',
    };
    return map[status] || `<span class="badge">${status}</span>`;
  }

  function formatDate(dateStr) {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
  }

  function escHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderPagination(containerId, current, total, callback) {
    const container = $(`#${containerId}`);
    if (total <= 1) {
      container.innerHTML = '';
      return;
    }

    let html = '';
    html += `<button ${current <= 1 ? 'disabled' : ''} data-page="${current - 1}">← Anterior</button>`;

    for (let i = 1; i <= total; i++) {
      if (i === 1 || i === total || (i >= current - 1 && i <= current + 1)) {
        html += `<button class="${i === current ? 'active' : ''}" data-page="${i}">${i}</button>`;
      } else if (i === current - 2 || i === current + 2) {
        html += `<button disabled>...</button>`;
      }
    }

    html += `<button ${current >= total ? 'disabled' : ''} data-page="${current + 1}">Próximo →</button>`;

    container.innerHTML = html;
    container.querySelectorAll('button[data-page]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const page = parseInt(btn.dataset.page);
        if (page >= 1 && page <= total) callback(page);
      });
    });
  }

  // ==========================================
  // Event Listeners
  // ==========================================
  function init() {
    // Set webhook URL
    const baseUrl = window.location.origin;
    $('#webhookUrl').textContent = `${baseUrl}/webhook/bestfy`;

    // Navigation
    $$('.nav-item, [data-page]').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const page = item.dataset.page;
        if (page) navigate(page);
      });
    });

    // Mobile menu
    $('#mobileMenu').addEventListener('click', () => {
      $('#sidebar').classList.toggle('open');
    });

    // Close sidebar on overlay click (mobile)
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.sidebar') && !e.target.closest('#mobileMenu')) {
        $('#sidebar').classList.remove('open');
      }
    });

    // Copy webhook URL
    $('#copyWebhook').addEventListener('click', () => {
      navigator.clipboard.writeText(`${baseUrl}/webhook/bestfy`).then(() => {
        showToast('URL do webhook copiada!', 'success');
      });
    });

    // Cart filters
    $('#cartFilter').addEventListener('change', () => {
      cartsPage = 1;
      loadCarts();
    });

    let searchTimeout;
    $('#cartSearch').addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        cartsPage = 1;
        loadCarts();
      }, 400);
    });

    // Settings form
    $('#settingsForm').addEventListener('submit', saveSettings);

    // Toggle label
    $('#settingActive').addEventListener('change', (e) => {
      $('#activeLabel').textContent = e.target.checked ? 'Ativo' : 'Inativo';
    });

    // Message preview
    $('#settingMessage').addEventListener('input', updateMessagePreview);

    // Paid message toggle & preview
    $('#settingPaidActive').addEventListener('change', (e) => {
      $('#paidActiveLabel').textContent = e.target.checked ? 'Ativo' : 'Inativo';
    });
    $('#settingPaidMessage').addEventListener('input', updatePaidMessagePreview);

    // Modal close
    $('#modalClose').addEventListener('click', () => {
      $('#modalOverlay').classList.remove('active');
    });
    $('#modalOverlay').addEventListener('click', (e) => {
      if (e.target === $('#modalOverlay')) {
        $('#modalOverlay').classList.remove('active');
      }
    });

    // Auto-refresh dashboard every 30 seconds
    refreshInterval = setInterval(() => {
      if (currentPage === 'dashboard') {
        loadDashboard();
      }
    }, 30000);

    // Initial load
    loadDashboard();
  }

  // Start the app
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
