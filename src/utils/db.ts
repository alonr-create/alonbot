import Database, { type Database as DatabaseType } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'fs';

const log = createLogger('db');

mkdirSync(config.dataDir, { recursive: true });
log.info({ dataDir: config.dataDir, dbPath: `${config.dataDir}/alonbot.db` }, 'database location');

const db: DatabaseType = new Database(`${config.dataDir}/alonbot.db`);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Load sqlite-vec extension for vector search
sqliteVec.load(db);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cron_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cron_expr TEXT NOT NULL,
    channel TEXT NOT NULL,
    target_id TEXT NOT NULL,
    message TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'fact',
    category TEXT,
    content TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 5,
    source TEXT DEFAULT 'user_told',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_accessed TEXT,
    access_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS conversation_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    topics TEXT,
    message_count INTEGER,
    from_date TEXT,
    to_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'done', 'cancelled')),
    priority INTEGER NOT NULL DEFAULT 5,
    due_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS scheduled_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT,
    message TEXT NOT NULL,
    send_at TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'telegram',
    target_id TEXT NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_scheduled_pending ON scheduled_messages(sent, send_at);

  CREATE TABLE IF NOT EXISTS tool_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 1,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tool_usage_date ON tool_usage(created_at);
  CREATE INDEX IF NOT EXISTS idx_tool_usage_name ON tool_usage(tool_name);
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, sender_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type, category);
  CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
  CREATE INDEX IF NOT EXISTS idx_summaries_channel ON conversation_summaries(channel, sender_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_api_usage_date ON api_usage(created_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority DESC);

  CREATE TABLE IF NOT EXISTS knowledge_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('url', 'pdf', 'text', 'file')),
    source_ref TEXT,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(doc_id, chunk_index);

  CREATE TABLE IF NOT EXISTS batch_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL UNIQUE,
    job_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
    result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs(status);

  CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    trigger_type TEXT NOT NULL CHECK(trigger_type IN ('keyword', 'cron', 'event')),
    trigger_value TEXT NOT NULL,
    actions TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    name TEXT,
    source TEXT NOT NULL DEFAULT 'voice_agent',
    monday_item_id TEXT,
    last_call_summary TEXT,
    last_call_sentiment TEXT,
    last_call_duration_sec INTEGER,
    was_booked INTEGER NOT NULL DEFAULT 0,
    call_mode TEXT,
    lead_status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
  CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);

  -- Lead scoring + referral columns (added safely)
  -- lead_score: 0=unknown, 1=cold, 2=warm, 3=hot, 4=fire

  CREATE TABLE IF NOT EXISTS lead_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(phone, tag)
  );

  CREATE INDEX IF NOT EXISTS idx_lead_tags_phone ON lead_tags(phone);
  CREATE INDEX IF NOT EXISTS idx_lead_tags_tag ON lead_tags(tag);

  CREATE TABLE IF NOT EXISTS lead_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    content TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_lead_notes_phone ON lead_notes(phone);

  CREATE TABLE IF NOT EXISTS quick_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    workspace_id TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_status_history_phone ON status_history(phone);

  CREATE TABLE IF NOT EXISTS followup_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    day_offset INTEGER NOT NULL DEFAULT 3,
    message TEXT NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'text' CHECK(message_type IN ('text', 'voice', 'image')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS followup_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    lead_name TEXT,
    meeting_time TEXT NOT NULL,
    duration_min INTEGER NOT NULL DEFAULT 15,
    meeting_link TEXT,
    calendar_event_id TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'completed', 'no_show', 'cancelled', 'rescheduled')),
    no_show_handled INTEGER NOT NULL DEFAULT 0,
    reschedule_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_meetings_phone ON meetings(phone);
  CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status, meeting_time);

  CREATE TABLE IF NOT EXISTS chatbot_flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    trigger_type TEXT NOT NULL CHECK(trigger_type IN ('keyword', 'new_lead', 'status_change')),
    trigger_value TEXT,
    steps TEXT NOT NULL DEFAULT '[]',
    workspace_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS flow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flow_id INTEGER NOT NULL REFERENCES chatbot_flows(id) ON DELETE CASCADE,
    phone TEXT NOT NULL,
    current_step INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'paused')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_flow_runs_phone ON flow_runs(phone, status);

  CREATE TABLE IF NOT EXISTS page_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    site TEXT NOT NULL,
    page TEXT NOT NULL DEFAULT '/',
    referrer TEXT,
    duration_sec INTEGER NOT NULL DEFAULT 0,
    scroll_pct INTEGER NOT NULL DEFAULT 0,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_page_visits_site ON page_visits(site, created_at);
  CREATE INDEX IF NOT EXISTS idx_page_visits_phone ON page_visits(phone);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commitments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    content TEXT NOT NULL,
    due_hint TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'done', 'expired')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_commitments_sender ON commitments(channel, sender_id, status);

  CREATE TABLE IF NOT EXISTS relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_name TEXT NOT NULL,
    role TEXT NOT NULL,
    context TEXT,
    confidence REAL NOT NULL DEFAULT 0.8,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(person_name, role)
  );

  CREATE INDEX IF NOT EXISTS idx_relationships_person ON relationships(person_name);

  CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.8,
    source TEXT DEFAULT 'extracted',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(subject, predicate, object)
  );

  CREATE INDEX IF NOT EXISTS idx_entities_subject ON entities(subject);
  CREATE INDEX IF NOT EXISTS idx_entities_predicate ON entities(predicate);

  CREATE TABLE IF NOT EXISTS sentiment_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sentiment TEXT NOT NULL CHECK(sentiment IN ('positive', 'neutral', 'negative', 'frustrated')),
    score REAL NOT NULL DEFAULT 0,
    trigger_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sentiment_log_sender ON sentiment_log(channel, sender_id, created_at);

  CREATE TABLE IF NOT EXISTS conversation_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    first_mentioned TEXT NOT NULL DEFAULT (datetime('now')),
    last_mentioned TEXT NOT NULL DEFAULT (datetime('now')),
    mention_count INTEGER NOT NULL DEFAULT 1
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_topics_unique ON conversation_topics(channel, sender_id, topic);
  CREATE INDEX IF NOT EXISTS idx_conv_topics_sender ON conversation_topics(channel, sender_id, last_mentioned DESC);

  CREATE TABLE IF NOT EXISTS rate_limits (
    user_id TEXT,
    timestamp TEXT,
    PRIMARY KEY(user_id, timestamp)
  );

  CREATE TABLE IF NOT EXISTS delivery_receipts (
    wamid TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'sent',
    sent_at TEXT,
    delivered_at TEXT,
    read_at TEXT,
    failed_at TEXT,
    error_code TEXT,
    error_title TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_delivery_phone ON delivery_receipts(phone);
  CREATE INDEX IF NOT EXISTS idx_delivery_status ON delivery_receipts(status);

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '📱',
    color TEXT NOT NULL DEFAULT '#25D366',
    welcome_msg TEXT,
    system_prompt TEXT,
    monday_board_id TEXT,
    monday_columns TEXT,
    calendar_id TEXT,
    zoom_link TEXT,
    website TEXT,
    default_lead_status TEXT DEFAULT 'new',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Vector table for semantic memory search (768-dim Gemini embedding)
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
    embedding float[768]
  );
