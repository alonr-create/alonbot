/**
 * Generate a premium PDF price quote using Puppeteer.
 * Dark theme, gradients, glassmorphism, optional AI-generated hero image.
 * If a website URL is provided, scrapes it for branding (colors, logo, name).
 */
import puppeteer from 'puppeteer';
import { createLogger } from '../utils/logger.js';
import { getBusinessName, getTimezone, getConfig } from '../db/tenant-config.js';
import { scrapeWebsite, type ScrapedBranding } from './scrape-website.js';
import { generateHeroImage } from './generate-hero-image.js';

const log = createLogger('generate-quote');

export async function generateQuotePDF(
  leadName: string,
  phone: string,
  service: string,
  priceRange: string,
  details?: string,
  websiteUrl?: string,
): Promise<Buffer> {
  const tz = getTimezone();
  const today = new Date().toLocaleDateString('he-IL', { timeZone: tz });
  const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString('he-IL', { timeZone: tz });
  const businessName = getBusinessName();

  // Scrape website if URL provided
  let branding: ScrapedBranding | null = null;
  if (websiteUrl) {
    log.info({ websiteUrl }, 'scraping website for quote branding');
    branding = await scrapeWebsite(websiteUrl);
    if (!branding.colors.length && !branding.logoBase64) {
      branding = null;
    }
  }

  // Color scheme
  const p = branding?.colors[0] || '#7C3AED';
  const s = branding?.colors[1] || '#06B6D4';
  const accent = branding?.colors[2] || '#F59E0B';

  // Generate AI hero image (runs in parallel concept — but sequential here)
  const heroImage = await generateHeroImage(service, leadName, [p, s]);

  // Logo
  const logoHtml = branding?.logoBase64
    ? `<img src="${branding.logoBase64}" class="client-logo" />`
    : '';

  // Screenshot
  const screenshotHtml = branding?.screenshot
    ? `<div class="screenshot-block">
        <div class="label">האתר הנוכחי שלכם</div>
        <div class="screenshot-frame">
          <div class="browser-dots"><span></span><span></span><span></span></div>
          <img src="data:image/jpeg;base64,${branding.screenshot}" />
        </div>
        <p class="screenshot-note">נשדרג אותו למשהו מדהים!</p>
       </div>`
    : '';

  // Client branding
  const clientExtra = branding?.businessName
    ? `<div class="info-chip">${esc(branding.businessName)}</div>
       ${branding.tagline ? `<div class="info-chip muted">${esc(branding.tagline.slice(0, 80))}</div>` : ''}`
    : '';

  // Hero section
  const heroHtml = heroImage
    ? `<div class="hero"><img src="${heroImage}" /></div>`
    : `<div class="hero hero-gradient"></div>`;

  // Determine service icon SVG based on keywords
  const serviceIcon = getServiceIcon(service);

  // "What's included" items — dynamic based on service type
  const includes = getServiceIncludes(service);

  // Payment link (Bit)
  const paymentUrl = getConfig('payment_url');
  const paymentHtml = paymentUrl
    ? `<!-- Payment CTA -->
  <div class="payment-cta">
    <div class="payment-title">💳 מוכנים להתחיל?</div>
    <div class="payment-subtitle">לחצו לתשלום מקדמה מאובטח דרך Bit</div>
    <a href="${paymentUrl}" class="payment-btn">לתשלום מאובטח →</a>
    <div class="payment-secure">🔒 תשלום מאובטח באמצעות Bit</div>
  </div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;700;900&display=swap');

:root {
  --p: ${p};
  --s: ${s};
  --accent: ${accent};
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: 'Heebo', sans-serif;
  background: #0B0F1A;
  color: #E5E7EB;
  direction: rtl;
  min-height: 100vh;
}

/* ── Hero ── */
.hero {
  height: 160px;
  overflow: hidden;
  position: relative;
}
.hero img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.hero-gradient {
  background: linear-gradient(135deg, ${p}40, ${s}40, ${p}20);
  position: relative;
}
.hero-gradient::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 20% 50%, ${p}60 0%, transparent 50%),
    radial-gradient(circle at 80% 30%, ${s}40 0%, transparent 40%),
    radial-gradient(circle at 50% 80%, ${accent}30 0%, transparent 35%);
}
.hero::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 60px;
  background: linear-gradient(transparent, #0B0F1A);
}

/* ── Main content ── */
.content {
  padding: 0 40px 40px;
  margin-top: -40px;
  position: relative;
  z-index: 1;
}

/* ── Header bar ── */
.header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 30px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.brand-icon {
  width: 48px;
  height: 48px;
  background: linear-gradient(135deg, var(--p), var(--s));
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  font-weight: 900;
  color: white;
  box-shadow: 0 4px 20px ${p}40;
}
.brand h1 {
  font-size: 28px;
  font-weight: 900;
  color: #fff;
}
.brand h1 span { color: var(--p); }
.brand p {
  font-size: 12px;
  color: #9CA3AF;
  margin-top: 2px;
}
.badge {
  background: linear-gradient(135deg, var(--p), var(--s));
  color: white;
  padding: 8px 22px;
  border-radius: 20px;
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.5px;
  box-shadow: 0 4px 15px ${p}50;
}
.dates {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #6B7280;
  margin-bottom: 24px;
  padding: 0 4px;
}

/* ── Glass cards ── */
.glass {
  background: rgba(255,255,255,0.04);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 16px;
  padding: 24px;
  margin-bottom: 20px;
}
.glass-accent {
  border-right: 3px solid var(--p);
}
.glass-service {
  border-right: 3px solid var(--s);
  position: relative;
  overflow: hidden;
}
.glass-service::before {
  content: '';
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(circle, ${s}08, transparent 50%);
}

.label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: var(--p);
  font-weight: 700;
  margin-bottom: 14px;
}

/* ── Client info ── */
.client-row {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.client-logo {
  max-height: 50px;
  max-width: 140px;
  object-fit: contain;
  border-radius: 8px;
}
.client-details p {
  font-size: 14px;
  margin-bottom: 4px;
  color: #D1D5DB;
}
.client-details strong { color: #fff; }
.info-chip {
  display: inline-block;
  background: rgba(255,255,255,0.06);
  padding: 4px 12px;
  border-radius: 8px;
  font-size: 12px;
  color: #9CA3AF;
  margin-top: 8px;
  margin-left: 6px;
}
.info-chip.muted { color: #6B7280; font-size: 11px; }

/* ── Service ── */
.service-header {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 12px;
  position: relative;
}
.service-icon {
  width: 44px;
  height: 44px;
  background: linear-gradient(135deg, ${s}30, ${p}30);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.service-icon svg {
  width: 22px;
  height: 22px;
  stroke: var(--s);
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.service-name {
  font-size: 22px;
  font-weight: 700;
  color: #fff;
}
.service-desc {
  color: #9CA3AF;
  font-size: 13px;
  line-height: 1.7;
  margin-bottom: 16px;
  position: relative;
}
.price-row {
  display: flex;
  align-items: center;
  gap: 12px;
  position: relative;
}
.price-tag {
  background: linear-gradient(135deg, var(--p), var(--s));
  color: white;
  padding: 12px 32px;
  border-radius: 30px;
  font-size: 26px;
  font-weight: 900;
  box-shadow: 0 6px 25px ${p}40;
  letter-spacing: 0.5px;
}
.price-note {
  font-size: 12px;
  color: #6B7280;
}

/* ── Screenshot ── */
.screenshot-block { margin-bottom: 20px; }
.screenshot-frame {
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.1);
  background: #111827;
}
.browser-dots {
  display: flex;
  gap: 6px;
  padding: 10px 14px;
  background: #1F2937;
}
.browser-dots span {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.browser-dots span:nth-child(1) { background: #EF4444; }
.browser-dots span:nth-child(2) { background: #F59E0B; }
.browser-dots span:nth-child(3) { background: #10B981; }
.screenshot-frame img {
  width: 100%;
  display: block;
}
.screenshot-note {
  font-size: 12px;
  color: var(--s);
  text-align: center;
  margin-top: 8px;
  font-weight: 500;
}

/* ── Includes grid ── */
.includes-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.include-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: rgba(255,255,255,0.03);
  border-radius: 10px;
  font-size: 13px;
  color: #D1D5DB;
}
.include-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--p), var(--s));
  flex-shrink: 0;
}

/* ── Terms ── */
.terms-list {
  list-style: none;
  font-size: 12px;
  color: #6B7280;
  line-height: 2;
}
.terms-list li::before {
  content: '•';
  color: var(--p);
  margin-left: 8px;
  font-weight: 700;
}

/* ── Payment CTA ── */
.payment-cta {
  background: linear-gradient(135deg, var(--p), var(--s));
  border-radius: 16px;
  padding: 24px;
  text-align: center;
  margin-bottom: 20px;
  position: relative;
  overflow: hidden;
}
.payment-cta::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at 30% 50%, rgba(255,255,255,0.1), transparent 60%);
}
.payment-title {
  font-size: 18px;
  font-weight: 700;
  color: white;
  margin-bottom: 8px;
  position: relative;
}
.payment-subtitle {
  font-size: 13px;
  color: rgba(255,255,255,0.8);
  margin-bottom: 16px;
  position: relative;
}
.payment-btn {
  display: inline-block;
  background: white;
  color: #1a1a2e;
  padding: 12px 40px;
  border-radius: 30px;
  font-size: 16px;
  font-weight: 700;
  text-decoration: none;
  position: relative;
  box-shadow: 0 4px 15px rgba(0,0,0,0.3);
}
.payment-secure {
  font-size: 11px;
  color: rgba(255,255,255,0.6);
  margin-top: 10px;
  position: relative;
}

/* ── Footer ── */
.footer {
  margin-top: 30px;
  padding-top: 20px;
  border-top: 1px solid rgba(255,255,255,0.06);
  text-align: center;
}
.footer-brand {
  font-size: 13px;
  color: #6B7280;
  margin-bottom: 6px;
}
.footer-contacts {
  display: flex;
  justify-content: center;
  gap: 24px;
  font-size: 12px;
  color: #4B5563;
}
.footer-contacts span {
  display: flex;
  align-items: center;
  gap: 6px;
}
.footer-tagline {
  margin-top: 12px;
  font-size: 11px;
  color: #374151;
  letter-spacing: 1px;
}

/* ── Decorative ── */
.glow-orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(60px);
  opacity: 0.15;
  pointer-events: none;
}
</style>
</head>
<body>

${heroHtml}

<div class="content">
  <div class="header-bar">
    <div class="brand">
      <div class="brand-icon">A</div>
      <div>
        <h1>Alon<span>.dev</span></h1>
        <p>אדם + AI = צוות שלם</p>
      </div>
    </div>
    <div class="badge">הצעת מחיר</div>
  </div>

  <div class="dates">
    <span>תאריך: ${today}</span>
    <span>תוקף: ${validUntil}</span>
  </div>

  <!-- Client Info -->
  <div class="glass glass-accent">
    <div class="label">פרטי הלקוח</div>
    <div class="client-row">
      ${logoHtml}
      <div class="client-details">
        <p><strong>${esc(leadName)}</strong></p>
        <p>${formatPhone(phone)}</p>
      </div>
    </div>
    ${clientExtra}
  </div>

  ${screenshotHtml}

  <!-- Service -->
  <div class="glass glass-service">
    <div class="label">פירוט השירות</div>
    <div class="service-header">
      <div class="service-icon">${serviceIcon}</div>
      <div class="service-name">${esc(service)}</div>
    </div>
    ${details ? `<div class="service-desc">${esc(details)}</div>` : ''}
    <div class="price-row">
      <div class="price-tag">${esc(priceRange).startsWith('₪') ? '' : '₪'}${esc(priceRange)}</div>
      <div class="price-note">לא כולל מע"מ</div>
    </div>
  </div>

  <!-- What's Included -->
  <div class="glass">
    <div class="label">מה כולל?</div>
    <div class="includes-grid">
      ${includes.map(i => `<div class="include-item"><div class="include-dot"></div>${i}</div>`).join('\n      ')}
    </div>
  </div>

  <!-- Terms -->
  <div class="glass">
    <div class="label">תנאים</div>
    <ul class="terms-list">
      <li>ההצעה תקפה ל-7 ימים מתאריך ההנפקה</li>
      <li>תשלום: 50% מקדמה בתחילת העבודה, 50% בסיום</li>
      <li>זמן אספקה יסוכם לאחר אפיון מפורט</li>
      <li>כולל עד 2 סבבי תיקונים</li>
    </ul>
  </div>

  ${paymentHtml}

  <!-- Footer -->
  <div class="footer">
    <div class="footer-brand">${esc(businessName)} — שירותי טכנולוגיה ודיגיטל</div>
    <div class="footer-contacts">
      <span>054-630-0783</span>
      <span>alon12@gmail.com</span>
      <span>alon.dev</span>
    </div>
    <div class="footer-tagline">P O W E R E D &nbsp; B Y &nbsp; A I</div>
  </div>
</div>

</body>
</html>`;

  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--single-process',
      '--no-zygote',
    ],
    ...(execPath ? { executablePath: execPath } : {}),
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const pdfUint8 = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
    const pdfBuffer = Buffer.from(pdfUint8);
    log.info(
      { leadName, service, price: priceRange, hasWebsite: !!websiteUrl, hasBranding: !!branding, hasHero: !!heroImage },
      'PDF quote generated',
    );
    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPhone(phone: string): string {
  if (phone.startsWith('972')) {
    const local = '0' + phone.slice(3);
    return local.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
  }
  return phone;
}

