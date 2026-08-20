import type { AppConfig } from '../src/config'

export const TEST_SECRET = 'test-secret-that-is-at-least-thirty-two-bytes-long'

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    anonymousEventTitle: 'Busy',
    databasePath: ':memory:',
    port: 3000,
    publicCalDavPassword: 'public-password',
    publicCalDavUsername: 'calendar',
    sourceCalDavPassword: 'source-password',
    sourceCalDavUrl: 'https://source.example.test/dav/',
    sourceCalDavUsername: 'source-user',
    sourceCalendarUrl: 'https://source.example.test/dav/calendars/work/',
    syncFutureDays: 365,
    syncIntervalSeconds: 60,
    syncPastDays: 30,
    tlsCertPath: null,
    tlsKeyPath: null,
    uidSecret: TEST_SECRET,
    ...overrides,
  }
}

export const PRIVATE_EVENT = `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Source//EN\r
BEGIN:VEVENT\r
UID:source-secret-uid@example.com\r
DTSTAMP:20260820T100000Z\r
DTSTART:20260821T100000Z\r
DTEND:20260821T110000Z\r
SUMMARY:Secret project\r
DESCRIPTION:Internal information https://meet.example.com/private\r
LOCATION:Meeting room 123\r
GEO:40.0;-70.0\r
ORGANIZER:mailto:boss@example.com\r
ATTENDEE;CN=Alice:mailto:user@example.com\r
CONTACT:security@example.com\r
URL:https://internal.example.com\r
ATTACH:https://internal.example.com/document.pdf\r
COMMENT:Confidential\r
CONFERENCE:https://zoom.example.com/secret\r
X-COMPANY-SECRET:classified\r
IANA-UNKNOWN-PROPERTY:unknown-secret-value\r
BEGIN:VALARM\r
ACTION:DISPLAY\r
TRIGGER:-PT15M\r
DESCRIPTION:Reminder with secret\r
END:VALARM\r
END:VEVENT\r
END:VCALENDAR\r
`