`);

// Vector table for knowledge chunk search (768-dim Gemini embedding)
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vectors USING vec0(
    embedding float[768]
  );
`);

// Migration: move old facts table data into memories if facts table exists
try {
  const factsExist = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='facts'"
  ).get();
  if (factsExist) {
    const oldFacts = db.prepare('SELECT key, value, updated_at FROM facts').all() as Array<{ key: string; value: string; updated_at: string }>;
    if (oldFacts.length > 0) {
      const insertMemory = db.prepare(
        `INSERT INTO memories (type, category, content, importance, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      );
      const migrate = db.transaction(() => {
        for (const fact of oldFacts) {
          insertMemory.run('fact', 'personal', `${fact.key}: ${fact.value}`, 5, 'migrated', fact.updated_at);
        }
      });
      migrate();
      log.info({ count: oldFacts.length }, 'migrated facts to memories');
    }
    db.exec('DROP TABLE facts');
    log.info('dropped old facts table');
  }
} catch {
  // facts table doesn't exist or already migrated — ok
}

// Migration: add profile_pic_url to leads
try {
  db.exec(`ALTER TABLE leads ADD COLUMN profile_pic_url TEXT`);
} catch { /* column already exists */ }

// Migration: add bot_paused flag to leads (manual mode)
try {
  db.exec(`ALTER TABLE leads ADD COLUMN bot_paused INTEGER NOT NULL DEFAULT 0`);
} catch { /* column already exists */ }

// Migration: add follow-up columns to leads
try {
  db.exec(`ALTER TABLE leads ADD COLUMN next_followup TEXT`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE leads ADD COLUMN followup_count INTEGER NOT NULL DEFAULT 0`);
} catch { /* column already exists */ }
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_next_followup ON leads(next_followup)`);
} catch { /* index already exists */ }

// Seed default follow-up templates if empty
try {
  const ftCount = db.prepare('SELECT COUNT(*) as c FROM followup_templates').get() as any;
  if (ftCount.c === 0) {
    const ins = db.prepare('INSERT INTO followup_templates (name, day_offset, message, message_type, sort_order) VALUES (?, ?, ?, ?, ?)');
    ins.run('פולואפ ראשון', 3, 'היי {name}, שלחתי לך דוגמה לאתר שבניתי בדיוק בשבילך 🎨\nרגע לבדוק? אשמח לשמוע מה אתה חושב!', 'text', 1);
    ins.run('פולואפ שני — הודעה קולית', 5, 'היי {name}, זו יעל מ-Alon.dev. שלחנו לך הצעה מיוחדת — אתר מקצועי ב-48 שעות. אשמח אם תיתן הזדמנות ותבדוק את הדוגמה ששלחנו. תכתוב לי אם יש שאלות!', 'voice', 2);
    ins.run('פולואפ אחרון', 8, 'היי {name}, רק רציתי לוודא שראית את ההודעה שלי 🙂\nהמבצע תקף עוד יומיים — אתר מקצועי ב-₪1,800 במקום ₪3,500.\nמעוניין?', 'text', 3);
    log.info('seeded 3 default follow-up templates');
  }
} catch { /* followup_templates might not exist yet on first run */ }

// Seed default follow-up config
try {
  const cfgCount = db.prepare('SELECT COUNT(*) as c FROM followup_config').get() as any;
  if (cfgCount.c === 0) {
    const cfgIns = db.prepare('INSERT INTO followup_config (key, value) VALUES (?, ?)');
    cfgIns.run('auto_enabled', 'true');
    cfgIns.run('send_hour', '10');
    cfgIns.run('max_followups', '3');
    cfgIns.run('skip_statuses', 'closed,refused,not_relevant,done,interested,vip');
    cfgIns.run('skip_replied', 'true');
    log.info('seeded default follow-up config');
  }
} catch { /* config might not exist yet */ }

// Seed workspaces if empty
try {
  const wsCount = db.prepare('SELECT COUNT(*) as c FROM workspaces').get() as any;
  if (wsCount.c === 0) {
    const seedWs = db.prepare('INSERT OR IGNORE INTO workspaces (id, name, icon, color, welcome_msg, monday_board_id, monday_columns, zoom_link, website, system_prompt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    seedWs.run('alon_dev', 'Alon.dev', '💻', '#7b2ff7',
      'היי! ברוך הבא 👋 אני נציג של Alon.dev — שירותי טכנולוגיה ודיגיטל לעסקים. ספר לי קצת — מה העסק שלך? אשמח להבין מה אתה עושה ואיך אנחנו יכולים לעזור.',
      '5092777389',
      JSON.stringify({ phone: 'phone_mm16hqz2', email: 'email_mm161rpz', source: 'text_mm16pfzp', message: 'long_text_mm16k6vr', service: 'dropdown_mm16speh' }),
      'https://us04web.zoom.us/j/2164012025', 'https://alon.dev', null);
    seedWs.run('dekel', 'דקל לפרישה — יעל', '🏦', '#128C7E',
      null, '1443363020', null,
      'https://zoom.us/j/96752752908', 'https://dprisha.co.il', null);
    log.info('seeded 2 default workspaces');
  }
} catch { /* workspaces already seeded */ }

// Migration: add workspace_id to followup_templates for business segmentation
try {
  db.exec(`ALTER TABLE followup_templates ADD COLUMN workspace_id TEXT`);
  // Tag existing templates as alon_dev (they have Alon.dev-specific content)
  db.prepare("UPDATE followup_templates SET workspace_id = 'alon_dev' WHERE workspace_id IS NULL").run();
  log.info('migrated followup_templates: added workspace_id');
} catch { /* column already exists */ }

// Seed dekel-specific follow-up templates if missing
try {
  const dekelTemplates = db.prepare("SELECT COUNT(*) as c FROM followup_templates WHERE workspace_id = 'dekel'").get() as any;
  if (dekelTemplates.c === 0) {
    const ins = db.prepare('INSERT INTO followup_templates (name, day_offset, message, message_type, sort_order, workspace_id) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run('פולואפ ראשון — דקל', 3, 'היי {name}, כאן יעל מדקל לפרישה 🏦\nרציתי לוודא שקיבלת את המידע שלנו. יש לנו ליווי מקצועי לתכנון פרישה — אשמח לעזור!', 'text', 1, 'dekel');
    ins.run('פולואפ שני — דקל', 5, 'היי {name}, זו יעל מדקל לפרישה. לא רציתי שתפספס — יש לנו שיחת ייעוץ ראשונית בחינם לתכנון הפנסיה שלך. מעוניין/ת?', 'text', 2, 'dekel');
    ins.run('פולואפ אחרון — דקל', 8, 'היי {name}, רק רציתי לוודא שראית 🙂\nאם יש שאלות על פרישה, פנסיה או ביטוח — אנחנו כאן. אפשר לקבוע שיחה קצרה?', 'text', 3, 'dekel');
    log.info('seeded 3 dekel follow-up templates');
  }
} catch { /* ok */ }

// Normalize legacy source values
try {
  db.prepare("UPDATE leads SET source = 'alon_dev' WHERE source = 'alon_dev_whatsapp'").run();
} catch { /* ok */ }

// Migration: lead scoring + referral
try { db.exec(`ALTER TABLE leads ADD COLUMN lead_score INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE leads ADD COLUMN referral_code TEXT`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE leads ADD COLUMN referred_by TEXT`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE orders ADD COLUMN review_requested INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE orders ADD COLUMN referral_code TEXT DEFAULT ''`); } catch { /* exists */ }

// Migration: A/B/C price tier testing
try { db.exec(`ALTER TABLE leads ADD COLUMN price_tier TEXT DEFAULT ''`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE orders ADD COLUMN price_tier TEXT DEFAULT ''`); } catch { /* exists */ }

