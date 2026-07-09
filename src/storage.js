import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config, useS3 } from './config.js';

const CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
};

export const contentTypeFor = (ext) => CONTENT_TYPES[ext] ?? 'application/octet-stream';

let client;
function s3() {
  if (!client) {
    client = new S3Client({
      region: config.s3.region,
      forcePathStyle: config.s3.forcePathStyle,
      ...(config.s3.endpoint ? { endpoint: config.s3.endpoint } : {}),
      ...(config.s3.accessKeyId
        ? {
            credentials: {
              accessKeyId: config.s3.accessKeyId,
              secretAccessKey: config.s3.secretAccessKey,
            },
          }
        : {}),
    });
  }
  return client;
}

/**
 * Move a finished download to wherever it should live long-term.
 * With S3 configured the local copy is deleted; otherwise the file stays on disk
 * and the API streams it directly.
 */
export async function persist({ jobId, filePath, filename }) {
  const ext = path.extname(filePath);
  const { size } = await fsp.stat(filePath);

  if (!useS3) {
    return { storage: 'local', path: filePath, filename, bytes: size };
  }

  const key = `downloads/${jobId}${ext}`;
  await s3().send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentLength: size,
      ContentType: contentTypeFor(ext),
    }),
  );
  await fsp.rm(filePath, { force: true });

  return { storage: 's3', key, filename, bytes: size };
}

// Generated per request rather than at upload time, so a link never arrives expired.
export function presignedUrl({ key, filename }) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(filename);
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    }),
    { expiresIn: config.s3.presignExpirySeconds },
  );
}

export async function remove(result) {
  if (!result) return;
  if (result.storage === 's3') {
    await s3().send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: result.key }));
  } else if (result.storage === 'local') {
    await fsp.rm(result.path, { force: true });
  }
}
