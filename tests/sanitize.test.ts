import { describe, expect, test } from 'bun:test'
import ICAL from 'ical.js'
import { sanitizeCalendar } from '../src/calendar/sanitize'
import { createAnonymousUid } from '../src/calendar/uid'
import { PRIVATE_EVENT, TEST_SECRET } from './helpers'

describe('calendar anonymization', () => {
  test('uses a fail-closed allowlist for private event data', () => {
    const result = sanitizeCalendar(PRIVATE_EVENT, 'Busy', TEST_SECRET)
    const forbidden = [
      'Secret project',
      'Internal information',
      'Meeting room 123',
      'boss@example.com',
      'user@example.com',
      'internal.example.com',
      'zoom.example.com',
      'source-secret-uid',
      'X-COMPANY-SECRET',
      'unknown-secret-value',
      'VALARM',
      'ATTACH',
      'ORGANIZER',
      'ATTENDEE',
      'LOCATION',
      'DESCRIPTION',
      'CONFERENCE',
    ]
    for (const value of forbidden)
      expect(result.ical.toUpperCase()).not.toContain(value.toUpperCase())

    expect(result.ical).toContain('SUMMARY:Busy')
    expect(result.ical).toContain('DTSTART:20260821T100000Z')
    expect(result.ical).toContain('DTEND:20260821T110000Z')
  })

  test('keeps recurrence rules, exclusions, and overridden occurrences', () => {
    const source = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:weekly-private-id\r
DTSTAMP:20260801T000000Z\r
DTSTART;TZID=Europe/Berlin:20260803T100000\r
DTEND;TZID=Europe/Berlin:20260803T110000\r
RRULE:FREQ=WEEKLY;COUNT=10\r
EXDATE;TZID=Europe/Berlin:20260817T100000\r
RDATE;TZID=Europe/Berlin:20260818T100000\r
SUMMARY:Private master\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:weekly-private-id\r
DTSTAMP:20260802T000000Z\r
RECURRENCE-ID;TZID=Europe/Berlin:20260810T100000\r
DTSTART;TZID=Europe/Berlin:20260810T120000\r
DTEND;TZID=Europe/Berlin:20260810T130000\r
SUMMARY:Private override\r
END:VEVENT\r
END:VCALENDAR\r
`
    const result = sanitizeCalendar(source, 'Busy', TEST_SECRET)
    const calendar = ICAL.Component.fromString(result.ical)
    const events = calendar.getAllSubcomponents('vevent')

    expect(events).toHaveLength(2)
    expect(result.ical).toContain('RRULE:FREQ=WEEKLY;COUNT=10')
    expect(result.ical).toContain('EXDATE;TZID=Europe/Berlin:20260817T100000')
    expect(result.ical).toContain('RDATE;TZID=Europe/Berlin:20260818T100000')
    expect(result.ical).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20260810T100000')
    expect(events[0]?.getFirstPropertyValue('uid')).toBe(events[1]?.getFirstPropertyValue('uid'))
    expect(result.ical).not.toContain('Private')
  })

  test('preserves all-day value semantics and strips private parameters', () => {
    const source = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:all-day\r
DTSTAMP:20260801T000000Z\r
DTSTART;VALUE=DATE;X-PRIVATE=secret:20260820\r
DTEND;VALUE=DATE:20260821\r
SUMMARY:Holiday details\r
END:VEVENT\r
END:VCALENDAR\r
`
    const result = sanitizeCalendar(source, 'Busy', TEST_SECRET)
    expect(result.ical).toContain('DTSTART;VALUE=DATE:20260820')
    expect(result.ical).toContain('DTEND;VALUE=DATE:20260821')
    expect(result.ical).not.toContain('X-PRIVATE')
  })
})

describe('anonymous UID', () => {
  test('is deterministic, distinct, and irreversible in output', () => {
    const first = createAnonymousUid(TEST_SECRET, 'private-source-uid')
    expect(createAnonymousUid(TEST_SECRET, 'private-source-uid')).toBe(first)
    expect(createAnonymousUid(TEST_SECRET, 'different-source-uid')).not.toBe(first)
    expect(first).not.toContain('private-source-uid')
  })
})