// Migration: meetings — track when Telegram question was asked (for auto-timeout)
try { db.exec(`ALTER TABLE meetings ADD COLUMN asked_at TEXT`); } catch { /* exists */ }

// One-time fix: reset stuck meetings (asked via Telegram but never answered, no asked_at)
// These will be re-detected by checkNoShows and get asked_at set properly
const stuckMeetings = db.prepare(`
  UPDATE meetings SET no_show_handled = 0
  WHERE status = 'scheduled' AND no_show_handled = 1 AND asked_at IS NULL
`).run();
if (stuckMeetings.changes > 0) {
  console.log(`[db] reset ${stuckMeetings.changes} stuck meeting(s) — will re-ask via Telegram`);
}

// Daily backup for leads table (exports to JSON)
function backupLeads(): string | null {
  try {
    const leads = db.prepare('SELECT * FROM leads').all();
    const backupDir = `${config.dataDir}/backups`;
    mkdirSync(backupDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const path = `${backupDir}/leads-${date}.json`;
    writeFileSync(path, JSON.stringify(leads, null, 2));
    // Keep only last 30 backups
    const files = readdirSync(backupDir).filter(f => f.startsWith('leads-')).sort();
    while (files.length > 30) {
      unlinkSync(`${backupDir}/${files.shift()}`);
    }
    log.info({ path, count: leads.length }, 'leads backup created');
    return path;
  } catch (err) {
    log.error({ err }, 'leads backup failed');
    return null;
  }
}

export { db, backupLeads };
