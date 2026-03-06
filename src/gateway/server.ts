import express from 'express';
import { config } from '../utils/config.js';
import { executeTool } from '../agent/tools.js';
import { db } from '../utils/db.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', mode: config.mode, uptime: process.uptime(), localConnected: !!config.localApiUrl, version: 'v23-commands-fix' });
});

// Cloud mode: allow local Mac to register its tunnel URL
if (config.mode === 'cloud') {
  app.post('/api/register-local', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${config.localApiSecret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'Missing url' });
      return;
    }
    // Update config in memory (no restart needed)
    (config as any).localApiUrl = url;
    console.log(`[Server] Local Mac registered: ${url}`);
    res.json({ ok: true, registered: url });
  });
}

// Local mode: expose tools as API for cloud proxy
if (config.mode === 'local') {
  app.post('/api/tool', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${config.localApiSecret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { name, input } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Missing tool name' });
      return;
    }

    try {
      const result = await executeTool(name, input || {});
      // Check for pending media (screenshot, etc.)
      const { collectMedia } = await import('../agent/tools.js');
      const media = collectMedia();
      res.json({ result, media: media.map(m => ({ type: m.type, data: m.data.toString('base64') })) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}

// === Dashboard API (protected by secret) ===
function dashAuth(req: any, res: any, next: any) {
  const token = req.query.token || req.headers['x-dashboard-token'];
  if (token !== config.localApiSecret) {
    res.status(401).json({ error: 'Unauthorized — add ?token=YOUR_SECRET' });
    return;
  }
  next();
}

app.get('/api/dashboard/stats', dashAuth, (_req, res) => {
  const memories = db.prepare('SELECT COUNT(*) as count FROM memories').get() as any;
  const tasks = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'").get() as any;
  const messages = db.prepare('SELECT COUNT(*) as count FROM messages').get() as any;
  const docs = db.prepare('SELECT COUNT(*) as count FROM knowledge_docs').get() as any;
  const workflows = db.prepare('SELECT COUNT(*) as count FROM workflows WHERE enabled = 1').get() as any;
  const todayCost = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) as cost FROM api_usage WHERE date(created_at) = date('now')").get() as any;
  const weekCost = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) as cost FROM api_usage WHERE created_at >= datetime('now', '-7 days')").get() as any;
  const monthCost = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) as cost FROM api_usage WHERE created_at >= datetime('now', '-30 days')").get() as any;

  res.json({
    memories: memories.count,
    pendingTasks: tasks.count,
    totalMessages: messages.count,
    knowledgeDocs: docs.count,
    activeWorkflows: workflows.count,
    costs: {
      today: Math.round(todayCost.cost * 10000) / 10000,
      week: Math.round(weekCost.cost * 10000) / 10000,
      month: Math.round(monthCost.cost * 10000) / 10000,
    },
    uptime: Math.floor(process.uptime()),
    mode: config.mode,
    localConnected: !!config.localApiUrl,
  });
});

app.get('/api/dashboard/memories', dashAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const rows = db.prepare('SELECT * FROM memories ORDER BY importance DESC, created_at DESC LIMIT ?').all(limit);
  res.json(rows);
});

app.get('/api/dashboard/tasks', dashAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM tasks ORDER BY CASE status WHEN \'pending\' THEN 0 WHEN \'done\' THEN 1 ELSE 2 END, priority DESC, created_at DESC LIMIT 100').all();
  res.json(rows);
});

app.get('/api/dashboard/messages', dashAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
  const rows = db.prepare('SELECT id, channel, sender_name, role, substr(content, 1, 200) as content, created_at FROM messages ORDER BY id DESC LIMIT ?').all(limit);
  res.json(rows);
});

app.get('/api/dashboard/costs', dashAuth, (_req, res) => {
  const daily = db.prepare(`
    SELECT date(created_at) as day, model, COUNT(*) as calls,
           SUM(input_tokens) as input_t, SUM(output_tokens) as output_t,
           ROUND(SUM(cost_usd), 4) as cost
    FROM api_usage
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY day, model ORDER BY day DESC
  `).all();
  res.json(daily);
});

app.get('/api/dashboard/knowledge', dashAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM knowledge_docs ORDER BY created_at DESC').all();
  res.json(rows);
});

app.get('/api/dashboard/workflows', dashAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM workflows ORDER BY created_at DESC').all();
  res.json(rows.map((r: any) => ({ ...r, actions: JSON.parse(r.actions) })));
});

