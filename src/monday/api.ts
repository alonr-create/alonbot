import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import type { MondayItem, LeadStatus } from './types.js';

const log = createLogger('monday-api');

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

  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: config.mondayApiToken,
    },
    body: JSON.stringify({ query }),
  });

  const data = (await res.json()) as {
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
    (c) => c.id === 'phone' || c.id === 'phone_number' || c.id === 'טלפון',
  );
  const interestCol = columns.find(
    (c) =>
      c.id === 'service' ||
      c.id === 'interest' ||
      c.id === 'שירות' ||
      c.id === 'text',
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

    await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: config.mondayApiToken,
      },
      body: JSON.stringify({ query: mutation }),
    });
  } catch (err) {
    log.error({ err, itemId, boardId, status }, 'Failed to update Monday.com status');
  }
}
