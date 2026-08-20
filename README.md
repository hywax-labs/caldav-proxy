# Anonymous CalDAV Mirror

A small, one-way CalDAV mirror written in Bun and strict TypeScript. It periodically reads a work calendar, creates a privacy-preserving local copy in SQLite, and exposes that copy as a Basic-Auth-protected, read-only CalDAV calendar.

The public endpoint is never a transparent proxy. Calendar clients only read already-sanitized data from SQLite, so they continue to work while the source server is unavailable.

## Architecture

```text
Source CalDAV -- periodic sync --> sanitizer --> SQLite (sanitized ICS only)
                                                  |
                                                  v
                                      read-only CalDAV server
                                                  |
                                                  v
                                      Apple/other calendar client
```

Each source calendar object is parsed with `ical.js` and rebuilt from a strict allowlist. Original ICS, source URLs, and source UIDs are not stored. Resource and event identifiers are HMAC-SHA256 values derived with `UID_SECRET`.

The sync client uses `tsdav` 2.x. A full `calendar-query` first fetches only hrefs and ETags, followed by `calendar-multiget` for new or changed objects. If the server exposes a WebDAV `sync-token`, subsequent runs use `sync-collection`. A full range refresh runs at least daily to prune events that have aged out of the configured window. Any fetch, parse, or sanitization failure leaves the previous SQLite snapshot untouched.

## Setup

Requirements: Docker with the Compose plugin and a source CalDAV account/app password with read access to the selected calendar.

```bash
cp .env.example .env
# edit .env and provide all required values
docker compose up -d
```

The checked-in `data/` directory is used for SQLite persistence. The image runs as the non-root `bun` user (UID 1000). If that UID cannot write the bind mount on your VPS, fix the host directory once:

```bash
sudo chown -R 1000:1000 ./data
```

Check startup and synchronization without exposing credentials:

