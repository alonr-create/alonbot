import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import type { MondayItem, LeadStatus } from './types.js';

const log = createLogger('monday-api');

/** Sanitize text for GraphQL string interpolation. */
function sanitizeGraphQL(text: string): string {
  return text.replace(/[\\"]/g, '').replace(/[{}()\[\]]/g, '').slice(0, 200);
}

/** Validate numeric ID to prevent injection. */
function validateId(id: number | string): number {
  const num = typeof id === 'string' ? parseInt(id, 10) : id;
  if (!Number.isFinite(num) || num < 0) throw new Error(`Invalid ID: ${id}`);
  return num;
}

// ── Helper: run a Monday.com GraphQL query ──
async function mondayQuery(query: string): Promise<any> {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: config.mondayApiToken,
    },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

/**
 * Fetch item data from Monday.com via GraphQL.
 * Extracts name, phone, and service interest from column values.
 */
export async function fetchMondayItem(itemId: number): Promise<MondayItem> {
  const safeId = validateId(itemId);
  const query = `query {
    items(ids: [${safeId}]) {
      name
      column_values {
        id
        text
      }
    }
  }`;

  const data = (await mondayQuery(query)) as {
    data: {
      items: Array<{
        name: string;
        column_values: Array<{ id: string; text: string }>;
      }>;
    };
  };

  const item = data.data.items[0];
  if (!item) {
    throw new Error(`Monday.com item ${itemId} not found`);
  }

  const columns = item.column_values;
  const phoneCol = columns.find(
    (c) => c.id.startsWith('phone') || c.id === 'טלפון',
  );
  const interestCol = columns.find(
    (c) => c.id.startsWith('dropdown') || c.id.startsWith('service') || c.id === 'שירות',
  );
  const sourceCol = columns.find(
    (c) => c.id.startsWith('source') || c.id === 'מקור' || c.id.startsWith('utm') || c.id.startsWith('campaign'),
  );

  return {
    name: item.name,
    phone: phoneCol?.text || '',
    interest: interestCol?.text || '',
    source: sourceCol?.text || '',
  };
}

/**
 * Update the status column of a Monday.com item.
 * Fire-and-forget: never throws (Monday status sync is non-critical).
 */
export async function updateMondayStatus(
  itemId: number,
  boardId: number,
  status: LeadStatus,
): Promise<void> {
  try {
    const safeItemId = validateId(itemId);
    const safeBoardId = validateId(boardId);
    const mutation = `mutation {
      change_simple_column_value(
        item_id: ${safeItemId},
        board_id: ${safeBoardId},
        column_id: "${sanitizeGraphQL(config.mondayStatusColumnId)}",
        value: "${sanitizeGraphQL(status)}"
      ) {
        id
      }
    }`;

    await mondayQuery(mutation);
  } catch (err) {
    log.error({ err, itemId, boardId, status }, 'Failed to update Monday.com status');
  }
}

// ── Get all configured board IDs ──
export interface BoardConfig {
  name: string;
  id: string;
}

export function getAllBoardIds(): BoardConfig[] {
  const boards: BoardConfig[] = [];
  if (config.mondayBoardId) {
    boards.push({ name: 'Alon.dev', id: config.mondayBoardId });
  }
  if (config.mondayBoardIdDprisha) {
    boards.push({ name: 'דקל לפרישה', id: config.mondayBoardIdDprisha });
  }
  return boards;
}

// ── Search items by text (name or phone) ──
export interface MondayBoardItem {
  id: string;
  name: string;
  group: { title: string };
  columns: Record<string, string>;
  updatesCount: number;
  boardName?: string;
  boardId?: string;
}

export async function searchBoardItems(searchText: string): Promise<MondayBoardItem[]> {
  const boards = getAllBoardIds();
  if (boards.length === 0) return [];

  const allItems: MondayBoardItem[] = [];

  for (const board of boards) {
    const safeBoardId = validateId(board.id);
    const safeSearch = sanitizeGraphQL(searchText);
    const query = `query {
      boards(ids: [${safeBoardId}]) {
        items_page(limit: 10, query_params: { rules: [{ column_id: "name", compare_value: ["${safeSearch}"] }], operator: any_of }) {
          items {
            id
            name
            group { title }
            column_values { id text }
            updates(limit: 1) { id }
          }
        }
      }
    }`;

    try {
      const data = await mondayQuery(query);
      const items = data?.data?.boards?.[0]?.items_page?.items || [];
      for (const item of items) {
        allItems.push({
          id: item.id,
          name: item.name,
          group: { title: item.group?.title || '' },
          columns: Object.fromEntries(
            (item.column_values || []).map((c: any) => [c.id, c.text || '']),
          ),
          updatesCount: item.updates?.length || 0,
          boardName: board.name,
          boardId: board.id,
        });
      }
    } catch (err) {
      log.error({ err, searchText, boardId: board.id }, 'Monday search failed');
    }
  }

  return allItems;
}

// ── Get all board items with status ──
export interface BoardStats {
  total: number;
  byStatus: Record<string, number>;
  byGroup: Record<string, number>;
  recentItems: Array<{ name: string; status: string; updated: string }>;
}

export async function getBoardStats(boardId?: string): Promise<BoardStats> {
  const targetBoardId = boardId || config.mondayBoardId;
  if (!targetBoardId) return { total: 0, byStatus: {}, byGroup: {}, recentItems: [] };

  const safeBoardId = validateId(targetBoardId);
  const query = `query {
    boards(ids: [${safeBoardId}]) {
      items_page(limit: 200) {
        items {
          id
          name
          group { title }
          column_values { id text }
          updated_at
        }
      }
    }
  }`;

  try {
    const data = await mondayQuery(query);
    const items = data?.data?.boards?.[0]?.items_page?.items || [];

    const byStatus: Record<string, number> = {};
    const byGroup: Record<string, number> = {};

    for (const item of items) {
      const statusCol = (item.column_values || []).find(
        (c: any) => c.id === config.mondayStatusColumnId || c.id === 'status',
      );
      const status = statusCol?.text || 'ללא סטטוס';
      byStatus[status] = (byStatus[status] || 0) + 1;

      const group = item.group?.title || 'ללא קבוצה';
      byGroup[group] = (byGroup[group] || 0) + 1;
    }

    // Sort by updated_at descending, take top 5
    const sorted = [...items].sort(
      (a: any, b: any) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
    const recentItems = sorted.slice(0, 5).map((item: any) => {
      const statusCol = (item.column_values || []).find(
        (c: any) => c.id === config.mondayStatusColumnId || c.id === 'status',
      );
      return {
        name: item.name,
        status: statusCol?.text || '',
        updated: item.updated_at,
      };
    });

    return { total: items.length, byStatus, byGroup, recentItems };
  } catch (err) {
    log.error({ err }, 'Failed to get board stats');
    return { total: 0, byStatus: {}, byGroup: {}, recentItems: [] };
  }
}

/** Get stats for ALL configured boards. */
export async function getAllBoardsStats(): Promise<Record<string, BoardStats>> {
  const boards = getAllBoardIds();
  const results: Record<string, BoardStats> = {};

  const statsPromises = boards.map(async (board) => {
    const stats = await getBoardStats(board.id);
    return { name: board.name, stats };
  });

  const settled = await Promise.allSettled(statsPromises);
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      results[r.value.name] = r.value.stats;
    }
  }

  return results;
}

// ── Add an update (note/comment) to a Monday.com item ──
export async function addItemUpdate(itemId: number, body: string): Promise<boolean> {
  try {
    const safeId = validateId(itemId);
    const escaped = body.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const mutation = `mutation {
      create_update(item_id: ${safeId}, body: "${escaped}") {
        id
      }
    }`;
    await mondayQuery(mutation);
    log.info({ itemId }, 'Update added to Monday.com item');
    return true;
  } catch (err) {
    log.error({ err, itemId }, 'Failed to add update to Monday.com');
    return false;
  }
}

// ── Create a new item on the board ──
export async function createBoardItem(
  name: string,
  columnValues?: Record<string, string>,
): Promise<{ id: string } | null> {
  const boardId = config.mondayBoardId;
  if (!boardId) return null;

  try {
    let colValuesStr = '';
    if (columnValues && Object.keys(columnValues).length > 0) {
      const escaped = JSON.stringify(JSON.stringify(columnValues));
      colValuesStr = `, column_values: ${escaped}`;
    }

    const safeBoardId = validateId(boardId);
    const mutation = `mutation {
      create_item(board_id: ${safeBoardId}, item_name: "${sanitizeGraphQL(name)}"${colValuesStr}) {
        id
      }
    }`;

    const data = await mondayQuery(mutation);
    const id = data?.data?.create_item?.id;
    if (id) {
      log.info({ id, name }, 'Created new Monday.com item');
      return { id };
    }
    return null;
  } catch (err) {
    log.error({ err, name }, 'Failed to create Monday.com item');
    return null;
  }
}

// ── Get updates (notes) for an item ──
export async function getItemUpdates(itemId: number, limit = 5): Promise<Array<{ text: string; createdAt: string }>> {
  try {
    const safeId = validateId(itemId);
    const safeLimit = Math.min(Math.max(1, limit), 50);
    const query = `query {
      items(ids: [${safeId}]) {
        updates(limit: ${safeLimit}) {
          text_body
          created_at
        }
      }
    }`;

    const data = await mondayQuery(query);
    const updates = data?.data?.items?.[0]?.updates || [];
    return updates.map((u: any) => ({
      text: u.text_body || '',
      createdAt: u.created_at || '',
    }));
  } catch (err) {
    log.error({ err, itemId }, 'Failed to get item updates');
    return [];
  }
}

// ── Move item to a different group ──
export async function moveItemToGroup(itemId: number, groupId: string): Promise<boolean> {
  try {
    const safeId = validateId(itemId);
    const mutation = `mutation {
      move_item_to_group(item_id: ${safeId}, group_id: "${sanitizeGraphQL(groupId)}") {
        id
      }
    }`;
    await mondayQuery(mutation);
    log.info({ itemId, groupId }, 'Item moved to group');
    return true;
  } catch (err) {
    log.error({ err, itemId, groupId }, 'Failed to move item');
    return false;
  }
}

// ── Get board groups ──
export async function getBoardGroups(): Promise<Array<{ id: string; title: string }>> {
  const boardId = config.mondayBoardId;
  if (!boardId) return [];

  try {
    const safeBoardId = validateId(boardId);
    const query = `query {
      boards(ids: [${safeBoardId}]) {
        groups {
          id
          title
        }
      }
    }`;

    const data = await mondayQuery(query);
    return data?.data?.boards?.[0]?.groups || [];
  } catch (err) {
    log.error({ err }, 'Failed to get board groups');
    return [];
  }
}

// ── Update any column value ──
export async function updateColumnValue(
  itemId: number,
  boardId: number,
  columnId: string,
  value: string,
): Promise<boolean> {
  try {
    const safeItemId = validateId(itemId);
    const safeBoardId = validateId(boardId);
    const mutation = `mutation {
      change_simple_column_value(
        item_id: ${safeItemId},
        board_id: ${safeBoardId},
        column_id: "${sanitizeGraphQL(columnId)}",
        value: "${sanitizeGraphQL(value)}"
      ) {
        id
      }
    }`;
    await mondayQuery(mutation);
    return true;
  } catch (err) {
    log.error({ err, itemId, columnId }, 'Failed to update column');
    return false;
  }
}

// ── Sync WhatsApp chat to Monday.com item as update ──
export async function syncChatToMonday(
  itemId: number,
  incomingMessages: string[],
  botResponse: string,
  leadName?: string,
): Promise<void> {
  try {
    const safeId = validateId(itemId);
    const timestamp = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    const incoming = incomingMessages.join('\n');
    const name = leadName || 'לקוח';

    const body = `💬 שיחת WhatsApp (${timestamp})\n\n📩 ${name}:\n${incoming}\n\n🤖 יעל:\n${botResponse}`;

    const escaped = body.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const mutation = `mutation {
      create_update(item_id: ${safeId}, body: "${escaped}") {
        id
      }
    }`;
    await mondayQuery(mutation);
    log.info({ itemId }, 'Chat synced to Monday.com');
  } catch (err) {
    log.error({ err, itemId }, 'Failed to sync chat to Monday.com');
  }
}

// ── Update item name on Monday.com ──
export async function updateItemName(
  boardId: number,
  itemId: number,
  name: string,
): Promise<boolean> {
  try {
    const safeItemId = validateId(itemId);
    const safeBoardId = validateId(boardId);
    const safeName = sanitizeGraphQL(name);
    const mutation = `mutation {
      change_simple_column_value(
        item_id: ${safeItemId},
        board_id: ${safeBoardId},
        column_id: "name",
        value: "${safeName}"
      ) {
        id
      }
    }`;
    await mondayQuery(mutation);
    log.info({ itemId, name }, 'Item name updated on Monday.com');
    return true;
  } catch (err) {
    log.error({ err, itemId, name }, 'Failed to update item name');
    return false;
  }
}

// ── Delete an item ──
export async function deleteItem(itemId: number): Promise<boolean> {
  try {
    const safeId = validateId(itemId);
    const mutation = `mutation {
      delete_item(item_id: ${safeId}) {
        id
      }
    }`;
    await mondayQuery(mutation);
    log.info({ itemId }, 'Item deleted from Monday.com');
    return true;
  } catch (err) {
    log.error({ err, itemId }, 'Failed to delete item');
    return false;
  }
}
