# Video Downloader

Express API + BullMQ 큐 + yt-dlp 워커. 고화질 다운로드는 분리된 video/audio DASH 스트림을
받아 ffmpeg으로 병합합니다.

```
POST /api/jobs  ──▶  Redis (BullMQ)  ──▶  worker (yt-dlp + ffmpeg)  ──▶  local disk 또는 S3/R2
      │                                        │
      └── 202 { jobId }                        └── job.updateProgress()
                                                        │
GET /api/jobs/:id/events  ◀── SSE ◀── QueueEvents ◀──────┘
```

API 서버는 절대 블로킹되지 않습니다. 부하가 늘면 **워커만** 늘리세요.

## 실행

```bash
cp .env.example .env
docker compose up --build

# 워커만 스케일 아웃
docker compose up --scale worker=4
```

로컬 개발(Docker 없이)은 `redis-server`, `yt-dlp`, `ffmpeg`가 PATH에 있어야 합니다:

```bash
brew install redis yt-dlp ffmpeg
redis-server --daemonize yes
npm install
npm run worker &   # 별도 터미널
npm start          # http://localhost:3000
```

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` | `/api/jobs` | `{ url, quality }` → `202 { jobId }` |
| `GET` | `/api/jobs/:id` | 상태, 진행률, 완료 시 결과 |
| `GET` | `/api/jobs/:id/events` | SSE 진행률 스트림 |
| `GET` | `/api/jobs/:id/file` | 파일 다운로드 (S3면 presigned URL로 302) |
| `GET` | `/api/qualities` | 선택 가능한 화질 프리셋 |

## 화질 프리셋

`quality` 값은 화이트리스트입니다. 사용자가 yt-dlp 포맷 문자열을 직접 넣을 수 없습니다.

| 값 | 결과 |
|---|---|
| `best` | 최고 화질, AV1/opus 선호, mkv |
| `2160` / `1440` | 해상도 상한, mkv |
| `1080` / `720` | h264 + aac, mp4 (호환성 우선) |
| `audio` | m4a |

mkv는 코덱 조합 제약이 없어 병합 실패율이 낮습니다. mp4는 opus 오디오를 담지 못하므로
`1080`/`720` 프리셋은 오디오를 `m4a`로 고정합니다 — 그러지 않으면 ffmpeg이 조용히
재인코딩하면서 CPU를 태웁니다.

## YouTube가 실제로 동작하게 만들기 (2026)

세 가지 환경 변수가 성패를 가릅니다.

- **`POT_PROVIDER_URL`** — YouTube는 Proof-of-Origin 토큰을 요구합니다. 없으면 HTTP 403이
  뜨거나 화질이 조용히 낮아집니다. `docker-compose.yml`이 `bgutil` 서비스를 띄우고
  워커가 `http://bgutil:4416`을 바라보게 해둡니다.
- **`PROXY_URL`** — **가장 큰 함정.** Railway·AWS·GCP 같은 데이터센터 IP는 YouTube가 차단합니다.
  코드로 못 고칩니다. 주거용(residential) 프록시를 쓰거나 자택 회선에서 돌려야 합니다.
- **`COOKIES_FILE`** — 연령 제한·멤버십 전용 영상에 필요하고, rate limit도 완화됩니다.
  로그인한 브라우저에서 Netscape 형식으로 내보내세요.

TikTok·Vimeo·SoundCloud는 이런 방어가 없어 별도 설정 없이 동작합니다.

## 스토리지

`S3_BUCKET`이 비어 있으면 파일은 로컬 디스크에 남고 API가 직접 스트리밍합니다.
설정하면 워커가 업로드 후 로컬 사본을 지우고, `/file`은 presigned URL로 302 리다이렉트합니다.
S3 호환(R2, MinIO)은 `S3_ENDPOINT`로 지정하세요.

`RETENTION_MINUTES` 이후 워커의 스위퍼가 오래된 로컬 파일을 삭제합니다.