app.get('/api/dashboard/tools', dashAuth, (_req, res) => {
  const rows = db.prepare(`
    SELECT tool_name, COUNT(*) as calls,
           SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
           SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
           ROUND(AVG(duration_ms)) as avg_ms,
           MAX(created_at) as last_used
    FROM tool_usage
    GROUP BY tool_name ORDER BY calls DESC
  `).all();
  res.json(rows);
});

// Web Chat — message history
app.get('/api/chat/history', dashAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const rows = db.prepare(
    `SELECT role, content, created_at FROM messages
     WHERE channel = 'telegram' AND sender_id = ?
     ORDER BY id DESC LIMIT ?`
  ).all(config.allowedTelegram[0] || '', limit) as any[];
  res.json(rows.reverse());
});

// Web Chat API — send message and get response
app.post('/api/chat', dashAuth, async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'Missing text' });
    return;
  }

  try {
    const { handleMessage } = await import('../agent/agent.js');
    const msg = {
      id: `web-${Date.now()}`,
      channel: 'telegram' as const,
      senderId: config.allowedTelegram[0] || 'web',
      senderName: 'Alon (Web)',
      text: text.slice(0, 4000),
      timestamp: Date.now(),
      raw: null,
    };
    const reply = await handleMessage(msg);
    res.json({ text: reply.text });
  } catch (e: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Dashboard HTML
app.get('/dashboard', dashAuth, (_req, res) => {
  const token = _req.query.token;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getDashboardHTML(token as string));
});

// Web Chat HTML
app.get('/chat', dashAuth, (_req, res) => {
  const token = _req.query.token;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getChatHTML(token as string));
});

export function startServer() {
  app.listen(config.port, () => {
    console.log(`[Server] Health check: http://localhost:${config.port}/health`);
    console.log(`[Server] Chat: http://localhost:${config.port}/chat?token=${config.localApiSecret}`);
    console.log(`[Server] Dashboard: http://localhost:${config.port}/dashboard?token=${config.localApiSecret}`);
    if (config.mode === 'local') {
      console.log(`[Server] Tool API: http://localhost:${config.port}/api/tool`);
    }
  });
}

function escapeJsString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, '\\x3c').replace(/>/g, '\\x3e');
}

