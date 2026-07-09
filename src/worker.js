import fsp from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'bullmq';
import { QUEUE_NAME, config } from './config.js';
import { makeRedis } from './redis.js';
import { buildArgs, runYtDlp } from './ytdlp.js';
import { persist } from './storage.js';
import { safeFilename, validateQuality, validateUrl } from './validate.js';

const sidecars = (jobId) => [
  path.join(config.downloadDir, `${jobId}.path`),
  path.join(config.downloadDir, `${jobId}.info.json`),
];

async function cleanupSidecars(jobId) {
  await Promise.all(sidecars(jobId).map((f) => fsp.rm(f, { force: true })));
}

async function processJob(job) {
  // Re-validate inside the worker: a job could have been enqueued by anything.
  const url = validateUrl(job.data.url);
  const quality = validateQuality(job.data.quality);
  const jobId = job.id;

  await fsp.mkdir(config.downloadDir, { recursive: true });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.jobTimeoutMs);

  try {
    let lastPublished = 0;
    await runYtDlp({
      args: buildArgs({ url, jobId, quality, outDir: config.downloadDir }),
      signal: controller.signal,
      onProgress: (p) => {
        // yt-dlp emits ticks far faster than anyone needs; throttle Redis writes.
        const now = Date.now();
        if (now - lastPublished < 500) return;
        lastPublished = now;
        job.updateProgress(p).catch(() => {});
      },
    });

    const pathFile = path.join(config.downloadDir, `${jobId}.path`);
    const printed = (await fsp.readFile(pathFile, 'utf8')).trim().split('\n').filter(Boolean);
    const finalPath = printed.at(-1);
    if (!finalPath) throw new Error('yt-dlp finished but produced no output file');

    const info = JSON.parse(
      await fsp.readFile(path.join(config.downloadDir, `${jobId}.info.json`), 'utf8'),
    );
    const filename = safeFilename(info.title, path.extname(finalPath));

    const stored = await persist({ jobId, filePath: finalPath, filename });

    return {
      ...stored,
      title: info.title ?? null,
      durationSeconds: info.duration ?? null,
      extractor: info.extractor_key ?? null,
    };
  } finally {
    clearTimeout(timeout);
    await cleanupSidecars(jobId);
  }
}

const worker = new Worker(QUEUE_NAME, processJob, {
  connection: makeRedis(),
  concurrency: config.concurrency,
});

worker.on('failed', (job, err) => {
  console.error(`[worker] job ${job?.id} failed:`, err.message);
});
worker.on('completed', (job) => {
  console.log(`[worker] job ${job.id} completed`);
});

// Local files outlive their job entry unless something deletes them.
if (config.retentionMinutes > 0) {
  const sweepMs = 5 * 60 * 1000;
  setInterval(async () => {
    const cutoff = Date.now() - config.retentionMinutes * 60 * 1000;
    let entries;
    try {
      entries = await fsp.readdir(config.downloadDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(config.downloadDir, entry);
      try {
        const stat = await fsp.stat(full);
        if (stat.isFile() && stat.mtimeMs < cutoff) await fsp.rm(full, { force: true });
      } catch {
        /* raced with another sweep or a live download */
      }
    }
  }, sweepMs).unref();
}

const shutdown = async () => {
  await worker.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(`[worker] listening on "${QUEUE_NAME}" concurrency=${config.concurrency}`);
