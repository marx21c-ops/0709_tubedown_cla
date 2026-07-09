import 'dotenv/config';
import path from 'node:path';

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export const QUEUE_NAME = 'downloads';

export const config = {
  port: int(process.env.PORT, 3000),
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',

  downloadDir: path.resolve(process.env.DOWNLOAD_DIR ?? './downloads'),
  ytDlpPath: process.env.YTDLP_PATH ?? 'yt-dlp',

  // Worker tuning.
  concurrency: int(process.env.WORKER_CONCURRENCY, 2),
  concurrentFragments: int(process.env.CONCURRENT_FRAGMENTS, 8),
  jobTimeoutMs: int(process.env.JOB_TIMEOUT_MS, 30 * 60 * 1000),
  maxFileSizeMb: int(process.env.MAX_FILESIZE_MB, 4096),

  // How long a finished file stays retrievable before the sweeper deletes it.
  retentionMinutes: int(process.env.RETENTION_MINUTES, 60),

  // YouTube in 2026 rejects plain requests. These three knobs are what make it work.
  potProviderUrl: process.env.POT_PROVIDER_URL ?? '',
  cookiesFile: process.env.COOKIES_FILE ?? '',
  proxyUrl: process.env.PROXY_URL ?? '',

  // Object storage. Leave S3_BUCKET empty to serve files straight off local disk.
  s3: {
    bucket: process.env.S3_BUCKET ?? '',
    region: process.env.S3_REGION ?? 'auto',
    endpoint: process.env.S3_ENDPOINT ?? '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    presignExpirySeconds: int(process.env.S3_PRESIGN_EXPIRY, 3600),
  },
};

export const useS3 = Boolean(config.s3.bucket);
