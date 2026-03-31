import { Router, Request, Response } from 'express';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('wa-manager');

export const waManagerRouter = Router();

waManagerRouter.get('/wa-manager', (req: Request, res: Response): void => {
  const secret = process.env.API_SECRET;
  const token = req.query.token as string;

  if (!secret || token !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  log.info('Serving wa-manager dashboard');

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>360Shmikley CRM</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      background: #f0f2f5;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Header ── */
    .header {
      background: #1a1a2e;
      color: #fff;
      padding: 12px 20px;
      display: flex;
      align-items: center;
      gap: 16px;
      flex-shrink: 0;
    }
    .header h1 { font-size: 18px; font-weight: 600; }
    .header .subtitle { font-size: 13px; color: #aab; }

    /* ── Tenant Tabs ── */
    .tabs {
      background: #16213e;
      display: flex;
      gap: 4px;
      padding: 8px 16px 0;
      flex-shrink: 0;
      overflow-x: auto;
    }
    .tab-btn {
      padding: 8px 20px;
      border: none;
      border-radius: 6px 6px 0 0;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      color: #aab;
      background: #0f3460;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .tab-btn:hover { background: #1a4a7a; color: #fff; }
    .tab-btn.active { background: #f0f2f5; color: #1a1a2e; }

    /* ── Main layout ── */
    .main {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    /* ── Conversation list (right for RTL) ── */
    .conv-panel {
      width: 320px;
      background: #fff;
      border-left: 1px solid #e0e0e0;
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }
    .conv-panel-header {
      padding: 14px 16px;
      font-weight: 600;
      font-size: 15px;
      border-bottom: 1px solid #e8e8e8;
      background: #fafafa;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .conv-list {
      overflow-y: auto;
      flex: 1;
    }
    .conv-item {
      padding: 12px 16px;
      border-bottom: 1px solid #f0f0f0;
      cursor: pointer;
      transition: background 0.1s;
    }
    .conv-item:hover { background: #f5f5f5; }
    .conv-item.active { background: #e8f4fd; border-right: 3px solid #0078d4; }
    .conv-name {
      font-weight: 600;
      font-size: 14px;
      color: #1a1a2e;
      margin-bottom: 3px;
    }
    .conv-preview {
      font-size: 12px;
      color: #666;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 260px;
    }
    .conv-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 4px;
    }
    .conv-status {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: 500;
    }
    .status-new { background: #e8f5e9; color: #2e7d32; }
    .status-in-conversation { background: #e3f2fd; color: #1565c0; }
    .status-escalated { background: #fff3e0; color: #e65100; }
    .status-closed-won { background: #e8f5e9; color: #1b5e20; }
    .status-closed-lost { background: #fce4ec; color: #880e4f; }
    .status-default { background: #f5f5f5; color: #555; }
    .conv-time { font-size: 11px; color: #999; }

    /* ── Message panel (left for RTL) ── */
    .msg-panel {
      flex: 1;
      background: #e5ddd5;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .msg-panel-header {
      padding: 14px 16px;
      background: #fff;
      border-bottom: 1px solid #e0e0e0;
      font-weight: 600;
      font-size: 15px;
    }
    .msg-list {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .bubble {
      max-width: 65%;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 14px;
      line-height: 1.4;
      word-break: break-word;
    }
    /* RTL: incoming = right side (align-self: flex-end in RTL = right) */
    .bubble-in {
      background: #fff;
      align-self: flex-end;
      border-bottom-right-radius: 2px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.1);
    }
    /* RTL: outgoing = left side */
    .bubble-out {
      background: #dcf8c6;
      align-self: flex-start;
      border-bottom-left-radius: 2px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.1);
    }
    .bubble-time {
      font-size: 10px;
      color: #999;
      margin-top: 3px;
      text-align: left;
    }

    /* ── Reply area ── */
    .reply-area {
      background: #f0f0f0;
      padding: 10px 14px;
      display: flex;
      gap: 10px;
      align-items: center;
      border-top: 1px solid #ddd;
    }
    .reply-input {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid #ccc;
      border-radius: 20px;
      font-size: 14px;
      outline: none;
      font-family: inherit;
      direction: rtl;
      resize: none;
      max-height: 80px;
    }
    .reply-input:focus { border-color: #0078d4; }
    .send-btn {
      padding: 10px 20px;
      background: #0078d4;
      color: #fff;
      border: none;
      border-radius: 20px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: background 0.15s;
      white-space: nowrap;
    }
    .send-btn:hover { background: #006bb3; }
    .send-btn:disabled { background: #aaa; cursor: not-allowed; }

    /* ── Empty states ── */
    .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #999;
      font-size: 14px;
      gap: 8px;
    }
    .empty-icon { font-size: 40px; }

    /* ── Loading indicator ── */
    .loading { text-align: center; padding: 20px; color: #999; font-size: 14px; }

    /* ── Auto-refresh indicator ── */
    .refresh-badge {
      font-size: 11px;
      color: #888;
      font-weight: normal;
    }

    /* ── Mobile responsive ── */
    @media (max-width: 640px) {
      .main { flex-direction: column; }
      .conv-panel { width: 100%; height: 40vh; border-left: none; border-bottom: 1px solid #e0e0e0; }
      .msg-panel { height: 60vh; }
    }
  </style>
</head>
<body>

<div class="header">
  <div>
    <h1>360Shmikley CRM</h1>
    <div class="subtitle">מערכת ניהול שיחות לידים</div>
  </div>
</div>

<div class="tabs" id="tabs">
  <div class="loading">טוען לשוניות...</div>
</div>

<div class="main">
  <!-- Conversation list panel (right in RTL) -->
  <div class="conv-panel">
    <div class="conv-panel-header">
      <span>שיחות</span>
      <span class="refresh-badge" id="refresh-badge">מתרענן...</span>
    </div>
    <div class="conv-list" id="conv-list">
      <div class="empty">
        <div class="empty-icon">💬</div>
        <div>בחר לשונית כדי לראות שיחות</div>
      </div>
    </div>
  </div>

  <!-- Message panel (left in RTL) -->
  <div class="msg-panel">
    <div class="msg-panel-header" id="msg-header">בחר שיחה</div>
    <div class="msg-list" id="msg-list">
      <div class="empty">
        <div class="empty-icon">📩</div>
        <div>בחר שיחה מהרשימה כדי לראות הודעות</div>
      </div>
    </div>
    <div class="reply-area">
      <input
        type="text"
        class="reply-input"
        id="reply-input"
        placeholder="הקלד הודעה..."
        disabled
      />
      <button class="send-btn" id="send-btn" disabled onclick="handleSend()">שלח</button>
    </div>
  </div>
</div>

<script>
  // ── State ──────────────────────────────────────────────────────────────────
  const token = new URLSearchParams(window.location.search).get('token') || '';
  let activeTenantId = null;
  let activePhone = null;
  let refreshTimer = null;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function apiUrl(path) {
    return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
  }

  function formatTime(dateStr) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
      const now = new Date();
      const diff = now - d;
      if (diff < 60000) return 'עכשיו';
      if (diff < 3600000) return Math.floor(diff / 60000) + ' ד׳';
      if (diff < 86400000) return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
      return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' });
    } catch { return ''; }
  }

  function statusLabel(status) {
    const map = {
      'new': 'חדש',
      'contacted': 'נוצר קשר',
      'in-conversation': 'בשיחה',
      'quote-sent': 'הצעה נשלחה',
      'meeting-scheduled': 'פגישה קבועה',
      'escalated': 'הועלה לבוס',
      'closed-won': 'נסגר - זכייה',
      'closed-lost': 'נסגר - הפסד',
    };
    return map[status] || status;
  }

  function statusClass(status) {
    if (status === 'new' || status === 'contacted') return 'status-new';
    if (status === 'in-conversation') return 'status-in-conversation';
    if (status === 'escalated') return 'status-escalated';
    if (status === 'closed-won') return 'status-closed-won';
    if (status === 'closed-lost') return 'status-closed-lost';
    return 'status-default';
  }

  // ── Load tenants into tab bar ──────────────────────────────────────────────

  async function loadTenants() {
    const tabsEl = document.getElementById('tabs');
    try {
      const res = await fetch(apiUrl('/wa-inbox/api/tenants'));
      if (!res.ok) { tabsEl.innerHTML = '<div class="loading">שגיאה בטעינת לשוניות</div>'; return; }
      const tenants = await res.json();
      if (!tenants.length) { tabsEl.innerHTML = '<div class="loading">אין דיירים פעילים</div>'; return; }

      tabsEl.innerHTML = '';
      for (const t of tenants) {
        const btn = document.createElement('button');
        btn.className = 'tab-btn';
        btn.textContent = t.business_name;
        btn.dataset.tenantId = t.id;
        btn.onclick = () => switchTab(t.id, btn, t.business_name);
        tabsEl.appendChild(btn);
      }

      // Auto-select first tab
      tabsEl.querySelector('.tab-btn').click();
    } catch (e) {
      tabsEl.innerHTML = '<div class="loading">שגיאה בחיבור לשרת</div>';
    }
  }

  // ── Switch tenant tab ──────────────────────────────────────────────────────

  function switchTab(tenantId, btn, businessName) {
    activeTenantId = tenantId;
    activePhone = null;

    // Update tab highlight
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Reset message panel
    document.getElementById('msg-header').textContent = 'בחר שיחה';
    document.getElementById('msg-list').innerHTML = \`
      <div class="empty">
        <div class="empty-icon">📩</div>
        <div>בחר שיחה מהרשימה כדי לראות הודעות</div>
      </div>
    \`;
    document.getElementById('reply-input').disabled = true;
    document.getElementById('send-btn').disabled = true;

    // Load conversations
    loadConversations(tenantId);

    // Reset auto-refresh
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      loadConversations(tenantId, true);
    }, 30000);
  }

  // ── Load conversations ─────────────────────────────────────────────────────

  async function loadConversations(tenantId, isRefresh) {
    const listEl = document.getElementById('conv-list');
    const badgeEl = document.getElementById('refresh-badge');

    if (!isRefresh) listEl.innerHTML = '<div class="loading">טוען שיחות...</div>';

    try {
      const res = await fetch(apiUrl('/wa-inbox/api/conversations?tenant_id=' + tenantId));
      if (!res.ok) { listEl.innerHTML = '<div class="loading">שגיאה בטעינה</div>'; return; }
      const convs = await res.json();

      if (!convs.length) {
        listEl.innerHTML = \`
          <div class="empty">
            <div class="empty-icon">📭</div>
            <div>אין שיחות לעסק זה</div>
          </div>
        \`;
        return;
      }

      listEl.innerHTML = '';
      for (const c of convs) {
        const item = document.createElement('div');
        item.className = 'conv-item' + (c.phone === activePhone ? ' active' : '');
        item.dataset.phone = c.phone;
        item.onclick = () => loadConversation(c.phone, c.name || c.phone, item);

        item.innerHTML = \`
          <div class="conv-name">\${escHtml(c.name || c.phone)}</div>
          <div class="conv-preview">\${escHtml(c.last_msg || 'אין הודעות')}</div>
          <div class="conv-meta">
            <span class="conv-status \${statusClass(c.status)}">\${statusLabel(c.status)}</span>
            <span class="conv-time">\${formatTime(c.last_msg_at || c.updated_at)}</span>
          </div>
        \`;
        listEl.appendChild(item);
      }

      if (isRefresh) {
        const now = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
        badgeEl.textContent = 'עודכן ' + now;
      }
    } catch (e) {
      if (!isRefresh) listEl.innerHTML = '<div class="loading">שגיאת חיבור</div>';
    }
  }

  // ── Load messages for a conversation ──────────────────────────────────────

  async function loadConversation(phone, displayName, itemEl) {
    activePhone = phone;
    activeTenantId = activeTenantId;

    // Update active state in list
    document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
    if (itemEl) itemEl.classList.add('active');

    document.getElementById('msg-header').textContent = displayName;
    document.getElementById('reply-input').disabled = false;
    document.getElementById('send-btn').disabled = false;

    const msgList = document.getElementById('msg-list');
    msgList.innerHTML = '<div class="loading">טוען הודעות...</div>';

    try {
      const res = await fetch(apiUrl('/wa-inbox/api/messages?phone=' + encodeURIComponent(phone)));
      if (!res.ok) { msgList.innerHTML = '<div class="loading">שגיאה בטעינה</div>'; return; }
      const msgs = await res.json();

      if (!msgs.length) {
        msgList.innerHTML = \`
          <div class="empty">
            <div class="empty-icon">💬</div>
            <div>אין הודעות עדיין</div>
          </div>
        \`;
        return;
      }

      msgList.innerHTML = '';
      for (const m of msgs) {
        const bubble = document.createElement('div');
        // RTL: incoming (from lead) appears on right; outgoing (from bot/operator) on left
        bubble.className = 'bubble bubble-' + m.direction;
        bubble.innerHTML = \`
          <div>\${escHtml(m.content)}</div>
          <div class="bubble-time">\${formatTime(m.created_at)}</div>
        \`;
        msgList.appendChild(bubble);
      }

      // Scroll to bottom
      msgList.scrollTop = msgList.scrollHeight;
    } catch (e) {
      msgList.innerHTML = '<div class="loading">שגיאת חיבור</div>';
    }
  }

  // ── Send reply ─────────────────────────────────────────────────────────────

  async function handleSend() {
    if (!activePhone || !activeTenantId) return;
    const input = document.getElementById('reply-input');
    const btn = document.getElementById('send-btn');
    const message = input.value.trim();
    if (!message) return;

    btn.disabled = true;
    input.disabled = true;

    try {
      const res = await fetch(apiUrl('/wa-inbox/api/reply'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: activePhone, message, tenant_id: activeTenantId }),
      });
      const body = await res.json();
      if (body.success) {
        input.value = '';
        // Reload messages to show the sent message
        const activeItem = document.querySelector('.conv-item.active');
        await loadConversation(activePhone, document.getElementById('msg-header').textContent, activeItem);
      } else {
        alert('שגיאה בשליחה: ' + (body.error || 'שגיאה לא ידועה'));
      }
    } catch (e) {
      alert('שגיאת חיבור');
    } finally {
      btn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  }

  // Enter key in reply input
  document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('reply-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });
  });

  // ── Security helper ────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  loadTenants();
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});
