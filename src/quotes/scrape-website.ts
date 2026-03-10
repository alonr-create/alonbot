/**
 * Scrape a website for branding assets: screenshot, colors, logo, business name, tagline.
 * Uses Puppeteer (already installed for whatsapp-web.js).
 */
import puppeteer from 'puppeteer';
import { createLogger } from '../utils/logger.js';

const log = createLogger('scrape-website');

export interface ScrapedBranding {
  /** Base64-encoded screenshot (JPEG, 1200px wide) */
  screenshot: string;
  /** Extracted dominant colors (hex) */
  colors: string[];
  /** Logo URL if found */
  logoUrl: string | null;
  /** Logo as base64 data URI if we managed to capture it */
  logoBase64: string | null;
  /** Business name from <title> or og:site_name */
  businessName: string;
  /** Tagline / description */
  tagline: string;
  /** Favicon URL */
  faviconUrl: string | null;
}

/**
 * Scrape a website and extract branding information.
 * Timeout: 15 seconds max.
 */
export async function scrapeWebsite(url: string): Promise<ScrapedBranding> {
  // Normalize URL
  if (!url.startsWith('http')) {
    url = 'https://' + url;
  }

  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    ...(execPath ? { executablePath: execPath } : {}),
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });

    // Take screenshot
    const screenshotBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 80,
      fullPage: false,
    });
    const screenshot = Buffer.from(screenshotBuffer).toString('base64');

    // Extract branding info from page
    const branding = await page.evaluate(() => {
      // Business name: og:site_name > og:title > <title>
      const ogSiteName = document.querySelector('meta[property="og:site_name"]')?.getAttribute('content');
      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
      const titleTag = document.title;
      const businessName = ogSiteName || ogTitle || titleTag || '';

      // Tagline: og:description > meta description > h1
      const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute('content');
      const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content');
      const h1 = document.querySelector('h1')?.textContent?.trim();
      const tagline = ogDesc || metaDesc || h1 || '';

      // Logo: look for common patterns
      let logoUrl: string | null = null;
      const logoSelectors = [
        'a[class*="logo"] img',
        '[class*="logo"] img',
        '[id*="logo"] img',
        'header img:first-of-type',
        'nav img:first-of-type',
        '.navbar-brand img',
        'a[href="/"] img',
      ];
      for (const sel of logoSelectors) {
        const el = document.querySelector(sel) as HTMLImageElement | null;
        if (el?.src) {
          logoUrl = el.src;
          break;
        }
      }

      // Favicon
      const faviconLink = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]') as HTMLLinkElement | null;
      const faviconUrl = faviconLink?.href || null;

      // Extract colors from computed styles of key elements
      const colorSet = new Set<string>();

      // Get colors from body, header, nav, buttons, links
      const colorElements = [
        document.body,
        document.querySelector('header'),
        document.querySelector('nav'),
        document.querySelector('.hero'),
        document.querySelector('[class*="hero"]'),
        ...Array.from(document.querySelectorAll('a, button, h1, h2')).slice(0, 10),
      ].filter(Boolean) as Element[];

      for (const el of colorElements) {
        const style = window.getComputedStyle(el);
        const bg = style.backgroundColor;
        const color = style.color;

        // Parse rgb/rgba to hex
        for (const c of [bg, color]) {
          const match = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (match) {
            const [, r, g, b] = match.map(Number);
            // Skip white, black, near-white, near-black, transparent
            if (r === 0 && g === 0 && b === 0) continue;
            if (r === 255 && g === 255 && b === 255) continue;
            if (r > 240 && g > 240 && b > 240) continue;
            if (r < 15 && g < 15 && b < 15) continue;
            const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
            colorSet.add(hex);
          }
        }
      }

      return {
        businessName,
        tagline: tagline.slice(0, 200),
        logoUrl,
        faviconUrl,
        colors: Array.from(colorSet).slice(0, 6),
      };
    });

    // Try to capture logo as base64
    let logoBase64: string | null = null;
    if (branding.logoUrl) {
      try {
        const logoResponse = await page.goto(branding.logoUrl, { timeout: 5000 });
        if (logoResponse) {
          const logoBuffer = await logoResponse.buffer();
          const contentType = logoResponse.headers()['content-type'] || 'image/png';
          logoBase64 = `data:${contentType};base64,${logoBuffer.toString('base64')}`;
        }
      } catch {
        // Logo fetch failed — we'll use text-based logo
        log.debug({ url: branding.logoUrl }, 'failed to fetch logo');
      }
    }

    log.info(
      { url, businessName: branding.businessName, colorsFound: branding.colors.length, hasLogo: !!logoBase64 },
      'website scraped successfully',
    );

    return {
      screenshot,
      colors: branding.colors,
      logoUrl: branding.logoUrl,
      logoBase64,
      businessName: branding.businessName,
      tagline: branding.tagline,
      faviconUrl: branding.faviconUrl,
    };
  } catch (err) {
    log.error({ err, url }, 'failed to scrape website');
    // Return empty branding — quote will use default styling
    return {
      screenshot: '',
      colors: [],
      logoUrl: null,
      logoBase64: null,
      businessName: '',
      tagline: '',
      faviconUrl: null,
    };
  } finally {
    await browser.close();
  }
}
