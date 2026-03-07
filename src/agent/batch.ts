import Anthropic from '@anthropic-ai/sdk';
import { config } from '../utils/config.js';
import { db } from '../utils/db.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('batch');
const client = new Anthropic({ apiKey: config.anthropicApiKey });

interface BatchJobRow {
  id: number;
  batch_id: string;
  job_type: string;
  payload: string;
  status: string;
  result: string | null;
  created_at: string;
  completed_at: string | null;
}

// --- Prepared Statements ---

const stmtInsert = db.prepare(
  `INSERT INTO batch_jobs (batch_id, job_type, payload, status) VALUES (?, ?, ?, 'processing')`
);

const stmtGetPending = db.prepare(
  `SELECT * FROM batch_jobs WHERE status = 'processing'`
);

const stmtComplete = db.prepare(
  `UPDATE batch_jobs SET status = 'completed', result = ?, completed_at = datetime('now') WHERE batch_id = ?`
);

const stmtFail = db.prepare(
  `UPDATE batch_jobs SET status = 'failed', result = ?, completed_at = datetime('now') WHERE batch_id = ?`
);

// --- Submit ---

export async function submitBatch(
  jobType: string,
  requests: Array<{ custom_id: string; params: Anthropic.MessageCreateParamsNonStreaming }>,
  payload?: Record<string, any>
): Promise<string | null> {
  try {
    const batch = await client.messages.batches.create({
      requests: requests.map(r => ({
        custom_id: r.custom_id,
        params: r.params,
      })),
    });

    stmtInsert.run(batch.id, jobType, JSON.stringify(payload || {}));
    log.info({ batchId: batch.id, jobType, requestCount: requests.length }, 'batch submitted');
    return batch.id;
  } catch (err: any) {
    log.error({ err: err.message }, 'batch submit failed');
    return null;
  }
}

// --- Poll & Process ---

export async function pollBatches(): Promise<number> {
  const pending = stmtGetPending.all() as BatchJobRow[];
  if (pending.length === 0) return 0;

  let processed = 0;
  for (const job of pending) {
    try {
      const batch = await client.messages.batches.retrieve(job.batch_id);

      if (batch.processing_status === 'ended') {
        // Collect all results
        const results: Array<{ custom_id: string; text: string }> = [];
        const resultsStream = await client.messages.batches.results(job.batch_id);
        for await (const result of resultsStream) {
          if (result.result.type === 'succeeded') {
            const textBlocks = result.result.message.content.filter(
              (b: any): b is Anthropic.TextBlock => b.type === 'text'
            );
            results.push({
              custom_id: result.custom_id,
              text: textBlocks.map((b: any) => b.text).join('\n'),
            });
          }
        }

        // Process results based on job type
        await processResults(job.job_type, JSON.parse(job.payload), results);
        stmtComplete.run(JSON.stringify(results.map(r => r.custom_id)), job.batch_id);
        processed++;
        log.info({ batchId: job.batch_id, resultCount: results.length }, 'batch completed');

        // Log savings (batch = 50% off)
        const counts = batch.request_counts;
        log.info({ succeeded: counts.succeeded, errored: counts.errored, expired: counts.expired }, 'batch stats');
      } else if (batch.processing_status === 'canceling') {
        stmtFail.run('Cancelled', job.batch_id);
        processed++;
      }
      // 'in_progress' → do nothing, check again later
    } catch (err: any) {
      log.error({ batchId: job.batch_id, err: err.message }, 'batch poll error');
      // If batch not found, mark as failed
      if (err.status === 404) {
        stmtFail.run('Batch not found', job.batch_id);
        processed++;
      }
    }
  }

  return processed;
}

// --- Process Results by Type ---

async function processResults(
  jobType: string,
  payload: Record<string, any>,
  results: Array<{ custom_id: string; text: string }>
) {
  switch (jobType) {
    case 'summarize': {
      // payload: { channel, senderId, fromDate, toDate, messageCount }
      const { saveSummary } = await import('./memory.js');
      for (const r of results) {
        const summaryMatch = r.text.match(/סיכום:\s*(.+?)(?:\n|$)/);
        const topicsMatch = r.text.match(/נושאים:\s*(\[.+?\])/);
        const summary = summaryMatch?.[1]?.trim() || r.text.slice(0, 500);
        let topics: string[] = [];
        try { topics = topicsMatch ? JSON.parse(topicsMatch[1]) : []; } catch { /* malformed JSON topics */ }
        saveSummary(
          payload.channel, payload.senderId,
          summary, topics,
          payload.messageCount,
          payload.fromDate, payload.toDate
        );
        log.info({ channel: payload.channel, senderId: payload.senderId }, 'saved summary');
      }
      break;
    }
    default:
      log.info({ jobType }, 'unknown job type, results stored');
  }
}

// --- Helper: Submit Summarization as Batch ---

export async function submitSummarizeBatch(
  channel: string, senderId: string,
  conversationText: string,
  fromDate: string, toDate: string, messageCount: number
): Promise<string | null> {
  return submitBatch('summarize', [{
    custom_id: `summarize-${channel}-${senderId}-${Date.now()}`,
    params: {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: 'אתה מסכם שיחות. תן סיכום קצר (3-5 משפטים) של השיחה, וציין נושאים עיקריים כ-JSON array.',
      messages: [{
        role: 'user',
        content: `סכם את השיחה הבאה:\n\n${conversationText.slice(0, 8000)}\n\nהחזר בפורמט:\nסיכום: [הסיכום]\nנושאים: ["נושא1", "נושא2"]`,
      }],
    },
  }], { channel, senderId, fromDate, toDate, messageCount });
}
