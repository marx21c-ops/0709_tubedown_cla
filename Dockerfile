FROM node:24-bookworm-slim

# ffmpeg is not optional: every resolution above 720p arrives as separate
# video and audio streams that must be muxed.
# yt-dlp goes in via pip (not the standalone binary) so that plugins such as
# the PO token provider can be installed alongside it.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages \
      yt-dlp \
      bgutil-ytdlp-pot-provider \
    && apt-get purge -y python3-pip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

RUN mkdir -p /app/downloads && chown -R node:node /app/downloads
USER node

ENV NODE_ENV=production \
    DOWNLOAD_DIR=/app/downloads

EXPOSE 3000
CMD ["node", "src/server.js"]