function getDashboardHTML(token: string): string {
  const safeToken = escapeJsString(token);
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AlonBot Dashboard</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;700;900&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Heebo',sans-serif; background:#0f0c29; color:#e0e0ff; min-height:100vh; }
  .header { background:linear-gradient(135deg,#302b63,#24243e); padding:20px 30px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid #444; }
  .header h1 { font-size:24px; font-weight:900; background:linear-gradient(90deg,#00d2ff,#7b2ff7); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
  .header .status { display:flex; gap:12px; align-items:center; font-size:13px; }
  .badge { padding:4px 12px; border-radius:20px; font-size:11px; font-weight:700; }
  .badge-ok { background:#0a3; color:#fff; }
  .badge-warn { background:#fa0; color:#000; }
  .container { max-width:1200px; margin:0 auto; padding:20px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:16px; margin-bottom:24px; }
  .stat-card { background:#1a1a3e; border:1px solid #333; border-radius:12px; padding:20px; text-align:center; }
  .stat-card .num { font-size:36px; font-weight:900; color:#7b2ff7; }
  .stat-card .label { font-size:13px; color:#888; margin-top:4px; }
  .stat-card .sub { font-size:11px; color:#666; margin-top:2px; }
  .section { background:#1a1a3e; border:1px solid #333; border-radius:12px; padding:20px; margin-bottom:20px; }
  .section h2 { font-size:18px; font-weight:700; margin-bottom:15px; color:#00d2ff; }
  .tabs { display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap; }
  .tab { padding:6px 16px; border-radius:20px; background:#252550; border:1px solid #444; cursor:pointer; font-size:13px; color:#aaa; transition:all .2s; }
  .tab.active { background:#7b2ff7; color:#fff; border-color:#7b2ff7; }
  .tab:hover { border-color:#7b2ff7; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:right; padding:8px 10px; border-bottom:2px solid #333; color:#888; font-weight:500; }
  td { padding:8px 10px; border-bottom:1px solid #222; }
  tr:hover td { background:#252550; }
  .imp { display:inline-block; width:20px; height:20px; border-radius:50%; text-align:center; line-height:20px; font-size:11px; font-weight:700; }
  .imp-high { background:#7b2ff7; color:#fff; }
  .imp-med { background:#444; color:#ccc; }
  .imp-low { background:#222; color:#666; }
  .type-badge { padding:2px 8px; border-radius:10px; font-size:11px; }
  .type-fact { background:#1a3a1a; color:#4a4; }
  .type-preference { background:#3a3a1a; color:#aa4; }
  .type-event { background:#1a1a3a; color:#44a; }
  .type-pattern { background:#3a1a3a; color:#a4a; }
  .type-relationship { background:#3a1a1a; color:#a44; }
  .msg-user { color:#00d2ff; }
  .msg-assistant { color:#7b2ff7; }
  .cost-bar { height:6px; background:#222; border-radius:3px; overflow:hidden; margin-top:4px; }
  .cost-fill { height:100%; background:linear-gradient(90deg,#0a3,#fa0,#f00); border-radius:3px; }
  .refresh-btn { background:#7b2ff7; color:#fff; border:none; padding:8px 20px; border-radius:20px; cursor:pointer; font-family:inherit; font-size:13px; }
  .refresh-btn:hover { background:#9b4fff; }
  .empty { text-align:center; color:#555; padding:30px; }
  @media(max-width:600px) { .grid { grid-template-columns:repeat(2,1fr); } .container { padding:10px; } }
</style>
</head>
<body>
<div class="header">
  <h1>AlonBot Dashboard</h1>
  <div class="status">
    <span id="mode-badge" class="badge badge-ok">...</span>
    <button class="refresh-btn" onclick="loadAll()">Refresh</button>
  </div>
</div>
<div class="container">
  <div class="grid" id="stats-grid"></div>

  <div class="tabs" id="main-tabs">
    <div class="tab active" data-tab="memories">Memories</div>
    <div class="tab" data-tab="tasks">Tasks</div>
    <div class="tab" data-tab="messages">Messages</div>
    <div class="tab" data-tab="costs">Costs</div>
    <div class="tab" data-tab="knowledge">Knowledge</div>
    <div class="tab" data-tab="tools">Tools</div>
    <div class="tab" data-tab="workflows">Workflows</div>
  </div>

  <div class="section" id="tab-content"></div>
</div>

<script>
const TOKEN = '${safeToken}';
const API = (path) => '/api/dashboard/' + path + '?token=' + TOKEN;
let currentTab = 'memories';

async function fetchJSON(path) {
  const r = await fetch(API(path));
  return r.json();
}

async function loadAll() {
  const stats = await fetchJSON('stats');
  document.getElementById('mode-badge').textContent =
    (stats.mode === 'cloud' ? 'Cloud' : 'Local') + (stats.localConnected ? ' + Mac' : '');
  document.getElementById('mode-badge').className = 'badge ' + (stats.localConnected ? 'badge-ok' : 'badge-warn');

  const upH = Math.floor(stats.uptime / 3600);
  const upM = Math.floor((stats.uptime % 3600) / 60);

  document.getElementById('stats-grid').innerHTML = [
    card(stats.memories, 'Memories', ''),
    card(stats.pendingTasks, 'Tasks', 'pending'),
    card(stats.totalMessages, 'Messages', 'total'),
    card(stats.knowledgeDocs, 'Knowledge', 'docs'),
    card(stats.activeWorkflows, 'Workflows', 'active'),
    card('$' + stats.costs.today, 'Today', 'API cost'),
    card('$' + stats.costs.week, 'Week', 'API cost'),
    card(upH + 'h ' + upM + 'm', 'Uptime', ''),
  ].join('');

  loadTab(currentTab);
}

function card(num, label, sub) {
  return '<div class="stat-card"><div class="num">' + num + '</div><div class="label">' + label + '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
}

function impClass(n) { return n >= 8 ? 'imp-high' : n >= 5 ? 'imp-med' : 'imp-low'; }
function typeBadge(t) { return '<span class="type-badge type-' + t + '">' + t + '</span>'; }

async function loadTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const el = document.getElementById('tab-content');

  if (tab === 'memories') {
    const data = await fetchJSON('memories');
    if (!data.length) { el.innerHTML = '<h2>Memories</h2><div class="empty">No memories yet</div>'; return; }
    el.innerHTML = '<h2>Memories (' + data.length + ')</h2><table><tr><th>#</th><th>Type</th><th>Category</th><th>Content</th><th>Imp</th><th>Access</th></tr>' +
      data.map(m => '<tr><td>' + m.id + '</td><td>' + typeBadge(m.type) + '</td><td>' + (m.category||'-') + '</td><td>' + esc(m.content).slice(0,100) + '</td><td><span class="imp ' + impClass(m.importance) + '">' + m.importance + '</span></td><td>' + m.access_count + '</td></tr>').join('') + '</table>';
  }
  else if (tab === 'tasks') {
    const data = await fetchJSON('tasks');
    if (!data.length) { el.innerHTML = '<h2>Tasks</h2><div class="empty">No tasks</div>'; return; }
    el.innerHTML = '<h2>Tasks (' + data.length + ')</h2><table><tr><th>#</th><th>Title</th><th>Priority</th><th>Due</th><th>Status</th></tr>' +
      data.map(t => '<tr><td>' + t.id + '</td><td>' + esc(t.title) + '</td><td><span class="imp ' + impClass(t.priority) + '">' + t.priority + '</span></td><td>' + (t.due_date||'-') + '</td><td>' + t.status + '</td></tr>').join('') + '</table>';
  }
  else if (tab === 'messages') {
    const data = await fetchJSON('messages');
    if (!data.length) { el.innerHTML = '<h2>Messages</h2><div class="empty">No messages</div>'; return; }
    el.innerHTML = '<h2>Messages (latest)</h2><table><tr><th>Time</th><th>Who</th><th>Content</th></tr>' +
      data.map(m => '<tr><td style="white-space:nowrap;font-size:11px">' + m.created_at + '</td><td class="msg-' + m.role + '">' + (m.role==='user' ? esc(m.sender_name) : 'Bot') + '</td><td>' + esc(m.content) + '</td></tr>').join('') + '</table>';
  }
  else if (tab === 'costs') {
    const data = await fetchJSON('costs');
    if (!data.length) { el.innerHTML = '<h2>API Costs</h2><div class="empty">No usage data</div>'; return; }
    const maxCost = Math.max(...data.map(d => d.cost), 0.01);
    el.innerHTML = '<h2>API Costs (30 days)</h2><table><tr><th>Date</th><th>Model</th><th>Calls</th><th>Input</th><th>Output</th><th>Cost</th><th></th></tr>' +
      data.map(d => '<tr><td>' + d.day + '</td><td>' + d.model + '</td><td>' + d.calls + '</td><td>' + (d.input_t||0).toLocaleString() + '</td><td>' + (d.output_t||0).toLocaleString() + '</td><td>$' + d.cost + '</td><td><div class="cost-bar" style="width:80px"><div class="cost-fill" style="width:' + Math.round(d.cost/maxCost*100) + '%"></div></div></td></tr>').join('') + '</table>';
  }
  else if (tab === 'knowledge') {
    const data = await fetchJSON('knowledge');
    if (!data.length) { el.innerHTML = '<h2>Knowledge Base</h2><div class="empty">No documents ingested</div>'; return; }
    el.innerHTML = '<h2>Knowledge Base (' + data.length + ' docs)</h2><table><tr><th>#</th><th>Title</th><th>Type</th><th>Chunks</th><th>Added</th></tr>' +
      data.map(d => '<tr><td>' + d.id + '</td><td>' + esc(d.title) + '</td><td>' + d.source_type + '</td><td>' + d.chunk_count + '</td><td>' + d.created_at + '</td></tr>').join('') + '</table>';
  }
  else if (tab === 'tools') {
    const data = await fetchJSON('tools');
    if (!data.length) { el.innerHTML = '<h2>Tool Usage</h2><div class="empty">No tool usage yet</div>'; return; }
    const totalCalls = data.reduce((s,t) => s + t.calls, 0);
    el.innerHTML = '<h2>Tool Usage (' + totalCalls + ' total calls)</h2><table><tr><th>Tool</th><th>Calls</th><th>Success</th><th>Fail</th><th>Avg ms</th><th>Last Used</th></tr>' +
      data.map(t => '<tr><td><b>' + t.tool_name + '</b></td><td>' + t.calls + '</td><td style="color:#0a3">' + t.successes + '</td><td style="color:#f44">' + t.failures + '</td><td>' + (t.avg_ms||0) + 'ms</td><td style="font-size:11px">' + (t.last_used||'-') + '</td></tr>').join('') + '</table>';
  }
  else if (tab === 'workflows') {
    const data = await fetchJSON('workflows');
    if (!data.length) { el.innerHTML = '<h2>Workflows</h2><div class="empty">No workflows configured</div>'; return; }
    el.innerHTML = '<h2>Workflows (' + data.length + ')</h2><table><tr><th>#</th><th>Name</th><th>Trigger</th><th>Actions</th><th>Status</th></tr>' +
      data.map(w => '<tr><td>' + w.id + '</td><td>' + esc(w.name) + '</td><td>' + w.trigger_type + ': ' + esc(w.trigger_value) + '</td><td>' + w.actions.map(a=>a.type).join(', ') + '</td><td>' + (w.enabled ? 'ON' : 'OFF') + '</td></tr>').join('') + '</table>';
  }
}

function esc(s) { if(!s) return ''; const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

document.getElementById('main-tabs').addEventListener('click', e => {
  if (e.target.dataset.tab) loadTab(e.target.dataset.tab);
});

loadAll();
setInterval(loadAll, 30000); // refresh every 30s
</script>
</body>
</html>`;
}

function getChatHTML(token: string): string {
  const safeToken = escapeJsString(token);
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AlonBot Chat</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;700&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Heebo',sans-serif; background:#0f0c29; color:#e0e0ff; height:100vh; display:flex; flex-direction:column; }
  .header { background:linear-gradient(135deg,#302b63,#24243e); padding:14px 20px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid #444; flex-shrink:0; }
  .header h1 { font-size:20px; font-weight:700; background:linear-gradient(90deg,#00d2ff,#7b2ff7); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
  .header a { color:#888; text-decoration:none; font-size:13px; }
  .header a:hover { color:#00d2ff; }
  .messages { flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:12px; }
  .msg { max-width:80%; padding:12px 16px; border-radius:16px; line-height:1.6; font-size:14px; white-space:pre-wrap; word-wrap:break-word; }
  .msg-user { align-self:flex-start; background:#7b2ff7; color:#fff; border-bottom-right-radius:4px; }
  .msg-bot { align-self:flex-end; background:#1a1a3e; border:1px solid #333; border-bottom-left-radius:4px; }
  .msg-bot .footer { font-size:11px; color:#666; margin-top:8px; border-top:1px solid #333; padding-top:6px; }
  .typing { align-self:flex-end; color:#666; font-size:13px; padding:8px 16px; display:none; }
  .typing.show { display:block; }
  .input-area { display:flex; gap:8px; padding:12px 20px; background:#1a1a3e; border-top:1px solid #333; flex-shrink:0; }
  .input-area textarea { flex:1; background:#252550; border:1px solid #444; border-radius:12px; padding:12px 16px; color:#e0e0ff; font-family:inherit; font-size:14px; resize:none; outline:none; min-height:44px; max-height:120px; }
  .input-area textarea:focus { border-color:#7b2ff7; }
  .input-area button { background:#7b2ff7; color:#fff; border:none; border-radius:12px; padding:0 20px; cursor:pointer; font-family:inherit; font-size:14px; font-weight:500; white-space:nowrap; }
  .input-area button:hover { background:#9b4fff; }
  .input-area button:disabled { opacity:0.5; cursor:not-allowed; }
  @media(max-width:600px) { .msg { max-width:90%; } .input-area { padding:8px 12px; } }
</style>
</head>
<body>
<div class="header">
  <h1>AlonBot Chat</h1>
  <a href="/dashboard?token=${safeToken}">Dashboard</a>
</div>
<div class="messages" id="messages"></div>
<div class="typing" id="typing">AlonBot חושב...</div>
<div class="input-area">
  <textarea id="input" placeholder="כתוב הודעה..." rows="1"></textarea>
  <button id="send" onclick="send()">שלח</button>
</div>
<script>
const TOKEN = '${safeToken}';
const msgEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const typingEl = document.getElementById('typing');
const sendBtn = document.getElementById('send');

function addMsg(text, role) {
  const div = document.createElement('div');
  div.className = 'msg msg-' + role;
  if (role === 'bot') {
    // Split footer from text
    const parts = text.split(/\\n\\n_\\u200E/);
    let main = parts[0];
    let footer = parts.length > 1 ? parts[1].replace(/_$/, '') : '';
    div.innerHTML = esc(main) + (footer ? '<div class="footer">' + esc(footer) + '</div>' : '');
  } else {
    div.textContent = text;
  }
  msgEl.appendChild(div);
  msgEl.scrollTop = msgEl.scrollHeight;
}

function esc(s) { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; }

async function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  addMsg(text, 'user');
  sendBtn.disabled = true;
  typingEl.classList.add('show');

  try {
    const res = await fetch('/api/chat?token=' + TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    addMsg(data.text || data.error || 'Error', 'bot');
  } catch (e) {
    addMsg('Connection error: ' + e.message, 'bot');
  }

  sendBtn.disabled = false;
  typingEl.classList.remove('show');
}

inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});

// Load chat history on page open
(async () => {
  try {
    const res = await fetch('/api/chat/history?token=' + TOKEN + '&limit=30');
    const history = await res.json();
    for (const msg of history) {
      const role = msg.role === 'user' ? 'user' : 'bot';
      addMsg(msg.content, role);
    }
  } catch (e) { console.error('Failed to load history:', e); }
})();
</script>
</body>
</html>`;
}
