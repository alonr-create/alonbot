import cron from 'node-cron';
import { db } from '../utils/db.js';

interface CronJob {
  id: number;
  name: string;
  cron_expr: string;
  channel: string;
  target_id: string;
  message: string;
  enabled: number;
}

type SendFn = (channel: string, targetId: string, text: string) => Promise<void>;

const activeTasks = new Map<number, ReturnType<typeof cron.schedule>>();
let currentSendFn: SendFn | null = null;

const stmtInsert = db.prepare(
  `INSERT INTO cron_jobs (name, cron_expr, channel, target_id, message) VALUES (?, ?, ?, ?, ?)`
);

const stmtAll = db.prepare(`SELECT * FROM cron_jobs WHERE enabled = 1`);

export function addCronJob(name: string, cronExpr: string, channel: string, targetId: string, message: string): number {
  const result = stmtInsert.run(name, cronExpr, channel, targetId, message);
  const id = result.lastInsertRowid as number;

  // Register at runtime so new cron jobs fire without restart
  if (currentSendFn && cron.validate(cronExpr)) {
    const task = cron.schedule(cronExpr, async () => {
      console.log(`[Cron] Firing: ${name}`);
      await currentSendFn!(channel, targetId, message);
    }, { timezone: 'Asia/Jerusalem' });
    activeTasks.set(id, task);
    console.log(`[Cron] Live-registered: "${name}" — ${cronExpr}`);
  }

  return id;
}

export function startAllCronJobs(sendFn: SendFn) {
  currentSendFn = sendFn;
  const jobs = stmtAll.all() as CronJob[];
  console.log(`[Cron] Loading ${jobs.length} jobs`);

  for (const job of jobs) {
    if (!cron.validate(job.cron_expr)) {
      console.warn(`[Cron] Invalid expression for "${job.name}": ${job.cron_expr}`);
      continue;
    }

    const task = cron.schedule(job.cron_expr, async () => {
      console.log(`[Cron] Firing: ${job.name}`);
      await sendFn(job.channel, job.target_id, job.message);
    }, { timezone: 'Asia/Jerusalem' });

    activeTasks.set(job.id, task);
    console.log(`[Cron] Scheduled: "${job.name}" — ${job.cron_expr}`);
  }
}

export function stopAllCronJobs() {
  for (const [, task] of activeTasks) {
    task.stop();
  }
  activeTasks.clear();
}
