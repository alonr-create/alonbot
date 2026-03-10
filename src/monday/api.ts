import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import type { MondayItem, LeadStatus } from './types.js';

const log = createLogger('monday-api');

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
  const query = `query {
    items(ids: [${itemId}]) {
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

  return {
    name: item.name,
    phone: phoneCol?.text || '',
    interest: interestCol?.text || '',
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
    const mutation = `mutation {
      change_simple_column_value(
        item_id: ${itemId},
        board_id: ${boardId},
        column_id: "${config.mondayStatusColumnId}",
        value: "${status}"
      ) {
        id
      }
    }`;

    await mondayQuery(mutation);
  } catch (err) {
    log.error({ err, itemId, boardId, status }, 'Failed to update Monday.com status');
  }
}

// ── Search items by text (name or phone) ──
export interface MondayBoardItem {
  id: string;
  name: string;
  group: { title: string };
  columns: Record<string, string>;
  updatesCount: number;
}

export async function searchBoardItems(searchText: string): Promise<MondayBoardItem[]> {
  const boardId = config.mondayBoardId;
  if (!boardId) return [];

  const query = `query {
    boards(ids: [${boardId}]) {
      items_page(limit: 10, query_params: { rules: [{ column_id: "name", compare_value: ["${searchText.replace(/"/g, '\\"')}"] }], operator: any_of }) {
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
    return items.map((item: any) => ({
      id: item.id,
      name: item.name,
      group: { title: item.group?.title || '' },
      columns: Object.fromEntries(
        (item.column_values || []).map((c: any) => [c.id, c.text || '']),
      ),
      updatesCount: item.updates?.length || 0,
    }));
  } catch (err) {
    log.error({ err, searchText }, 'Monday search failed');
    return [];
  }
}

// ── Get all board items with status ──
export interface BoardStats {
  total: number;
  byStatus: Record<string, number>;
  byGroup: Record<string, number>;
  recentItems: Array<{ name: string; status: string; updated: string }>;
}

export async function getBoardStats(): Promise<BoardStats> {
  const boardId = config.mondayBoardId;
  if (!boardId) return { total: 0, byStatus: {}, byGroup: {}, recentItems: [] };

  const query = `query {
    boards(ids: [${boardId}]) {
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

// ── Add an update (note/comment) to a Monday.com item ──
export async function addItemUpdate(itemId: number, body: string): Promise<boolean> {
  try {
    const escaped = body.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const mutation = `mutation {
      create_update(item_id: ${itemId}, body: "${escaped}") {
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

    const mutation = `mutation {
      create_item(board_id: ${boardId}, item_name: "${name.replace(/"/g, '\\"')}"${colValuesStr}) {
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
    const query = `query {
      items(ids: [${itemId}]) {
        updates(limit: ${limit}) {
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
    const mutation = `mutation {
      move_item_to_group(item_id: ${itemId}, group_id: "${groupId}") {
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
    const query = `query {
      boards(ids: [${boardId}]) {
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
    const mutation = `mutation {
      change_simple_column_value(
        item_id: ${itemId},
        board_id: ${boardId},
        column_id: "${columnId}",
        value: "${value.replace(/"/g, '\\"')}"
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

// ── Delete an item ──
export async function deleteItem(itemId: number): Promise<boolean> {
  try {
    const mutation = `mutation {
      delete_item(item_id: ${itemId}) {
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
