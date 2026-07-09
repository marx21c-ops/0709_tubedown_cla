import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from './config.js';
import { QUALITY_PRESETS } from './validate.js';

const PROGRESS_PREFIX = '__PROG__';

// yt-dlp prints one line per progress tick when given --newline. We ask it to print
// exactly the four numbers we care about, pipe-delimited, so parsing stays trivial.
// `%(a,b)s` is yt-dlp's fallback syntax: use total_bytes, else total_bytes_estimate.
const PROGRESS_TEMPLATE = [
  `download:${PROGRESS_PREFIX}%(progress.downloaded_bytes)s`,
  '%(progress.total_bytes,progress.total_bytes_estimate)s',
  '%(progress.speed)s',
  '%(progress.eta)s',
].join('|');

const num = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

export function buildArgs({ url, jobId, quality, outDir }) {
  const preset = QUALITY_PRESETS[quality];
  const args = [
    // Never read the host's ~/.config/yt-dlp — the server must behave identically everywhere.
    '--ignore-config',
    '--no-colors',
    '--newline',
    '--no-playlist',
    '--restrict-filenames',
    '--retries',
    '5',
    '--fragment-retries',
    '10',
    '--socket-timeout',
    '30',
    // The single biggest speed win: pull DASH fragments in parallel.
    '--concurrent-fragments',
    String(config.concurrentFragments),
    '--max-filesize',
    `${config.maxFileSizeMb}M`,
    '--write-info-json',
    '--progress-template',
    PROGRESS_TEMPLATE,
    // yt-dlp renames the file after muxing; this records where it actually landed.
    '--print-to-file',
    'after_move:filepath',
    path.join(outDir, `${jobId}.path`),
    '-o',
    path.join(outDir, `${jobId}.%(ext)s`),
  ];

  if (preset.audioOnly) {
    args.push('-f', 'ba/b', '-x', '--audio-format', 'm4a');
  } else {
    args.push(
      '-f',
      preset.format,
      '-S',
      preset.sort,
      '--merge-output-format',
      preset.container,
    );
  }

  // Without a PO token provider, YouTube returns 403 or silently downgrades quality.
  if (config.potProviderUrl) {
    args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${config.potProviderUrl}`);
  }
  if (config.cookiesFile) {
    args.push('--cookies', config.cookiesFile);
  }
  // Datacenter IPs get blocked. A residential proxy is usually the only fix.
  if (config.proxyUrl) {
    args.push('--proxy', config.proxyUrl);
  }

  // `--` stops flag parsing, so a URL starting with `-` can never become an option.
  args.push('--', url);
  return args;
}

export function parseProgressLine(line) {
  if (!line.startsWith(PROGRESS_PREFIX)) return null;
  const [downloaded, total, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|');

  const downloadedBytes = num(downloaded);
  const totalBytes = num(total);

  return {
    downloadedBytes,
    totalBytes,
    speedBps: num(speed),
    etaSeconds: num(eta),
    percent:
      downloadedBytes !== null && totalBytes ? Math.min(100, (downloadedBytes / totalBytes) * 100) : null,
  };
}

export function runYtDlp({ args, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytDlpPath, args, {
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    const stderrTail = [];

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const progress = parseProgressLine(line.trim());
        if (progress) onProgress?.(progress);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrTail.push(chunk);
      if (stderrTail.length > 40) stderrTail.shift();
    });

    child.on('error', (err) =>
      reject(
        err.name === 'AbortError'
          ? err
          : new Error(`failed to spawn ${config.ytDlpPath}: ${err.message}`),
      ),
    );

    child.on('close', (code) => {
      if (code === 0) return resolve();
      const detail = stderrTail.join('').trim().split('\n').slice(-4).join(' | ');
      reject(new Error(`yt-dlp exited with code ${code}${detail ? `: ${detail}` : ''}`));
    });
  });
}
