# AGENTS.md

This file applies to the entire repository. It is the operating guide for AI agents changing this project.

## Project purpose

This is a production-oriented, single-instance Bun + TypeScript service that creates a local, anonymized mirror of one external CalDAV calendar:

```text
Source CalDAV -> periodic one-way sync -> sanitizer -> SQLite -> read-only CalDAV
```

There is no UI and no transparent reverse proxy to the source calendar. Public calendar clients must only interact with sanitized ICS already stored in SQLite. The public calendar must remain available from the last successful snapshot when the source is unavailable.

## Non-negotiable security and privacy invariants

Treat these as correctness requirements, not optional hardening:

1. Sanitization is fail-closed. Build a new `VCALENDAR`/`VEVENT` from an allowlist; never copy an event and delete known private fields.
2. Never publish or persist the source UID. Public UIDs and resource IDs must remain deterministic HMAC-SHA256 values derived with `UID_SECRET`.
3. SQLite stores sanitized ICS only. Do not add raw source ICS, plaintext source hrefs, meeting content, email addresses, or credentials to the schema.
4. Never log ICS, Authorization headers, credentials, source event contents, source UIDs, summaries, descriptions, locations, attendees, or parser input. Avoid logging raw exception messages when a dependency could include request or calendar data in them.
5. Do not add any public endpoint or behavior that writes to the source calendar. The sync direction is always source to local mirror.
6. The public CalDAV collection is read-only. `PUT`, `POST`, `DELETE`, `MKCOL`, `MKCALENDAR`, `MOVE`, and `COPY` must remain explicitly rejected.
7. A failed or incomplete source fetch, malformed ICS object, or sanitization error must not delete or partially replace the last successful snapshot. Sanitize the complete change set before entering the database transaction.
8. Delete local data only after a successful full snapshot proves an object is absent or a successful incremental response explicitly reports its deletion.
9. Preserve Basic Auth on every sensitive endpoint, including `/status`. `/health` is intentionally unauthenticated and must not expose sync or calendar details.
10. Incoming XML must remain body-limited, must reject `DOCTYPE`/`ENTITY`, and must be parsed with entity processing disabled. Never introduce an XXE-capable parser configuration.
11. Preserve the single-sync concurrency guard. A slow sync must never overlap the next interval.
12. Graceful shutdown must wait for an active sync before closing SQLite.

If a requested change conflicts with one of these invariants, stop and explain the conflict rather than weakening the invariant silently.

## Calendar sanitization rules

The sanitizer is in `src/calendar/sanitize.ts`. Every source `VEVENT` receives:

- a generated anonymous `UID`;
- `SUMMARY` set to `ANONYMOUS_EVENT_TITLE` (`Busy` by default).

The event allowlist currently contains only:

- `DTSTART`;
- `DTEND` or `DURATION`;
- `RRULE`;
- `RDATE`;
- `EXDATE`;
- `RECURRENCE-ID`;
- `STATUS`;
- `TRANSP`;
- `SEQUENCE`;
- `DTSTAMP`.

Property parameters have their own narrow allowlists. Unknown parameters must not pass through. Preserve only referenced `VTIMEZONE` components, rebuilt from the minimal transition properties required by clients. Drop all unknown components, `VALARM`, private fields, participant data, URLs, attachments, conferences, and `X-*` metadata.

Recurring event correctness matters. A resource may contain a recurrence master plus overridden occurrences sharing the same anonymous UID. Preserve all-day `VALUE=DATE` semantics, timezone IDs, exclusions, additional dates, and recurrence IDs. Add regression tests before changing this logic.

## Repository map

```text
src/
  caldav/
    client.ts       Source CalDAV queries, ETag and sync-token behavior
    server.ts       Public Basic Auth read-only CalDAV handler
  calendar/
    sanitize.ts     Fail-closed ICS reconstruction
    uid.ts          Domain-separated HMAC identifiers
  db/
    database.ts     SQLite access and atomic snapshot/change application
    schema.ts       SQLite schema
  sync/
    sync.ts         Scheduling, concurrency guard, sanitization orchestration
  config.ts         Environment parsing and validation
  logger.ts         Structured privacy-safe logs
  server.ts         Bun HTTP server startup
  index.ts          Composition and graceful shutdown

tests/
  sanitize.test.ts  Privacy, UID, all-day, recurrence and override tests
  sync.test.ts      Concurrency and transactional sync behavior
  caldav.test.ts    Authentication and CalDAV integration tests
```

Keep modules small and preserve these boundaries. Do not move the application into a framework, ORM, queue, or external database. This is intentionally a small Bun utility using `bun:sqlite`.

## Source synchronization behavior