/** Get an SVG icon based on service keywords. */
function getServiceIcon(service: string): string {
  const s = service.toLowerCase();
  if (s.includes('אתר') || s.includes('website') || s.includes('לנדינג') || s.includes('דף'))
    return '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>';
  if (s.includes('בוט') || s.includes('bot') || s.includes('אוטומציה') || s.includes('automation'))
    return '<svg viewBox="0 0 24 24"><path d="M12 8V4H8"/><rect x="5" y="8" width="14" height="12" rx="2"/><path d="M2 14h2m16 0h2"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/><path d="M10 17h4"/></svg>';
  if (s.includes('crm') || s.includes('דשבורד') || s.includes('מערכת') || s.includes('dashboard'))
    return '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  if (s.includes('אפליקציה') || s.includes('app') || s.includes('משחק') || s.includes('game'))
    return '<svg viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg>';
  if (s.includes('שיווק') || s.includes('marketing') || s.includes('קמפיין') || s.includes('תוכן'))
    return '<svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>';
  // Default: code icon
  return '<svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
}

/** Get "what's included" list based on service type. */
function getServiceIncludes(service: string): string[] {
  const s = service.toLowerCase();
  if (s.includes('אתר') || s.includes('website') || s.includes('לנדינג')) {
    return [
      'עיצוב מותאם למיתוג שלכם',
      'Responsive לכל מכשיר',
      'אופטימיזציה למהירות',
      'SEO בסיסי',
      'הדרכה על ניהול תוכן',
      'חיבור דומיין ואחסון',
    ];
  }
  if (s.includes('בוט') || s.includes('bot') || s.includes('אוטומציה')) {
    return [
      'פיתוח בוט AI מותאם',
      'חיבור WhatsApp / Telegram',
      'מענה אוטומטי 24/7',
      'ניהול לידים אוטומטי',
      'פולואפים חכמים',
      'דשבורד ניהול ומעקב',
    ];
  }
  if (s.includes('crm') || s.includes('דשבורד') || s.includes('מערכת')) {
    return [
      'עיצוב ממשק מותאם',
      'ניהול לקוחות ולידים',
      'דוחות וגרפים',
      'הרשאות משתמשים',
      'חיבור APIs חיצוניים',
      'אבטחת מידע',
    ];
  }
  // Default
  return [
    'עיצוב מותאם אישית',
    'פיתוח מלא מ-0',
    'עד 2 סבבי תיקונים',
    'אופטימיזציה וביצועים',
    'הדרכה מלאה',
    'תמיכה טכנית',
  ];
}
