import type { SourceCalendarClient, SourceResult } from '../src/caldav/client'
import { describe, expect, test } from 'bun:test'
import { createOpaqueHash } from '../src/calendar/uid'
import { CalendarDatabase } from '../src/db/database'
import { CalendarSync } from '../src/sync/sync'
import { PRIVATE_EVENT, TEST_SECRET, testConfig } from './helpers'

class FakeSource implements SourceCalendarClient {
  readonly #results: Array<SourceResult | Error>

  constructor(results: Array<SourceResult | Error>) {
    this.#results = [...results]
  }

  fetch = (): Promise<SourceResult> => {
    const result = this.#results.shift()
    if (!result)
      throw new Error('No fake result queued')
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
  }
}

function sourceObject(etag: string, data = PRIVATE_EVENT) {
  const href = 'https://source.example.test/work/private.ics'
  return {
    data,
    etag,
    href,
    hrefHash: createOpaqueHash(TEST_SECRET, 'resource-href', href),
  }
}

describe('calendar synchronization', () => {
  test('never overlaps synchronization runs', async () => {
    const database = new CalendarDatabase(':memory:')
    const object = sourceObject('"v1"')
    let release: ((value: SourceResult) => void) | undefined
    const source: SourceCalendarClient = {
      fetch: () => new Promise((resolve) => {
        release = resolve
      }),
    }
    const sync = new CalendarSync({ config: testConfig(), database, source })
    const firstRun = sync.run()
    await Promise.resolve()

    expect(await sync.run()).toMatchObject({ skipped: true })
    release?.({ mode: 'full', objects: [object], presentHashes: new Set([object.hrefHash]), syncToken: null })
    expect(await firstRun).toMatchObject({ success: true, created: 1 })
    database.close()
  })

  test('creates, updates, deletes, and keeps data when the source is unavailable', async () => {
    const database = new CalendarDatabase(':memory:')
    const original = sourceObject('"v1"')
    const updatedIcal = PRIVATE_EVENT.replace('DTEND:20260821T110000Z', 'DTEND:20260821T120000Z')
    const updated = sourceObject('"v2"', updatedIcal)
    const source = new FakeSource([
      { mode: 'full', objects: [original], presentHashes: new Set([original.hrefHash]), syncToken: 'token-1' },
      { mode: 'incremental', objects: [updated], deletedHashes: new Set(), syncToken: 'token-2' },
      new Error('source unavailable'),
      { mode: 'incremental', objects: [], deletedHashes: new Set([original.hrefHash]), syncToken: 'token-3' },
    ])
    const sync = new CalendarSync({ config: testConfig(), database, source })

    expect(await sync.run()).toMatchObject({ success: true, created: 1 })
    expect(database.countObjects()).toBe(1)
    expect(database.listObjects()[0]?.ical).not.toContain('Secret project')

    expect(await sync.run()).toMatchObject({ success: true, updated: 1 })
    expect(database.listObjects()[0]?.ical).toContain('DTEND:20260821T120000Z')

    const beforeFailure = database.listObjects()[0]?.ical
    expect(await sync.run()).toMatchObject({ success: false })
    expect(database.countObjects()).toBe(1)
    expect(database.listObjects()[0]?.ical).toBe(beforeFailure)
    expect(database.getSyncState().lastError).toBe('source synchronization failed')

    expect(await sync.run()).toMatchObject({ success: true, deleted: 1 })
    expect(database.countObjects()).toBe(0)
    database.close()
  })

  test('does not apply a partially malformed full snapshot', async () => {
    const database = new CalendarDatabase(':memory:')
    const valid = sourceObject('"v1"')
    const source = new FakeSource([
      { mode: 'full', objects: [valid], presentHashes: new Set([valid.hrefHash]), syncToken: null },
      {
        mode: 'full',
        objects: [{ ...valid, etag: '"v2"', data: 'not an icalendar' }],
        presentHashes: new Set([valid.hrefHash]),
        syncToken: null,
      },
    ])
    const sync = new CalendarSync({ config: testConfig(), database, source })
    await sync.run()
    const original = database.listObjects()[0]?.ical

    expect(await sync.run()).toMatchObject({ success: false })
    expect(database.listObjects()[0]?.ical).toBe(original)
    database.close()
  })
})