```bash
docker compose ps
docker compose logs -f caldav-proxy
curl http://127.0.0.1:3000/health
```

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SOURCE_CALDAV_URL` | yes | — | CalDAV account/server endpoint. Validated for explicit configuration; `SOURCE_CALENDAR_URL` is the only endpoint queried for event data. |
| `SOURCE_CALDAV_USERNAME` | yes | — | Source account username. |
| `SOURCE_CALDAV_PASSWORD` | yes | — | Source password or app-specific password. |
| `SOURCE_CALENDAR_URL` | yes | — | Exact source calendar collection URL, normally ending in `/`. |
| `PUBLIC_CALDAV_USERNAME` | yes | `calendar` in the example | Username given to public calendar clients. |
| `PUBLIC_CALDAV_PASSWORD` | yes | — | Strong password given to public calendar clients. |
| `UID_SECRET` | yes | — | Secret of at least 32 bytes used for HMAC identifiers. Keep it stable or public event UIDs will change. Generate with `openssl rand -hex 32`. |
| `ANONYMOUS_EVENT_TITLE` | yes | `Busy` | The only summary published for every event. |
| `SYNC_INTERVAL` | no | `60` | Synchronization interval in seconds. Overlapping runs are skipped. |
| `SYNC_PAST_DAYS` | no | `30` | Past portion of the full synchronization window. |
| `SYNC_FUTURE_DAYS` | no | `365` | Future portion of the full synchronization window. |
| `DATABASE_PATH` | yes | `/data/database.sqlite` | SQLite database path. |
| `PORT` | no | `3000` | HTTP listen port. The server binds to `0.0.0.0`. |
| `TLS_CERT_PATH` | no | — | Optional TLS certificate path for direct HTTPS, primarily for trusted local testing. Must be set together with `TLS_KEY_PATH`. |
| `TLS_KEY_PATH` | no | — | Optional TLS private-key path. Never commit this file. Production normally terminates TLS at the reverse proxy. |

Empty values for required variables are rejected at startup. Credentials, Authorization headers, ICS, meeting fields, and parser input are never written to application logs.

## Connecting a calendar client

Publish the service through your HTTPS reverse proxy, then add this CalDAV account URL:

```text
https://calendar.example.com/caldav/
```

Use `PUBLIC_CALDAV_USERNAME` and `PUBLIC_CALDAV_PASSWORD`, not the source credentials. Discovery exposes a principal at `/caldav/principal/` and a single calendar collection at `/caldav/calendar/`.

The implemented compatibility subset includes:

- `OPTIONS`, `PROPFIND`, `REPORT`, `GET`, and `HEAD`;
- `calendar-query` and `calendar-multiget`;
- principal discovery, `calendar-home-set`, `resourcetype`, `displayname`, ETags, calendar data, supported reports, and the supported `VEVENT` component set.

`PUT`, `POST`, `DELETE`, `MKCOL`, `MKCALENDAR`, `MOVE`, and `COPY` always return `403 Forbidden`. The server has no code path that writes to the source calendar.

## Reverse proxy and TLS

The application serves plain HTTP. Terminate TLS in your existing nginx, Caddy, Traefik, or other reverse proxy and forward traffic to port 3000. Forward the original protocol so absolute WebDAV hrefs use HTTPS:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Do not expose source CalDAV credentials or source endpoints in reverse-proxy configuration. Only this application's port should be reachable by calendar clients. If the reverse proxy shares a host with Docker, binding the published port to `127.0.0.1:3000:3000` in `compose.yaml` is an additional useful restriction.

## Privacy and failure behavior

The sanitizer publishes only `DTSTART`, `DTEND` or `DURATION`, `RRULE`, `RDATE`, `EXDATE`, `RECURRENCE-ID`, `STATUS`, `TRANSP`, `SEQUENCE`, `DTSTAMP`, the required timezone definitions, a generated UID, and the configured title. It strips private parameters from otherwise allowed properties.

Everything else is discarded by construction, including original summaries and UIDs, descriptions, locations, people, email addresses, organizers, attendees, URLs, attachments, conference links, comments, alarms, arbitrary subcomponents, and `X-*` metadata. A malformed object aborts the complete sync transaction instead of publishing an uncertain partial result.

If the source is unavailable, `/health`, `/status`, and CalDAV continue serving the last successful snapshot. Local deletions happen only after a successful full snapshot proves an object is absent or a successful incremental response explicitly reports its deletion.

Incoming XML is limited to 1 MiB. `DOCTYPE` and `ENTITY` declarations are rejected before parsing, entity processing is disabled, and Bun also enforces the request-body limit at the HTTP server.

## HTTP endpoints

- `GET /health` — unauthenticated liveness response: `{"status":"ok"}`.
- `GET /status` — Basic Auth required; returns only sync timestamps and event count.
- `/caldav/` — Basic Auth required; CalDAV discovery root.

Health indicates that the process and local server are available. Source sync status is intentionally separate and available through authenticated `/status` and structured logs.

## Local development

Install Bun 1.3.14 or newer, copy `.env.example`, then run:

```bash
bun install --frozen-lockfile
bun run dev
```

### Trusted local HTTPS for Apple Calendar

Recent macOS Calendar versions refuse to answer a Basic Auth challenge over plain HTTP, even when the account UI allows disabling SSL. For a local Calendar test, create a certificate trusted by macOS using `mkcert`:

```bash
mkdir -p .certs
mkcert -install
mkcert \
  -cert-file .certs/localhost.pem \
  -key-file .certs/localhost-key.pem \
  localhost 127.0.0.1 ::1
```

Set these local `.env` values (port `3443` avoids common development-server conflicts):

```env
PORT=3443
TLS_CERT_PATH=.certs/localhost.pem
TLS_KEY_PATH=.certs/localhost-key.pem
```

Restart the service and verify the trusted HTTPS endpoint:

```bash
bun run start
curl https://127.0.0.1:3443/health
```

In Calendar choose **Other CalDAV Account**, account type **Advanced**, then enter the public username/password, server `127.0.0.1`, server path `/caldav/`, port `3443`, and enable SSL. Do not use `-k`/`--insecure`: Apple Calendar also requires the certificate to be trusted.

Quality checks:

```bash
bun test
bun run typecheck
bun run lint
docker build -t caldav-anonymous-mirror .
```

The test suite covers fail-closed anonymization, HMAC UID stability, all-day and recurring events with exceptions/overrides, transactional create/update/delete/error sync behavior, authentication, `PROPFIND`, both CalDAV reports, event GET/HEAD, mutation rejection, and malicious/malformed XML.

## Operational notes

- Back up `/data/database.sqlite` and its SQLite WAL files as one consistent set, or use SQLite's online backup tooling.
- Keep `.env` readable only by the deployment account and never commit it.
- Rotating `PUBLIC_CALDAV_PASSWORD` only requires updating clients. Rotating `UID_SECRET` changes every public UID and should be treated as creating a new mirror identity.
- This is a deliberately minimal single-instance server. Do not run multiple replicas against the same SQLite file.
