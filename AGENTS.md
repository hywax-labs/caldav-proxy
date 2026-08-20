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
  client.test.ts    Source-client DAV href compatibility tests
  config.test.ts    Environment and optional TLS validation tests
  sanitize.test.ts  Privacy, UID, all-day, recurrence and override tests
  sync.test.ts      Concurrency and transactional sync behavior
  caldav.test.ts    Authentication and CalDAV integration tests
```

Keep modules small and preserve these boundaries. Do not move the application into a framework, ORM, queue, or external database. This is intentionally a small Bun utility using `bun:sqlite`.

## Source synchronization behavior

- `tsdav` is the CalDAV client library.
- Full synchronization uses a range-limited `calendar-query` for hrefs/ETags, then `calendar-multiget` only for new or changed resources.
- Normalize every resource href sent in `calendar-multiget` to `pathname + search`. Do not send an absolute URL. Yandex CalDAV returns valid absolute/relative hrefs from `calendar-query` but responds with resource-level `404` when multiget contains absolute hrefs. Keep `toDavRequestHref()` and its regression test.
- Use `sync-token`/`sync-collection` when supported.
- Fall back safely to a full query when incremental sync is unsupported or the token has expired.
- Run a full range refresh at least daily so events that age out of the configured window are pruned.
- Correctness is more important than request-count optimization.
- Do not expand recurring events during sync; preserve their recurrence model and overrides in sanitized ICS.
- Source timeouts and failures should produce a generic structured `sync failed` log and retain local data.

When altering sync behavior, explicitly test create, update, delete, source failure, malformed input, and overlapping runs.

### Yandex CalDAV compatibility

- The account/principal URL and the concrete calendar collection URL are different resources.
- Do not assume the main collection is named `events-default`. Yandex accounts can expose opaque collection IDs. Obtain the exact collection href through principal -> `calendar-home-set` -> depth-1 `PROPFIND` discovery.
- `SOURCE_CALENDAR_URL` must match one discovered calendar collection, including its trailing slash.
- A top-level HTTP `207` can still contain failing resource-level statuses. Check parsed DAV response statuses without logging hrefs or response bodies.
- Diagnostic output must never print Yandex credentials, raw XML, calendar names, event hrefs, or ICS. Counts, operation names, and HTTP status codes are sufficient.

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

Modern macOS Calendar refuses to answer a Basic Auth challenge over plain HTTP, even if the account UI allows disabling SSL. It surfaces this transport rejection as "unable to verify account name or password." Therefore:

- a successful HTTP `curl` authentication check does not prove Apple Calendar compatibility;
- Apple Calendar tests require trusted HTTPS;
- production should continue to use the external HTTPS reverse proxy;
- trusted localhost tests may enable Bun TLS with `TLS_CERT_PATH` and `TLS_KEY_PATH` and a locally trusted `mkcert` certificate;
- never recommend `curl -k`/`--insecure` as validation because Apple also validates certificate trust;
- prefer `127.0.0.1` over `localhost` when another process may own the IPv6 loopback port; include both names and `::1` in local test certificates.

## Configuration

All runtime configuration comes from environment variables documented in `.env.example` and `README.md`. Do not add secrets to committed files or command-line examples.

Required secret-bearing values include source credentials, the public password, and `UID_SECRET`. `UID_SECRET` must remain at least 32 bytes. Changing it changes every public UID and resource ID.

`TLS_CERT_PATH` and `TLS_KEY_PATH` are optional but must be configured together. They contain paths, not PEM contents. The private key is sensitive: keep `.certs/` ignored, do not print it, do not copy it into the Docker build context, and never commit it.

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
bun test tests
bun run typecheck
bun run lint
bun run lint:fix
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
bun test tests
bun run typecheck
bun run lint
```

The authoritative suite lives under `tests/`. Do not name ad-hoc discovery or network diagnostics `*_test.ts` or `*.test.ts`, because Bun will collect them as tests. Such diagnostics must remain read-only, redact private values, and live under a clearly named `scripts/` location if they need to be retained.

For Docker/runtime changes, also build the image. When practical, run it as the configured non-root user with a read-only root filesystem and verify `/health`. Report any check that could not be run and why.

## Docker and operations

The runtime image must remain non-root, listen on `0.0.0.0:${PORT}`, store SQLite under `/data`, expose a healthcheck, and handle SIGTERM. `compose.yaml` intentionally uses a read-only root filesystem, drops all capabilities, enables `no-new-privileges`, and gives write access only to `/data` and a small `/tmp` tmpfs.

Production TLS is external. Do not add nginx, Caddy, Traefik, certificates, or source-server proxying to the production container unless the user explicitly changes the deployment architecture. Direct Bun TLS is supported only as an optional trusted-local-testing path through `TLS_CERT_PATH` and `TLS_KEY_PATH`; Docker/Compose defaults must remain plain HTTP behind the reverse proxy.

For a local Apple Calendar smoke test, the expected sequence is:

1. create a trusted certificate for `localhost`, `127.0.0.1`, and `::1` with `mkcert`;
2. configure an unused local port (the documented example is `3443`) and both TLS paths;
3. restart the process and confirm the structured `server started` log has `tls=true`;
4. verify `curl https://127.0.0.1:<port>/health` without `-k`;
5. add an Advanced CalDAV account using the public credentials, server `127.0.0.1`, path `/caldav/`, that port, and SSL enabled.

## Completion checklist

Before handing off a change, confirm:

- privacy allowlists are still fail-closed;
- no raw source data or credentials are stored, logged, or returned;
- source failure preserves the previous calendar;
- public mutation methods remain forbidden;
- tests, typecheck, and lint pass;
- Docker/README/`.env.example` match runtime behavior when affected;
- the final response states exactly what was validated and any remaining operational limitation.