- `tsdav` is the CalDAV client library.
- Full synchronization uses a range-limited `calendar-query` for hrefs/ETags, then `calendar-multiget` only for new or changed resources.
- Use `sync-token`/`sync-collection` when supported.
- Fall back safely to a full query when incremental sync is unsupported or the token has expired.
- Run a full range refresh at least daily so events that age out of the configured window are pruned.
- Correctness is more important than request-count optimization.
- Do not expand recurring events during sync; preserve their recurrence model and overrides in sanitized ICS.
- Source timeouts and failures should produce a generic structured `sync failed` log and retain local data.

When altering sync behavior, explicitly test create, update, delete, source failure, malformed input, and overlapping runs.

## Public CalDAV behavior

Discovery starts at `/caldav/`, with the principal at `/caldav/principal/` and the calendar collection at `/caldav/calendar/`.

The supported subset includes:

- `OPTIONS`;
- `PROPFIND`;
- `REPORT calendar-query`;
- `REPORT calendar-multiget`;
- event `GET` and `HEAD`;
- ETags, calendar data, resource types, display names, principal discovery, `calendar-home-set`, supported reports, and the supported `VEVENT` component set.

Maintain compatibility with Apple Calendar/iOS/macOS Calendar first. Use `X-Forwarded-Proto` only when it is exactly `http` or `https` so generated absolute hrefs match the external TLS URL. Do not claim support for WebDAV/CalDAV features that are not implemented.

## Configuration

All runtime configuration comes from environment variables documented in `.env.example` and `README.md`. Do not add secrets to committed files or command-line examples.

Required secret-bearing values include source credentials, the public password, and `UID_SECRET`. `UID_SECRET` must remain at least 32 bytes. Changing it changes every public UID and resource ID.

When adding or changing configuration:

1. update `src/config.ts`;
2. update `.env.example` without real values;
3. update the environment table in `README.md`;
4. add validation tests when parsing behavior is non-trivial.

## Development commands

Use Bun for dependency management and all project scripts:

```bash
bun install --frozen-lockfile
bun run dev
bun test
bun run typecheck
bun run lint
docker build -t caldav-anonymous-mirror:test .
docker compose config --no-interpolate
```

Do not replace `bun.lock` with npm, pnpm, or Yarn lockfiles. Keep runtime dependencies minimal and verify any new CalDAV/iCalendar/XML dependency is maintained, ESM-compatible, and works in Bun without incompatible Node-only assumptions.

## Code conventions

- Use strict TypeScript and avoid `any`. Narrow `unknown` at network and parser boundaries.
- Use dependency injection where it makes sync and HTTP behavior testable.
- Prefer Web Platform APIs and Bun APIs. Bun-supported `node:` built-ins are acceptable when they provide a well-tested security primitive, such as HMAC or timing-safe comparison.
- Keep database writes atomic and use prepared statements.
- Preserve unknown external configuration only when relevant; never preserve unknown calendar properties.
- Return generic client-facing and logged errors. Detailed private upstream responses must not escape.
- Keep comments focused on security reasoning, protocol interoperability, or non-obvious invariants.
- Do not add UI, Redis, PostgreSQL, an ORM, message queues, or a server framework.

The repository uses ESLint with `@antfu/eslint-config`. Let ESLint fix mechanical formatting, but review semantic changes manually.

## Test requirements

Every behavior change must include proportionate tests. At minimum, privacy-sensitive sanitizer changes must prove forbidden values do not appear anywhere in the output ICS, not merely that property names were removed.

Before declaring work complete, run all of:

```bash
bun test
bun run typecheck
bun run lint
```

For Docker/runtime changes, also build the image. When practical, run it as the configured non-root user with a read-only root filesystem and verify `/health`. Report any check that could not be run and why.

## Docker and operations

The runtime image must remain non-root, listen on `0.0.0.0:${PORT}`, store SQLite under `/data`, expose a healthcheck, and handle SIGTERM. `compose.yaml` intentionally uses a read-only root filesystem, drops all capabilities, enables `no-new-privileges`, and gives write access only to `/data` and a small `/tmp` tmpfs.

TLS is external. Do not add nginx, Caddy, Traefik, certificates, or source-server proxying to this repository unless the user explicitly changes the deployment architecture.

## Completion checklist

Before handing off a change, confirm:

- privacy allowlists are still fail-closed;
- no raw source data or credentials are stored, logged, or returned;
- source failure preserves the previous calendar;
- public mutation methods remain forbidden;
- tests, typecheck, and lint pass;
- Docker/README/`.env.example` match runtime behavior when affected;
- the final response states exactly what was validated and any remaining operational limitation.
