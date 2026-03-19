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
