import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { QueueEvents } from 'bullmq';
import { QUEUE_NAME, config } from './config.js';
import { makeRedis } from './redis.js';
import { downloadQueue } from './queue.js';
import { presignedUrl } from './storage.js';
import { BadRequest, QUALITY_PRESETS, validateQuality, validateUrl } from './validate.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));
app.use(express.static(publicDir));

const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many downloads requested, try again later' },
});

// ---------------------------------------------------------------------------
// Progress fan-out. One QueueEvents instance for the whole process; each SSE
// client registers against a jobId. Events cross the process boundary via Redis,
// so this works no matter which worker actually ran the job.
// ---------------------------------------------------------------------------
const queueEvents = new QueueEvents(QUEUE_NAME, { connection: makeRedis() });
const listeners = new Map();

function emit(jobId, event, data) {
  const set = listeners.get(jobId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(payload);
}

queueEvents.on('progress', ({ jobId, data }) => emit(jobId, 'progress', data));
queueEvents.on('completed', ({ jobId }) => emit(jobId, 'completed', { jobId }));
queueEvents.on('failed', ({ jobId, failedReason }) => emit(jobId, 'failed', { error: failedReason }));

// ---------------------------------------------------------------------------

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/api/qualities', (_req, res) => {
  res.json(
    Object.entries(QUALITY_PRESETS).map(([value, preset]) => ({ value, label: preset.label })),
  );
});

app.post('/api/jobs', submitLimiter, async (req, res, next) => {
  try {
    const url = validateUrl(req.body?.url);
    const quality = validateQuality(req.body?.quality);
    const job = await downloadQueue.add('download', { url, quality });
    res.status(202).json({ jobId: job.id, state: 'queued' });
  } catch (err) {
    next(err);
  }
});

app.get('/api/jobs/:id', async (req, res, next) => {
  try {
    const job = await downloadQueue.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });

    const state = await job.getState();
    res.json({
      jobId: job.id,
      state,
      progress: job.progress || null,
      error: job.failedReason ?? null,
      result:
        state === 'completed' && job.returnvalue
          ? {
              title: job.returnvalue.title,
              filename: job.returnvalue.filename,
              bytes: job.returnvalue.bytes,
              durationSeconds: job.returnvalue.durationSeconds,
              downloadUrl: `/api/jobs/${job.id}/file`,
            }
          : null,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/jobs/:id/events', async (req, res, next) => {
  try {
    const job = await downloadQueue.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('\n');

    const jobId = req.params.id;
    if (!listeners.has(jobId)) listeners.set(jobId, new Set());
    listeners.get(jobId).add(res);

    // A job can finish before the client subscribes; replay terminal state.
    const state = await job.getState();
    if (state === 'completed') emit(jobId, 'completed', { jobId });
    if (state === 'failed') emit(jobId, 'failed', { error: job.failedReason });

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      const set = listeners.get(jobId);
      set?.delete(res);
      if (set?.size === 0) listeners.delete(jobId);
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/jobs/:id/file', async (req, res, next) => {
  try {
    const job = await downloadQueue.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });

    const result = job.returnvalue;
    if ((await job.getState()) !== 'completed' || !result) {
      return res.status(409).json({ error: 'job is not finished' });
    }

    if (result.storage === 's3') {
      return res.redirect(302, await presignedUrl(result));
    }

    // Belt and braces: the path came from our own worker, but never serve
    // anything that resolves outside the download directory.
    const resolved = path.resolve(result.path);
    if (!resolved.startsWith(config.downloadDir + path.sep)) {
      return res.status(500).json({ error: 'refusing to serve path outside download directory' });
    }
    return res.download(resolved, result.filename);
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof BadRequest) return res.status(err.status).json({ error: err.message });
  console.error('[api]', err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(config.port, () => {
  console.log(`[api] listening on :${config.port}`);
});
