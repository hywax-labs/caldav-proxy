import type { SourceCalendarClient, SourceCalendarObject } from '../caldav/client'
import type { AppConfig } from '../config'
import type { CalendarDatabase, StoredCalendarObject } from '../db/database'
import { sanitizeCalendar } from '../calendar/sanitize'
import { publicEtag } from '../db/database'
import { logger } from '../logger'

export interface SyncOutcome {
  success: boolean
  skipped: boolean
  fetched: number
  created: number
  updated: number
  deleted: number
}

export class CalendarSync {
  readonly #config: AppConfig
  readonly #database: CalendarDatabase
  readonly #source: SourceCalendarClient
  readonly #now: () => Date
  #idle: Promise<void> = Promise.resolve()
  #resolveIdle: (() => void) | null = null
  #running = false
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(options: {
    config: AppConfig
    database: CalendarDatabase
    source: SourceCalendarClient
    now?: () => Date
  }) {
    this.#config = options.config
    this.#database = options.database
    this.#source = options.source
    this.#now = options.now ?? (() => new Date())
  }

  start(): void {
    if (this.#timer)
      return
    this.#timer = setInterval(() => void this.run(), this.#config.syncIntervalSeconds * 1_000)
  }

  async stop(): Promise<void> {
    if (this.#timer)
      clearInterval(this.#timer)
    this.#timer = null
    await this.#idle
  }

  async run(): Promise<SyncOutcome> {
    if (this.#running)
      return { success: false, skipped: true, fetched: 0, created: 0, updated: 0, deleted: 0 }

    this.#running = true
    this.#idle = new Promise((resolve) => {
      this.#resolveIdle = resolve
    })
    const started = performance.now()
    const now = this.#now()
    const attemptAt = now.toISOString()
    this.#database.recordSyncAttempt(attemptAt)
    logger.info('sync started')

    try {
      const state = this.#database.getSyncState()
      const lastFull = state.lastFullSync ? Date.parse(state.lastFullSync) : 0
      const forceFull = !state.syncToken || !Number.isFinite(lastFull) || now.getTime() - lastFull >= 86_400_000
      const start = new Date(now.getTime() - this.#config.syncPastDays * 86_400_000)
      const end = new Date(now.getTime() + this.#config.syncFutureDays * 86_400_000)
      const result = await this.#source.fetch({
        start,
        end,
        knownEtags: this.#database.getSourceEtags(),
        syncToken: state.syncToken,
        forceFull,
      })

      const objects = result.objects.map(object => this.#sanitize(object, attemptAt))
      const counts = result.mode === 'full'
        ? this.#database.applyFullSnapshot(objects, result.presentHashes, result.syncToken, attemptAt)
        : this.#database.applyIncremental(objects, result.deletedHashes, result.syncToken, attemptAt)
      const fetched = result.objects.length
      const duration = Math.round(performance.now() - started)
      logger.info('events fetched', { fetched })
      logger.info('sync finished', { fetched, ...counts, durationMs: duration })
      return { success: true, skipped: false, fetched, ...counts }
    }
    catch {
      this.#database.recordSyncFailure('source synchronization failed')
      logger.error('sync failed', { durationMs: Math.round(performance.now() - started) })
      return { success: false, skipped: false, fetched: 0, created: 0, updated: 0, deleted: 0 }
    }
    finally {
      this.#running = false
      this.#resolveIdle?.()
      this.#resolveIdle = null
    }
  }

  #sanitize(source: SourceCalendarObject, updatedAt: string): StoredCalendarObject {
    const sanitized = sanitizeCalendar(source.data, this.#config.anonymousEventTitle, this.#config.uidSecret)
    return {
      sourceHrefHash: source.hrefHash,
      sourceUidHash: sanitized.sourceUidHash,
      publicId: source.hrefHash,
      anonymousUid: sanitized.anonymousUid,
      sourceEtag: source.etag,
      publicEtag: publicEtag(sanitized.ical),
      ical: sanitized.ical,
      startsAt: sanitized.startsAt,
      endsAt: sanitized.endsAt,
      updatedAt,
    }
  }
}
