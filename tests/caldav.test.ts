import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createCalDavHandler } from '../src/caldav/server'
import { sanitizeCalendar } from '../src/calendar/sanitize'
import { createOpaqueHash } from '../src/calendar/uid'
import { CalendarDatabase, publicEtag } from '../src/db/database'
import { PRIVATE_EVENT, TEST_SECRET, testConfig } from './helpers'

const config = testConfig()
const auth = `Basic ${Buffer.from(`${config.publicCalDavUsername}:${config.publicCalDavPassword}`).toString('base64')}`

describe('read-only CalDAV server', () => {
  let database: CalendarDatabase
  let handler: ReturnType<typeof createCalDavHandler>
  let publicId: string

  beforeEach(() => {
    database = new CalendarDatabase(':memory:')
    const sanitized = sanitizeCalendar(PRIVATE_EVENT, 'Busy', TEST_SECRET)
    const hrefHash = createOpaqueHash(TEST_SECRET, 'resource-href', 'https://source.example.test/private.ics')
    publicId = hrefHash
    database.applyFullSnapshot([{
      anonymousUid: sanitized.anonymousUid,
      endsAt: sanitized.endsAt,
      ical: sanitized.ical,
      publicEtag: publicEtag(sanitized.ical),
      publicId,
      sourceEtag: '"source-etag"',
      sourceHrefHash: hrefHash,
      sourceUidHash: sanitized.sourceUidHash,
      startsAt: sanitized.startsAt,
      updatedAt: '2026-08-20T12:00:00.000Z',
    }], new Set([hrefHash]), 'source-token', '2026-08-20T12:00:00.000Z')
    handler = createCalDavHandler(config, database)
  })

  afterEach(() => database.close())

  function request(path: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers)
    headers.set('authorization', auth)
    return new Request(`http://calendar.example.test${path}`, { ...init, headers })
  }

  test('requires authentication and protects status', async () => {
    expect((await handler(new Request('http://calendar.example.test/caldav/'))).status).toBe(401)
    expect((await handler(new Request('http://calendar.example.test/status'))).status).toBe(401)
    expect(await (await handler(new Request('http://calendar.example.test/health'))).json()).toEqual({ status: 'ok' })
    const status = await handler(request('/status'))
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({
      events: 1,
      lastSuccessfulSync: '2026-08-20T12:00:00.000Z',
      lastSyncAttempt: null,
    })
  })

  test('answers PROPFIND discovery with HTTPS forwarded URLs', async () => {
    const response = await handler(request('/caldav/', {
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
      headers: { 'depth': '1', 'x-forwarded-proto': 'https' },
      method: 'PROPFIND',
    }))
    const xml = await response.text()
    expect(response.status).toBe(207)
    expect(xml).toContain('https://calendar.example.test/caldav/principal/')
    expect(xml).toContain('calendar-home-set')
    expect(xml).toContain('supported-calendar-component-set')
    expect(xml).toContain('calendar-query')
  })

  test('answers calendar-query and calendar-multiget with sanitized data', async () => {
    const query = await handler(request('/caldav/calendar/', {
      body: '<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:D="DAV:"><D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter/></C:calendar-query>',
      method: 'REPORT',
    }))
    const queryXml = await query.text()
    expect(query.status).toBe(207)
    expect(queryXml).toContain('SUMMARY:Busy')
    expect(queryXml).not.toContain('Secret project')

    const multiget = await handler(request('/caldav/calendar/', {
      body: `<C:calendar-multiget xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:D="DAV:"><D:prop><D:getetag/><C:calendar-data/></D:prop><D:href>/caldav/calendar/${publicId}.ics</D:href></C:calendar-multiget>`,
      method: 'REPORT',
    }))
    expect(multiget.status).toBe(207)
    expect(await multiget.text()).toContain(`${publicId}.ics`)
  })

  test('serves event GET/HEAD and rejects all mutation methods', async () => {
    const path = `/caldav/calendar/${publicId}.ics`
    const get = await handler(request(path))
    expect(get.status).toBe(200)
    expect(get.headers.get('etag')).toMatch(/^"[a-f0-9]{64}"$/)
    expect(await get.text()).toContain('SUMMARY:Busy')

    const head = await handler(request(path, { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')

    for (const method of ['PUT', 'DELETE', 'POST', 'MKCOL', 'MKCALENDAR', 'MOVE', 'COPY'])
      expect((await handler(request(path, { method }))).status).toBe(403)
  })

  test('rejects malformed or entity-bearing XML', async () => {
    const malformed = await handler(request('/caldav/calendar/', { body: '<broken>', method: 'REPORT' }))
    expect(malformed.status).toBe(400)
    const entity = await handler(request('/caldav/calendar/', {
      body: '<!DOCTYPE x [<!ENTITY file SYSTEM "file:///etc/passwd">]><C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav">&file;</C:calendar-query>',
      method: 'REPORT',
    }))
    expect(entity.status).toBe(400)
  })
})
