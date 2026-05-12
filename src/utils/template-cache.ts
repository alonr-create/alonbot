import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('template-cache');

interface CacheEntry {
  fetchedAt: number;
  bodies: Map<string, string>;
}

let cache: CacheEntry | null = null;
const TTL_MS = 10 * 60 * 1000;
let inflight: Promise<Map<string, string>> | null = null;

async function fetchTemplatesFor(wabaId: string, token: string): Promise<any[]> {
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${wabaId}/message_templates?limit=200&fields=name,language,components,status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json() as any;
    return Array.isArray(data.data) ? data.data : [];
  } catch (e: any) {
    log.warn({ err: e.message, wabaId }, 'template fetch failed');
    return [];
  }
}

function extractBody(template: any): string {
  const components = template.components || [];
  const bodyComp = components.find((c: any) => c.type === 'BODY' || c.type === 'body');
  return bodyComp?.text || '';
}

async function refresh(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const sources = [
    { wabaId: config.waCloudWabaId || '1289908013100682', token: config.waCloudToken },
    { wabaId: '2465573403891833', token: config.waCloudToken2 },
  ];
  for (const s of sources) {
    if (!s.token) continue;
    const templates = await fetchTemplatesFor(s.wabaId, s.token);
    for (const t of templates) {
      const body = extractBody(t);
      if (body && t.name && !map.has(t.name)) map.set(t.name, body);
    }
  }
  log.info({ count: map.size }, 'template bodies cached');
  return map;
}

export async function getTemplateBodies(): Promise<Map<string, string>> {
  const now = Date.now();
  if (cache && (now - cache.fetchedAt) < TTL_MS) return cache.bodies;
  if (inflight) return inflight;
  inflight = refresh().then(bodies => {
    cache = { fetchedAt: Date.now(), bodies };
    inflight = null;
    return bodies;
  }).catch(e => {
    inflight = null;
    log.error({ err: e.message }, 'template refresh failed');
    return cache?.bodies || new Map<string, string>();
  });
  return inflight;
}

export function getTemplateBodiesSync(): Map<string, string> {
  return cache?.bodies || new Map<string, string>();
}

export function renderTemplate(name: string, params: string[]): string {
  const body = getTemplateBodiesSync().get(name);
  if (!body) return `[template:${name}] ${params.join(', ')}`;
  return body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? `{{${n}}}`);
}
