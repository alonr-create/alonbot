import type Database from 'better-sqlite3';

export function initSchema(db: Database.Database): void {
  // ── Tenants table — must be created FIRST for FK references ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      wa_phone_number_id TEXT NOT NULL UNIQUE,
      wa_number TEXT NOT NULL,
      monday_board_id INTEGER NOT NULL,
      business_name TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      admin_phone TEXT NOT NULL,
      personality TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
      payment_url TEXT NOT NULL DEFAULT '',
      service_catalog TEXT NOT NULL DEFAULT '[]',
      sales_faq TEXT NOT NULL DEFAULT '[]',
      sales_objections TEXT NOT NULL DEFAULT '[]',
      portfolio TEXT NOT NULL DEFAULT '[]',
      wa_cloud_token TEXT,
      active INTEGER NOT NULL DEFAULT 1
    )
  `);

  // Seed tenants — idempotent via INSERT OR IGNORE
  const seedTenant = db.prepare(`
    INSERT OR IGNORE INTO tenants
      (name, wa_phone_number_id, wa_number, monday_board_id, business_name, owner_name, admin_phone)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  seedTenant.run('דקל', '1080047101853955', '972559566148', 1443236269, 'דקל לפרישה', 'דקל', '972546300783');
  seedTenant.run('alondev', '967467269793135', '972559173249', 5092777389, 'Alon.dev', 'אלון', '972546300783');

  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL UNIQUE,
      name TEXT,
      source TEXT DEFAULT 'whatsapp',
      status TEXT NOT NULL DEFAULT 'new'
        CHECK(status IN ('new', 'contacted', 'in-conversation', 'quote-sent',
                          'meeting-scheduled', 'escalated', 'closed-won', 'closed-lost')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id),
      phone TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in', 'out')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone, created_at);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
  `);

  // Idempotent migration: add Monday.com columns to leads + tenant_id to leads/messages
  const migrations = [
    'ALTER TABLE leads ADD COLUMN monday_item_id INTEGER',
    'ALTER TABLE leads ADD COLUMN monday_board_id INTEGER',
    'ALTER TABLE leads ADD COLUMN interest TEXT',
    'ALTER TABLE leads ADD COLUMN escalation_count INTEGER DEFAULT 0',
    "ALTER TABLE leads ADD COLUMN notes TEXT DEFAULT ''",
    'ALTER TABLE leads ADD COLUMN score INTEGER DEFAULT 0',
    "ALTER TABLE leads ADD COLUMN source_detail TEXT DEFAULT ''",
    'ALTER TABLE leads ADD COLUMN tenant_id INTEGER REFERENCES tenants(id)',
    'ALTER TABLE messages ADD COLUMN tenant_id INTEGER REFERENCES tenants(id)',
  ];

  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists — expected on subsequent runs
    }
  }

  // Follow-ups table for automated re-engagement
  db.exec(`
    CREATE TABLE IF NOT EXISTS follow_ups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      message_number INTEGER NOT NULL CHECK(message_number IN (1, 2, 3)),
      scheduled_at TEXT NOT NULL,
      sent_at TEXT,
      cancelled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_follow_ups_due
      ON follow_ups(scheduled_at) WHERE sent_at IS NULL AND cancelled = 0;
    CREATE INDEX IF NOT EXISTS idx_follow_ups_phone
      ON follow_ups(phone) WHERE sent_at IS NULL AND cancelled = 0;
  `);

  // Reminders table for boss-scheduled reminders
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      message TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_reminders_due
      ON reminders(scheduled_at) WHERE sent = 0;
  `);

  // Tenant configuration table — makes the bot configurable per deployment
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Seed default tenant config (Alon.dev) — only inserts if key doesn't exist
  const seedConfig = db.prepare(
    'INSERT OR IGNORE INTO tenant_config (key, value) VALUES (?, ?)',
  );

  const defaults: Record<string, string> = {
    // Business identity
    business_name: 'Alon.dev',
    business_description: 'עסק של אלון, יזם עצמאי שמשתמש ב-AI כדי לתת ללקוחות יכולת של צוות שלם במחיר של פרילנסר',
    business_website: 'alon-dev.vercel.app',
    owner_name: 'אלון',
    admin_phone: '972546300783',

    // Personality
    bot_personality: 'אגרסיבי במכירות — דוחף אבל לא גס. יוצר תחושת דחיפות. עברית לא פורמלית, ידידותית אבל עסקית. תמיד מסיים עם שאלה או הצעה לפעולה הבאה.',
    escalation_message: 'תודה על הסבלנות! {owner} יחזור אליך בהקדם האפשרי.',

    // Service catalog (JSON)
    service_catalog: JSON.stringify([
      { category: 'אתרים', items: [
        { name: 'דפי נחיתה (Landing pages)', min: 2000, max: 5000 },
        { name: 'אתרים עסקיים (Business sites)', min: 5000, max: 15000 },
        { name: 'חנויות אונליין (E-commerce)', min: 10000, max: 30000 },
      ]},
      { category: 'אפליקציות', items: [
        { name: 'אפליקציות מובייל (Mobile apps)', min: 15000, max: 50000 },
        { name: 'אפליקציות ווב (Web apps)', min: 10000, max: 40000 },
      ]},
      { category: 'משחקים', items: [
        { name: 'משחקי דפדפן (Browser games)', min: 5000, max: 20000 },
        { name: 'משחקי מובייל (Mobile games)', min: 20000, max: 60000 },
      ]},
      { category: 'אוטומציה ו-CRM', items: [
        { name: 'תהליכי אוטומציה (Automation flows)', min: 3000, max: 10000 },
        { name: 'הקמת CRM (CRM setup)', min: 5000, max: 15000 },
      ]},
      { category: 'שיווק דיגיטלי', items: [
        { name: 'ניהול רשתות חברתיות (Social media)', min: 2000, max: 5000, unit: 'חודש' },
        { name: 'קידום אורגני SEO', min: 3000, max: 8000, unit: 'חודש' },
      ]},
      { category: 'תחזוקה חודשית', items: [
        { name: 'תחזוקת אתר/אפליקציה (אחסון, עדכונים, גיבויים)', min: 300, max: 500, unit: 'חודש' },
        { name: 'תחזוקת בוט/אוטומציה (אחסון, תמיכה, עדכוני AI)', min: 500, max: 800, unit: 'חודש' },
      ]},
    ]),

    // Payment
    payment_url: 'https://www.bitpay.co.il/app/me/38949393-1774-D91E-21A0-A16CDB3A39A29D00',

    // Timezone & hours
    timezone: 'Asia/Jerusalem',
    business_hours_start: '9',
    business_hours_end: '18',
    work_days: 'Sun,Mon,Tue,Wed,Thu',

    // Meeting type
    meeting_type: 'שיחת Zoom',

    // Portfolio — showcase links the bot can share
    portfolio: JSON.stringify([
      { name: 'מצפן לעושר — אתר קורסים', url: 'https://wealthy-mindset.vercel.app', type: 'אתר עסקי', desc: 'אתר עם מערכת תשלומים, קורסים ותוכן' },
      { name: 'דקל לפרישה — מערכת אוטומציה', url: 'https://dprisha.co.il', type: 'CRM + אוטומציה', desc: 'מערכת דוחות אוטומטית, ניהול לידים, אימיילים' },
      { name: 'בנצי הצב — משחק AI', url: 'https://bentzi-production.up.railway.app', type: 'משחק + AI', desc: 'טמגוצ׳י דיגיטלי עם בינה מלאכותית' },
      { name: 'כפר קלוד — עולם וירטואלי', url: 'https://easygoing-vitality-production-2c44.up.railway.app', type: 'אפליקציה + AI', desc: 'כפר אנימטיבי עם סוכנים אוטונומיים' },
      { name: 'עליזה המפרסמת — ניהול שיווק', url: 'https://aliza-web-production.up.railway.app', type: 'אפליקציה + AI', desc: 'פלטפורמת ניהול רשתות חברתיות עם AI' },
    ]),

    // Sales playbook — FAQ, objections, closing techniques
    sales_faq: JSON.stringify([
      { q: 'כמה זמן לוקח לבנות אתר?', a: 'אתר עסקי: 1-2 שבועות. דף נחיתה: 3-5 ימים. חנות אונליין: 2-4 שבועות. הכל תלוי בהיקף.' },
      { q: 'מה כלול במחיר?', a: 'עיצוב מותאם אישית, פיתוח מלא, התאמה למובייל, SEO בסיסי, הדרכה, ו-30 יום תמיכה אחרי השקה.' },
      { q: 'איך התהליך עובד?', a: 'פגישת היכרות חינם → הצעת מחיר → עיצוב ואישור → פיתוח → השקה. תשלום: 50% מקדמה, 50% בהשקה.' },
      { q: 'למה לא לבנות לבד ב-Wix?', a: 'Wix מצוין להתחלה, אבל כשצריך ביצועים, SEO אמיתי, ואינטגרציות מותאמות — צריך פיתוח מקצועי. וזה לא יקר כמו שחושבים.' },
      { q: 'יש אחריות?', a: '30 יום תמיכה מלאה אחרי השקה, וחבילות תחזוקה חודשיות לטווח ארוך.' },
    ]),

    // Common objection handling
    sales_objections: JSON.stringify([
      { objection: 'יקר/לא בתקציב', response: 'אני מבין. בוא נדבר על מה שאתה באמת צריך — אולי אפשר להתחיל עם גרסה בסיסית ולהרחיב בהמשך. מה התקציב שנוח לך?' },
      { objection: 'צריך לחשוב על זה', response: 'בטח, קח את הזמן. רק שתדע — יש לי עומס גדול החודש ומי שנכנס עכשיו מתחיל מהר. אשמח לשריין לך מקום אם תרצה.' },
      { objection: 'יש לי כבר מישהו/מפתח', response: 'מעולה! אם אתה מרוצה, זה הכי חשוב. אם בעתיד תצטרך עזרה נוספת או דעה שנייה — אני כאן.' },
      { objection: 'אני יכול לעשות לבד', response: 'יש הרבה כלים טובים היום. אבל הזמן שלך שווה כסף — מה שלוקח לך שבועות, אני עושה בימים. ובאיכות שמניבה תוצאות.' },
      { objection: 'צריך לדבר עם שותף/אשה', response: 'ברור, חשוב להתייעץ. רוצה שאשלח לך סיכום קצר שתוכל להעביר? ככה יהיה לכם קל להחליט ביחד.' },
    ]),
  };

  for (const [key, value] of Object.entries(defaults)) {
    seedConfig.run(key, value);
  }

  // Bot learning rules — boss corrections and preferences that persist
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'boss',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Idempotent migration: add tenant_id to tables created after the first migrations block
  const lateTableMigrations = [
    'ALTER TABLE follow_ups ADD COLUMN tenant_id INTEGER REFERENCES tenants(id)',
    'ALTER TABLE bot_rules ADD COLUMN tenant_id INTEGER REFERENCES tenants(id)',
  ];

  for (const sql of lateTableMigrations) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists — expected on subsequent runs
    }
  }

  // Backfill existing rows with דקל tenant_id (the original single-tenant data)
  const backfills = [
    "UPDATE leads SET tenant_id = (SELECT id FROM tenants WHERE name = 'דקל') WHERE tenant_id IS NULL",
    "UPDATE messages SET tenant_id = (SELECT id FROM tenants WHERE name = 'דקל') WHERE tenant_id IS NULL",
    "UPDATE follow_ups SET tenant_id = (SELECT id FROM tenants WHERE name = 'דקל') WHERE tenant_id IS NULL",
    "UPDATE bot_rules SET tenant_id = (SELECT id FROM tenants WHERE name = 'דקל') WHERE tenant_id IS NULL",
  ];

  for (const sql of backfills) {
    try {
      db.exec(sql);
    } catch {
      // Ignore — backfill is idempotent
    }
  }
}
