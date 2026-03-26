// --- Media side-channel: per-request to prevent cross-user leakage ---
const pendingMediaMap = new Map<string, Array<{ type: 'image' | 'voice' | 'document'; data: Buffer; filename?: string; mimetype?: string }>>();
let currentRequestId = 'default';

export function setCurrentRequestId(id: string) { currentRequestId = id; }

export function addPendingMedia(item: { type: 'image' | 'voice' | 'document'; data: Buffer; filename?: string; mimetype?: string }) {
  if (!pendingMediaMap.has(currentRequestId)) pendingMediaMap.set(currentRequestId, []);
  pendingMediaMap.get(currentRequestId)!.push(item);
}

export function collectMedia(requestId?: string): Array<{ type: 'image' | 'voice' | 'document'; data: Buffer; filename?: string; mimetype?: string }> {
  const id = requestId || currentRequestId;
  const media = pendingMediaMap.get(id) || [];
  pendingMediaMap.delete(id);
  return media;
}

// --- Interactive messages side-channel (buttons, lists, CTA) ---
export interface PendingInteractive {
  buttons?: Array<{ id: string; title: string }>;
  listSections?: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>;
  interactiveBody?: string;
  interactiveHeader?: string;
  interactiveFooter?: string;
  listButtonText?: string;
  ctaUrl?: { display_text: string; url: string };
}

const pendingInteractiveMap = new Map<string, PendingInteractive>();

export function addPendingInteractive(item: PendingInteractive) {
  pendingInteractiveMap.set(currentRequestId, item);
}

export function collectInteractive(requestId?: string): PendingInteractive | null {
  const id = requestId || currentRequestId;
  const item = pendingInteractiveMap.get(id) || null;
  pendingInteractiveMap.delete(id);
  return item;
}
