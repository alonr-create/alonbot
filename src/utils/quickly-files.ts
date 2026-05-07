import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('quickly-files');

const DEKEL_LEADS_BOARD_ID = 1443236269;
const FILES_COLUMN_ID = 'file_mm34mxvy'; // "קבצים מ-WhatsApp"
const PHONE_COLUMN_ID = 'phone';
const MONDAY_API = 'https://api.monday.com/v2';
const MONDAY_FILE_API = 'https://api.monday.com/v2/file';

export async function findDekelLeadByPhone(phone: string): Promise<string | null> {
  if (!config.mondayApiKey) return null;
  // Try multiple phone formats: 972XXX, +972XXX, 0XXX (local Israeli)
  const variants = new Set<string>();
  variants.add(phone);
  variants.add('+' + phone);
  if (phone.startsWith('972')) variants.add('0' + phone.slice(3));

  for (const v of variants) {
    const query = `query { items_page_by_column_values(board_id: ${DEKEL_LEADS_BOARD_ID}, columns: [{column_id: "${PHONE_COLUMN_ID}", column_values: ["${v}"]}], limit: 1) { items { id name } } }`;
    try {
      const res = await fetch(MONDAY_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: config.mondayApiKey },
        body: JSON.stringify({ query }),
      });
      const data = await res.json() as any;
      const item = data?.data?.items_page_by_column_values?.items?.[0];
      if (item?.id) {
        log.debug({ phone: v, itemId: item.id, name: item.name }, 'lead matched');
        return item.id;
      }
    } catch (e: any) {
      log.warn({ err: e.message, variant: v }, 'phone search failed');
    }
  }
  return null;
}

export async function uploadToFilesColumn(itemId: string, filename: string, content: Buffer, mimeType: string): Promise<string | null> {
  if (!config.mondayApiKey) return null;
  const query = `mutation ($file: File!) { add_file_to_column(item_id: ${itemId}, column_id: "${FILES_COLUMN_ID}", file: $file) { id } }`;
  const fd = new FormData();
  fd.append('query', query);
  fd.append('map', JSON.stringify({ image: 'variables.file' }));
  fd.append('image', new Blob([new Uint8Array(content)], { type: mimeType }), filename);
  try {
    const res = await fetch(MONDAY_FILE_API, {
      method: 'POST',
      headers: { Authorization: config.mondayApiKey },
      body: fd,
    });
    const data = await res.json() as any;
    if (data.errors) {
      log.error({ errors: data.errors, itemId, filename }, 'Monday upload failed');
      return null;
    }
    return data?.data?.add_file_to_column?.id ?? null;
  } catch (e: any) {
    log.error({ err: e.message, itemId, filename }, 'Monday upload threw');
    return null;
  }
}

interface QuicklyMediaInput {
  phone: string;
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

export async function handleQuicklyIncomingMedia(input: QuicklyMediaInput): Promise<void> {
  const itemId = await findDekelLeadByPhone(input.phone);
  if (!itemId) {
    log.info({ phone: input.phone, filename: input.filename }, 'no matching Dekel lead — skipping file upload');
    return;
  }
  const newAssetId = await uploadToFilesColumn(itemId, input.filename, input.buffer, input.mimeType);
  if (newAssetId) {
    log.info({ phone: input.phone, itemId, filename: input.filename, newAssetId }, 'WhatsApp media uploaded to Monday Files column');
  }
}
