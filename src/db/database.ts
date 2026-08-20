import { createHash } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { SCHEMA } from './schema'

export interface StoredCalendarObject {
  sourceHrefHash: string
  sourceUidHash: string
  publicId: string
  anonymousUid: string
  sourceEtag: string | null
  publicEtag: string
  ical: string
  startsAt: string | null
  endsAt: string | null
  updatedAt: string
}

export interface SyncState {
  lastSuccessfulSync: string | null
  lastSyncAttempt: string | null
  lastError: string | null
  syncToken: string | null
  lastFullSync: string | null
}

interface ObjectRow {
  source_href_hash: string
  source_uid_hash: string
  public_id: string
  anonymous_uid: string
  source_etag: string | null
  public_etag: string
  ical: string
  starts_at: string | null
  ends_at: string | null
  updated_at: string
}

interface StateRow {
  last_successful_sync: string | null
  last_sync_attempt: string | null
  last_error: string | null
  sync_token: string | null
  last_full_sync: string | null
}

function mapObject(row: ObjectRow): StoredCalendarObject {
  return {
    sourceHrefHash: row.source_href_hash,
    sourceUidHash: row.source_uid_hash,
    publicId: row.public_id,
    anonymousUid: row.anonymous_uid,
    sourceEtag: row.source_etag,
    publicEtag: row.public_etag,
    ical: row.ical,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    updatedAt: row.updated_at,
  }
}

export function publicEtag(ical: string): string {
  return `"${createHash('sha256').update(ical).digest('hex')}"`
}

export class CalendarDatabase {
  readonly #db: Database

  constructor(path: string) {
    this.#db = new Database(path, { create: true, strict: true })
    this.#db.exec(SCHEMA)
  }

  close(): void {
    this.#db.close(false)
  }

  recordSyncAttempt(at: string): void {
    this.#db.query('UPDATE sync_state SET last_sync_attempt = ? WHERE id = 1').run(at)
  }

  recordSyncFailure(message: string): void {
    this.#db.query('UPDATE sync_state SET last_error = ? WHERE id = 1').run(message)
  }

  getSyncState(): SyncState {
    const row = this.#db.query<StateRow, []>(`
      SELECT last_successful_sync, last_sync_attempt, last_error, sync_token, last_full_sync
      FROM sync_state WHERE id = 1
    `).get()
    if (!row)
      throw new Error('sync_state row is missing')
    return {
      lastSuccessfulSync: row.last_successful_sync,
      lastSyncAttempt: row.last_sync_attempt,
      lastError: row.last_error,
      syncToken: row.sync_token,
      lastFullSync: row.last_full_sync,
    }
  }

  countObjects(): number {
    return this.#db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM calendar_objects').get()?.count ?? 0
  }

  listObjects(): StoredCalendarObject[] {
    return this.#db.query<ObjectRow, []>('SELECT * FROM calendar_objects ORDER BY public_id').all().map(mapObject)
  }

  getObject(publicId: string): StoredCalendarObject | null {
    const row = this.#db.query<ObjectRow, [string]>('SELECT * FROM calendar_objects WHERE public_id = ?').get(publicId)
    return row ? mapObject(row) : null
  }

  getSourceEtags(): Map<string, string | null> {
    return new Map(
      this.#db.query<{ source_href_hash: string, source_etag: string | null }, []>(
        'SELECT source_href_hash, source_etag FROM calendar_objects',
      ).all().map(row => [row.source_href_hash, row.source_etag]),
    )
  }

  applyFullSnapshot(objects: StoredCalendarObject[], presentHashes: Set<string>, syncToken: string | null, at: string): { created: number, updated: number, deleted: number } {
    return this.#db.transaction(() => {
      const counts = this.#upsert(objects)
      let deleted = 0
      const existing = this.#db.query<{ source_href_hash: string }, []>('SELECT source_href_hash FROM calendar_objects').all()
      const remove = this.#db.query('DELETE FROM calendar_objects WHERE source_href_hash = ?')
      for (const row of existing) {
        if (!presentHashes.has(row.source_href_hash)) {
          deleted += remove.run(row.source_href_hash).changes
        }
      }
      this.#recordSuccess(syncToken, at, at)
      return { ...counts, deleted }
    })()
  }

  applyIncremental(objects: StoredCalendarObject[], deletedHashes: Set<string>, syncToken: string, at: string): { created: number, updated: number, deleted: number } {
    return this.#db.transaction(() => {
      const counts = this.#upsert(objects)
      let deleted = 0
      const remove = this.#db.query('DELETE FROM calendar_objects WHERE source_href_hash = ?')
      for (const hash of deletedHashes)
        deleted += remove.run(hash).changes
      this.#recordSuccess(syncToken, at, null)
      return { ...counts, deleted }
    })()
  }

  #recordSuccess(syncToken: string | null, at: string, fullAt: string | null): void {
    this.#db.query(`
      UPDATE sync_state
      SET last_successful_sync = ?, last_error = NULL, sync_token = ?,
          last_full_sync = COALESCE(?, last_full_sync)
      WHERE id = 1
    `).run(at, syncToken, fullAt)
  }

  #upsert(objects: StoredCalendarObject[]): { created: number, updated: number } {
    const current = this.#db.query<{ source_etag: string | null, public_etag: string }, [string]>(
      'SELECT source_etag, public_etag FROM calendar_objects WHERE source_href_hash = ?',
    )
    const upsert = this.#db.query(`
      INSERT INTO calendar_objects (
        source_href_hash, source_uid_hash, public_id, anonymous_uid, source_etag,
        public_etag, ical, starts_at, ends_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_href_hash) DO UPDATE SET
        source_uid_hash = excluded.source_uid_hash,
        public_id = excluded.public_id,
        anonymous_uid = excluded.anonymous_uid,
        source_etag = excluded.source_etag,
        public_etag = excluded.public_etag,
        ical = excluded.ical,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        updated_at = excluded.updated_at
    `)
    let created = 0
    let updated = 0
    for (const object of objects) {
      const previous = current.get(object.sourceHrefHash)
      if (!previous)
        created++
      else if (previous.source_etag !== object.sourceEtag || previous.public_etag !== object.publicEtag)
        updated++
      upsert.run(
        object.sourceHrefHash,
        object.sourceUidHash,
        object.publicId,
        object.anonymousUid,
        object.sourceEtag,
        object.publicEtag,
        object.ical,
        object.startsAt,
        object.endsAt,
        object.updatedAt,
      )
    }
    return { created, updated }
  }
}
