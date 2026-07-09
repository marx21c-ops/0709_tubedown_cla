export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// yt-dlp will happily fetch whatever you hand it, including http://169.254.169.254/
// and other internal addresses. Only hosts on this list ever reach the worker.
const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'youtu.be',
  'm.youtube.com',
  'music.youtube.com',
  'tiktok.com',
  'vm.tiktok.com',
  'vt.tiktok.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'vimeo.com',
  'soundcloud.com',
  'reddit.com',
  'twitch.tv',
]);

export function validateUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) {
    throw new BadRequest('url must be a string under 2048 characters');
  }

  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new BadRequest('url is not a valid URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequest('url must be http or https');
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!ALLOWED_HOSTS.has(host)) {
    throw new BadRequest(`host "${host}" is not supported`);
  }

  return parsed.toString();
}

// User input never becomes a raw yt-dlp format string. They pick a key, we own the value.
//
// Two things worth knowing about these:
//   - `bv*+ba` downloads separate video and audio streams and hands them to ffmpeg.
//     That is the only way to get anything above 720p out of YouTube.
//   - mkv accepts any codec pair. mp4 cannot hold opus audio, so the mp4 presets pin
//     audio to m4a — otherwise ffmpeg silently re-encodes and burns CPU.
export const QUALITY_PRESETS = {
  best: {
    label: 'Best available (up to 8K, mkv)',
    format: 'bv*+ba/b',
    sort: 'res,fps,hdr,vcodec:av01,acodec:opus',
    container: 'mkv',
  },
  '2160': {
    label: '4K (mkv)',
    format: 'bv*[height<=2160]+ba/b[height<=2160]',
    sort: 'res,fps,vcodec:av01,acodec:opus',
    container: 'mkv',
  },
  '1440': {
    label: '1440p (mkv)',
    format: 'bv*[height<=1440]+ba/b[height<=1440]',
    sort: 'res,fps,vcodec:av01,acodec:opus',
    container: 'mkv',
  },
  '1080': {
    label: '1080p (mp4, most compatible)',
    format: 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]',
    sort: 'res,fps,vcodec:h264',
    container: 'mp4',
  },
  '720': {
    label: '720p (mp4)',
    format: 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]',
    sort: 'res,fps,vcodec:h264',
    container: 'mp4',
  },
  audio: {
    label: 'Audio only (m4a)',
    audioOnly: true,
    container: 'm4a',
  },
};

export function validateQuality(raw) {
  const key = raw ?? 'best';
  if (!Object.hasOwn(QUALITY_PRESETS, key)) {
    throw new BadRequest(`quality must be one of: ${Object.keys(QUALITY_PRESETS).join(', ')}`);
  }
  return key;
}

// Titles arrive from a remote server and end up in a Content-Disposition header
// and (for S3) an object key. Strip anything that could escape either.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const PATH_CHARS = /[\\/:*?"<>|]/g;

export function safeFilename(title, ext) {
  const cleaned = (title ?? 'video')
    .replace(CONTROL_CHARS, '')
    .replace(PATH_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${cleaned || 'video'}${ext}`;
}
