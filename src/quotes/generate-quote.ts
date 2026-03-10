/**
 * Generate a professional PDF price quote using Puppeteer.
 * Renders an HTML template to PDF with Alon.dev branding.
 */
import puppeteer from 'puppeteer';
import { createLogger } from '../utils/logger.js';

const log = createLogger('generate-quote');

/**
 * Generate a PDF price quote and return the buffer.
 */
export async function generateQuotePDF(
  leadName: string,
  phone: string,
  service: string,
  priceRange: string,
  details?: string,
): Promise<Buffer> {
  const today = new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });

  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;700;900&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Heebo', sans-serif;
      background: #fff;
      color: #1a1a2e;
      padding: 40px;
      direction: rtl;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 3px solid #7C3AED;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }

    .logo-section h1 {
      font-size: 32px;
      font-weight: 900;
      color: #1A0E3C;
    }

    .logo-section h1 span {
      color: #7C3AED;
    }

    .logo-section p {
      color: #666;
      font-size: 14px;
      margin-top: 4px;
    }

    .quote-number {
      background: #7C3AED;
      color: white;
      padding: 8px 20px;
      border-radius: 20px;
      font-weight: 700;
      font-size: 14px;
    }

    .date-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 30px;
      font-size: 14px;
      color: #555;
    }

    .section {
      margin-bottom: 25px;
    }

    .section-title {
      font-size: 18px;
      font-weight: 700;
      color: #1A0E3C;
      margin-bottom: 10px;
      padding-bottom: 5px;
      border-bottom: 1px solid #eee;
    }

    .client-info {
      background: #f8f6ff;
      border-radius: 12px;
      padding: 20px;
      border-right: 4px solid #7C3AED;
    }

    .client-info p {
      margin-bottom: 6px;
      font-size: 15px;
    }

    .client-info strong {
      color: #1A0E3C;
    }

    .service-box {
      background: #f8f6ff;
      border-radius: 12px;
      padding: 20px;
      border-right: 4px solid #06B6D4;
    }

    .service-name {
      font-size: 20px;
      font-weight: 700;
      color: #1A0E3C;
      margin-bottom: 8px;
    }

    .service-details {
      color: #555;
      font-size: 14px;
      line-height: 1.6;
      margin-bottom: 12px;
    }

    .price-tag {
      display: inline-block;
      background: linear-gradient(135deg, #7C3AED, #06B6D4);
      color: white;
      padding: 10px 24px;
      border-radius: 25px;
      font-size: 22px;
      font-weight: 900;
    }

    .terms {
      background: #fafafa;
      border-radius: 12px;
      padding: 20px;
      font-size: 13px;
      color: #777;
      line-height: 1.8;
    }

    .terms li {
      margin-bottom: 4px;
    }

    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 2px solid #eee;
      text-align: center;
      color: #999;
      font-size: 13px;
    }

    .footer a {
      color: #7C3AED;
      text-decoration: none;
      font-weight: 500;
    }

    .contact-row {
      display: flex;
      justify-content: center;
      gap: 30px;
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo-section">
      <h1>Alon<span>.dev</span></h1>
      <p>טכנולוגיה ודיגיטל לעסקים | אדם + AI = צוות שלם</p>
    </div>
    <div class="quote-number">הצעת מחיר</div>
  </div>

  <div class="date-row">
    <span>תאריך: ${today}</span>
    <span>תוקף ההצעה: ${validUntil}</span>
  </div>

  <div class="section">
    <div class="section-title">פרטי הלקוח</div>
    <div class="client-info">
      <p><strong>שם:</strong> ${escapeHtml(leadName)}</p>
      <p><strong>טלפון:</strong> ${formatPhone(phone)}</p>
    </div>
  </div>

  <div class="section">
    <div class="section-title">פירוט השירות</div>
    <div class="service-box">
      <div class="service-name">${escapeHtml(service)}</div>
      ${details ? `<div class="service-details">${escapeHtml(details)}</div>` : ''}
      <div class="price-tag">₪${escapeHtml(priceRange)}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">תנאים</div>
    <div class="terms">
      <ul>
        <li>ההצעה תקפה ל-7 ימים מתאריך ההנפקה.</li>
        <li>תשלום: 50% מקדמה בתחילת העבודה, 50% בסיום.</li>
        <li>זמן אספקה יסוכם לאחר אפיון מפורט.</li>
        <li>כולל עד 2 סבבי תיקונים. תיקונים נוספים בתשלום.</li>
        <li>המחיר לא כולל מע"מ.</li>
      </ul>
    </div>
  </div>

  <div class="footer">
    <p>Alon.dev — שירותי טכנולוגיה ודיגיטל</p>
    <div class="contact-row">
      <span>📞 054-630-0783</span>
      <span>📧 alon12@gmail.com</span>
      <span>🌐 alon-dev.vercel.app</span>
    </div>
  </div>
</body>
</html>`;

  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    ...(execPath ? { executablePath: execPath } : {}),
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfUint8 = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
    });
    const pdfBuffer = Buffer.from(pdfUint8);
    log.info({ leadName, service, price: priceRange }, 'PDF quote generated');
    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPhone(phone: string): string {
  // 972546300783 → 054-630-0783
  if (phone.startsWith('972')) {
    const local = '0' + phone.slice(3);
    return local.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
  }
  return phone;
}
