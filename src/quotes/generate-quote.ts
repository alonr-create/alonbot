/**
 * Generate a premium PDF price quote using Puppeteer.
 * Light theme with purple accents, Alon.dev branding.
 * If a website URL is provided, scrapes it for branding (colors, logo, name).
 */
import puppeteer from 'puppeteer';
import { createLogger } from '../utils/logger.js';
import { getBusinessName, getTimezone, getConfig } from '../db/tenant-config.js';
import { scrapeWebsite, type ScrapedBranding } from './scrape-website.js';
import { generateHeroImage } from './generate-hero-image.js';
import { ALON_LOGO_BASE64 } from './logo.js';

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

  const p = branding?.colors[0] || '#7C3AED';
  const s = branding?.colors[1] || '#06B6D4';

  // Generate AI hero image
  const heroImage = await generateHeroImage(service, leadName, [p, s]);

  // Client logo from scraped website
  const clientLogoHtml = branding?.logoBase64
    ? `<img src="${branding.logoBase64}" class="client-logo" />`
    : '';

  // Client branding extras
  const clientExtra = branding?.businessName
    ? `<div class="chip">${esc(branding.businessName)}</div>
       ${branding.tagline ? `<div class="chip muted">${esc(branding.tagline.slice(0, 80))}</div>` : ''}`
    : '';

  // Screenshot
  const screenshotHtml = branding?.screenshot
    ? `<div class="screenshot">
        <div class="browser-bar"><span></span><span></span><span></span></div>
        <img src="data:image/jpeg;base64,${branding.screenshot}" />
       </div>`
    : '';

  const serviceIcon = getServiceIcon(service);
  const includes = getServiceIncludes(service);

  // Payment link
  const paymentUrl = getConfig('payment_url');
  const paymentHtml = paymentUrl
    ? `<div class="payment">
        <div class="payment-text">מוכנים להתחיל? לחצו לתשלום מקדמה מאובטח</div>
        <a href="${paymentUrl}" class="payment-btn">לתשלום מאובטח דרך Bit &larr;</a>
       </div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;700;900&display=swap');
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Heebo', sans-serif;
  background: #F5F3FF;
  color: #1F2937;
  direction: rtl;
}

/* ── Header ── */
.header {
  background: linear-gradient(135deg, ${p}, ${s});
  padding: 20px 30px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.logo {
  width: 50px;
  height: 50px;
  border-radius: 12px;
  object-fit: cover;
  border: 2px solid rgba(255,255,255,0.3);
}
.brand-name {
  font-size: 24px;
  font-weight: 900;
  color: white;
}
.brand-sub {
  font-size: 11px;
  color: rgba(255,255,255,0.8);
}
.badge {
  background: rgba(255,255,255,0.2);
  color: white;
  padding: 6px 18px;
  border-radius: 20px;
  font-weight: 700;
  font-size: 13px;
}

/* ── Dates ── */
.dates {
  display: flex;
  justify-content: space-between;
  padding: 8px 30px;
  font-size: 11px;
  color: #6B7280;
  background: #EDE9FE;
}

/* ── Content ── */
.content { padding: 16px 30px 12px; }

/* ── Cards ── */
.card {
  background: white;
  border-radius: 12px;
  padding: 14px 18px;
  margin-bottom: 10px;
  border: 1px solid #E5E7EB;
}
.card-accent { border-right: 3px solid ${p}; }
.card-service { border-right: 3px solid ${s}; }

.label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: ${p};
  font-weight: 700;
  margin-bottom: 6px;
}

/* ── Client ── */
.client-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.client-logo {
  max-height: 36px;
  max-width: 100px;
  border-radius: 6px;
}
.client-name { font-size: 15px; font-weight: 700; }
.client-phone { font-size: 12px; color: #6B7280; }
.chip {
  display: inline-block;
  background: #F3F4F6;
  padding: 2px 10px;
  border-radius: 6px;
  font-size: 11px;
  color: #6B7280;
  margin-top: 4px;
}

/* ── Service ── */
.service-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.s-icon {
  width: 36px;
  height: 36px;
  background: ${p}15;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.s-icon svg {
  width: 18px;
  height: 18px;
  stroke: ${p};
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.s-name { font-size: 16px; font-weight: 700; }
.s-desc { font-size: 12px; color: #6B7280; line-height: 1.6; margin-bottom: 8px; }
.price {
  display: inline-block;
  background: linear-gradient(135deg, ${p}, ${s});
  color: white;
  padding: 8px 24px;
  border-radius: 24px;
  font-size: 20px;
  font-weight: 900;
}
.price-note { display: inline; font-size: 11px; color: #9CA3AF; margin-right: 8px; }

/* ── Screenshot ── */
.screenshot {
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid #E5E7EB;
  margin-bottom: 10px;
}
.browser-bar {
  display: flex;
  gap: 5px;
  padding: 7px 12px;
  background: #F3F4F6;
}
.browser-bar span { width: 8px; height: 8px; border-radius: 50%; }
.browser-bar span:nth-child(1) { background: #EF4444; }
.browser-bar span:nth-child(2) { background: #F59E0B; }
.browser-bar span:nth-child(3) { background: #10B981; }
.screenshot img { width: 100%; display: block; }

/* ── Includes ── */
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.grid-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: #F9FAFB;
  border-radius: 8px;
  font-size: 12px;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: ${p};
  flex-shrink: 0;
}

/* ── Terms ── */
.terms {
  list-style: none;
  font-size: 11px;
  color: #6B7280;
  line-height: 1.8;
}
.terms li::before {
  content: '\\2022';
  color: ${p};
  margin-left: 6px;
  font-weight: 700;
}

/* ── Payment ── */
.payment {
  background: linear-gradient(135deg, ${p}, ${s});
  border-radius: 12px;
  padding: 14px;
  text-align: center;
  margin-bottom: 10px;
}
.payment-text {
  font-size: 12px;
  color: rgba(255,255,255,0.9);
  margin-bottom: 8px;
}
.payment-btn {
  display: inline-block;
  background: white;
  color: ${p};
  padding: 8px 30px;
  border-radius: 24px;
  font-size: 14px;
  font-weight: 700;
  text-decoration: none;
}

/* ── Footer ── */
.footer {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #E5E7EB;
  text-align: center;
  font-size: 11px;
  color: #9CA3AF;
}
.footer-contacts {
  display: flex;
  justify-content: center;
  gap: 16px;
  margin-top: 4px;
  font-size: 11px;
  color: #6B7280;
}
</style>
</head>
<body>

<div class="header">
  <div class="header-right">
    <img src="${ALON_LOGO_BASE64}" class="logo" />
    <div>
      <div class="brand-name">Alon.dev</div>
      <div class="brand-sub">אדם + AI = צוות שלם</div>
    </div>
  </div>
  <div class="badge">הצעת מחיר</div>
</div>

<div class="dates">
  <span>תאריך: ${today}</span>
  <span>תוקף: ${validUntil}</span>
</div>

<div class="content">
  <!-- Client -->
  <div class="card card-accent">
    <div class="label">פרטי הלקוח</div>
    <div class="client-row">
      ${clientLogoHtml}
      <div>
        <div class="client-name">${esc(leadName)}</div>
        <div class="client-phone">${formatPhone(phone)}</div>
      </div>
    </div>
    ${clientExtra}
  </div>

  ${screenshotHtml}

  <!-- Service -->
  <div class="card card-service">
    <div class="label">פירוט השירות</div>
    <div class="service-row">
      <div class="s-icon">${serviceIcon}</div>
      <div class="s-name">${esc(service)}</div>
    </div>
    ${details ? `<div class="s-desc">${esc(details)}</div>` : ''}
    <div>
      <span class="price">${esc(priceRange).startsWith('₪') ? '' : '₪'}${esc(priceRange)}</span>
      <span class="price-note">לא כולל מע"מ</span>
    </div>
  </div>

  <!-- Includes -->
  <div class="card">
    <div class="label">מה כולל?</div>
    <div class="grid">
      ${includes.map(i => `<div class="grid-item"><div class="dot"></div>${i}</div>`).join('\n      ')}
    </div>
  </div>

  <!-- Terms -->
  <div class="card">
    <div class="label">תנאים</div>
    <ul class="terms">
      <li>ההצעה תקפה ל-7 ימים</li>
      <li>תשלום: 50% מקדמה, 50% בסיום</li>
      <li>זמן אספקה יסוכם לאחר אפיון</li>
      <li>כולל עד 2 סבבי תיקונים</li>
    </ul>
  </div>

  ${paymentHtml}

  <!-- Footer -->
  <div class="footer">
    ${esc(businessName)} — שירותי טכנולוגיה ודיגיטל
    <div class="footer-contacts">
      <span>054-630-0783</span>
      <span>alondevoffice@gmail.com</span>
      <span>alon.dev</span>
    </div>
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
  return '<svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
}

function getServiceIncludes(service: string): string[] {
  const s = service.toLowerCase();
  if (s.includes('אתר') || s.includes('website') || s.includes('לנדינג')) {
    return ['עיצוב מותאם למיתוג', 'Responsive לכל מכשיר', 'אופטימיזציה למהירות', 'SEO בסיסי', 'הדרכה על ניהול תוכן', 'חיבור דומיין ואחסון'];
  }
  if (s.includes('בוט') || s.includes('bot') || s.includes('אוטומציה')) {
    return ['פיתוח בוט AI מותאם', 'חיבור WhatsApp / Telegram', 'מענה אוטומטי 24/7', 'ניהול לידים אוטומטי', 'פולואפים חכמים', 'דשבורד ניהול ומעקב'];
  }
  if (s.includes('crm') || s.includes('דשבורד') || s.includes('מערכת')) {
    return ['עיצוב ממשק מותאם', 'ניהול לקוחות ולידים', 'דוחות וגרפים', 'הרשאות משתמשים', 'חיבור APIs חיצוניים', 'אבטחת מידע'];
  }
  return ['עיצוב מותאם אישית', 'פיתוח מלא מ-0', 'עד 2 סבבי תיקונים', 'אופטימיזציה וביצועים', 'הדרכה מלאה', 'תמיכה טכנית'];
}