## 보안 관련 설계

- **호스트 화이트리스트** — yt-dlp는 넘겨준 URL을 그대로 가져오므로, 그대로 두면
  `http://169.254.169.254/` 같은 내부 주소로 SSRF가 됩니다. `src/validate.js`의 목록에
  있는 호스트만 워커에 도달합니다.
- **`--` 구분자** — `-`로 시작하는 URL이 yt-dlp 옵션으로 해석되지 않습니다.
- **`--ignore-config`** — 호스트의 `~/.config/yt-dlp`를 읽지 않아 어디서든 동일하게 동작합니다.
- **`shell: false`** — `spawn`에 배열 인자를 넘기므로 셸 인젝션 경로가 없습니다.
- 원격 서버가 준 제목은 `Content-Disposition`과 S3 키에 들어가기 전에 정리됩니다.

## 알려진 제약

- 진행률은 스트림 단위입니다. 1080p 이상은 video → audio 순으로 받으므로 퍼센트가 한 번
  리셋됩니다. UI는 `completed` 시점에 100%로 맞춥니다.
- `--max-filesize`는 포맷별로 적용되므로 병합 결과물이 상한을 넘을 수 있습니다.
- 재시도(`attempts: 2`)는 부분 파일을 남기지 않지만, 같은 영상을 처음부터 다시 받습니다.

## Railway 배포

Railway는 **서비스 간 볼륨 공유를 지원하지 않습니다.** api와 worker는 별개 컨테이너이므로
로컬 디스크 스토리지로는 `/api/jobs/:id/file`이 파일을 찾지 못합니다. Railway에서는
**S3/R2가 필수**입니다.

서비스 4개로 구성합니다.

| 서비스 | 소스 |
|---|---|
| `Redis` | Railway Redis 데이터베이스 |
| `bgutil` | 도커 이미지 `brainicism/bgutil-ytdlp-pot-provider` |
| `api` | 이 저장소 |
| `worker` | 이 저장소 (`ROLE=worker`) |

`api`와 `worker`는 같은 이미지·같은 `railway.json`을 씁니다. Railway는 저장소 루트의
`railway.json`을 그 저장소로 빌드하는 **모든** 서비스에 적용하므로, 서비스별 설정 파일을
따로 두는 대신 `src/start.js`가 `ROLE` 환경변수로 역할을 정합니다. `ROLE=worker`면 큐
컨슈머를 띄우고 헬스체크용 `/healthz`만 노출합니다.

### 환경 변수

`api`와 `worker` 공통:

```
REDIS_URL=${{Redis.REDIS_URL}}
S3_BUCKET=...
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_REGION=auto
```

`worker`만 추가:

```
ROLE=worker
POT_PROVIDER_URL=http://bgutil.railway.internal:4416
PROXY_URL=            # 아래 참고
```

`PORT`는 Railway가 주입하므로 직접 설정하지 마세요.

### 두 가지 함정

**IPv6.** Railway 사설망은 AAAA 레코드만 게시하는데 ioredis는 기본적으로 A 레코드만
조회합니다. `src/redis.js`가 `family: 0`(듀얼스택)으로 설정해 이를 피합니다. 지우지 마세요.

**데이터센터 IP.** Railway IP에서 YouTube는 높은 확률로 403을 반환합니다. `bgutil`로 PO 토큰을
붙여도 IP 평판 문제는 남습니다. TikTok·Vimeo·SoundCloud는 영향이 없습니다. YouTube가
필요하면 `PROXY_URL`에 주거용 프록시를 넣는 것이 사실상 유일한 해법입니다.

## 법적 고지

개인 백업, 본인이 올린 영상, CC 라이선스 콘텐츠에는 문제가 없습니다. YouTube 이용약관은
다운로드를 금지하며, 저작권 콘텐츠의 재배포는 별개의 법적 문제입니다. 공개 서비스로
운영할 계획이라면 먼저 정리하세요.
