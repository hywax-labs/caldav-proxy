import { describe, expect, test } from 'bun:test'
import { toDavRequestHref } from '../src/caldav/client'

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
})
