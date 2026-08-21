import { describe, expect, test } from 'bun:test'
import { toDavRequestHref, TsdavSourceClient } from '../src/caldav/client'
import { testConfig } from './helpers'

const EMPTY_MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" />`

describe('source CalDAV client', () => {
  test('uses pathname hrefs for calendar-multiget compatibility', () => {
    const base = 'https://caldav.example.test/calendars/user/work/'

    expect(toDavRequestHref(
      'https://caldav.example.test/calendars/user/work/event.ics?version=1',
      base,
    )).toBe('/calendars/user/work/event.ics?version=1')

    expect(toDavRequestHref(
      '/calendars/user/work/event.ics',
      base,
    )).toBe('/calendars/user/work/event.ics')
  })

  test('creates a fresh timeout signal for later synchronization runs', async () => {
    const signals: AbortSignal[] = []
    const request = Object.assign(async (_input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => {
      const signal = init?.signal
      if (!(signal instanceof AbortSignal))
        throw new Error('Expected an AbortSignal')
      if (signal.aborted)
        throw signal.reason
      signals.push(signal)
      return new Response(EMPTY_MULTISTATUS, {
        headers: { 'content-type': 'application/xml; charset=utf-8' },
        status: 207,
      })
    }, { preconnect: globalThis.fetch.preconnect })
    const client = new TsdavSourceClient(testConfig(), {
      fetch: request,
      requestTimeoutMs: 100,
    })
    const fetchOptions = {
      end: new Date('2026-08-22T00:00:00.000Z'),
      forceFull: true,
      knownEtags: new Map<string, string | null>(),
      start: new Date('2026-08-20T00:00:00.000Z'),
      syncToken: null,
    }

    expect((await client.fetch(fetchOptions)).mode).toBe('full')
    await Bun.sleep(150)
    expect((await client.fetch(fetchOptions)).mode).toBe('full')
    expect(signals).toHaveLength(4)
    expect(new Set(signals).size).toBe(4)
  })
})
