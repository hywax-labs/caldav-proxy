import ICAL from 'ical.js'
import { createAnonymousUid, createOpaqueHash } from './uid'

export interface SanitizedCalendar {
  ical: string
  anonymousUid: string
  sourceUidHash: string
  startsAt: string | null
  endsAt: string | null
}

const EVENT_PROPERTIES = new Set([
  'dtstart',
  'dtend',
  'duration',
  'rrule',
  'rdate',
  'exdate',
  'recurrence-id',
  'status',
  'transp',
  'sequence',
  'dtstamp',
])

const PROPERTY_PARAMETERS: Readonly<Record<string, ReadonlySet<string>>> = {
  'dtstart': new Set(['tzid', 'value']),
  'dtend': new Set(['tzid', 'value']),
  'duration': new Set(['value']),
  'rrule': new Set(['value']),
  'rdate': new Set(['tzid', 'value']),
  'exdate': new Set(['tzid', 'value']),
  'recurrence-id': new Set(['tzid', 'value', 'range']),
  'status': new Set(['value']),
  'transp': new Set(['value']),
  'sequence': new Set(['value']),
  'dtstamp': new Set(['value']),
}

const TIMEZONE_PROPERTIES: Readonly<Record<string, ReadonlySet<string>>> = {
  vtimezone: new Set(['tzid']),
  standard: new Set(['dtstart', 'tzoffsetfrom', 'tzoffsetto', 'rrule', 'rdate']),
  daylight: new Set(['dtstart', 'tzoffsetfrom', 'tzoffsetto', 'rrule', 'rdate']),
}

function copyProperty(property: ICAL.Property, allowedParameters: ReadonlySet<string>): ICAL.Property {
  const copy = new ICAL.Property(structuredClone(property.jCal))
  const parameters = copy.jCal[1]
  if (parameters && typeof parameters === 'object') {
    for (const name of Object.keys(parameters)) {
      if (!allowedParameters.has(name.toLowerCase()))
        copy.removeParameter(name)
    }
  }
  return copy
}

function sanitizeTimezone(source: ICAL.Component): ICAL.Component {
  const target = new ICAL.Component(source.name)
  const allowed = TIMEZONE_PROPERTIES[source.name] ?? new Set<string>()
  for (const property of source.getAllProperties()) {
    if (allowed.has(property.name))
      target.addProperty(copyProperty(property, PROPERTY_PARAMETERS[property.name] ?? new Set(['value'])))
  }
  if (source.name === 'vtimezone') {
    for (const child of source.getAllSubcomponents()) {
      if (child.name === 'standard' || child.name === 'daylight')
        target.addSubcomponent(sanitizeTimezone(child))
    }
  }
  return target
}

function safeDate(component: ICAL.Component, name: 'dtstart' | 'dtend'): string | null {
  try {
    const value = component.getFirstPropertyValue(name)
    if (value instanceof ICAL.Time)
      return value.toJSDate().toISOString()
  }
  catch {
    // The date bounds are optional metadata; the original property is still preserved verbatim.
  }
  return null
}

export function sanitizeCalendar(sourceIcal: string, title: string, uidSecret: string): SanitizedCalendar {
  if (sourceIcal.length > 5_000_000)
    throw new Error('Source calendar object exceeds the 5 MB safety limit')

  let source: ICAL.Component
  try {
    source = ICAL.Component.fromString(sourceIcal)
  }
  catch {
    throw new Error('Malformed iCalendar object')
  }
  if (source.name !== 'vcalendar')
    throw new Error('Expected a VCALENDAR component')

  const sourceEvents = source.getAllSubcomponents('vevent')
  if (sourceEvents.length === 0)
    throw new Error('Calendar object contains no VEVENT')

  const target = new ICAL.Component('vcalendar')
  target.addPropertyWithValue('version', '2.0')
  target.addPropertyWithValue('prodid', '-//caldav-anonymous-mirror//EN')
  const calScale = source.getFirstProperty('calscale')
  if (calScale)
    target.addProperty(copyProperty(calScale, new Set(['value'])))

  const referencedTimezones = new Set<string>()
  let firstAnonymousUid: string | null = null
  let firstSourceUidHash: string | null = null
  let startsAt: string | null = null
  let endsAt: string | null = null

  for (const sourceEvent of sourceEvents) {
    const sourceUidValue = sourceEvent.getFirstPropertyValue('uid')
    if (typeof sourceUidValue !== 'string' || sourceUidValue.length === 0)
      throw new Error('VEVENT is missing UID')
    if (!sourceEvent.hasProperty('dtstart'))
      throw new Error('VEVENT is missing DTSTART')

    const anonymousUid = createAnonymousUid(uidSecret, sourceUidValue)
    firstAnonymousUid ??= anonymousUid
    firstSourceUidHash ??= createOpaqueHash(uidSecret, 'source-uid', sourceUidValue)

    const targetEvent = new ICAL.Component('vevent')
    targetEvent.addPropertyWithValue('uid', anonymousUid)
    targetEvent.addPropertyWithValue('summary', title)

    for (const property of sourceEvent.getAllProperties()) {
      if (!EVENT_PROPERTIES.has(property.name))
        continue
      const tzid = property.getFirstParameter('tzid')
      if (tzid)
        referencedTimezones.add(tzid)
      targetEvent.addProperty(copyProperty(property, PROPERTY_PARAMETERS[property.name] ?? new Set()))
    }

    target.addSubcomponent(targetEvent)
    startsAt ??= safeDate(sourceEvent, 'dtstart')
    endsAt ??= safeDate(sourceEvent, 'dtend')
  }

  for (const timezone of source.getAllSubcomponents('vtimezone')) {
    const timezoneId = timezone.getFirstPropertyValue('tzid')
    if (typeof timezoneId === 'string' && referencedTimezones.has(timezoneId))
      target.addSubcomponent(sanitizeTimezone(timezone))
  }

  if (!firstAnonymousUid || !firstSourceUidHash)
    throw new Error('Calendar object contains no usable VEVENT')

  return {
    ical: target.toString(),
    anonymousUid: firstAnonymousUid,
    sourceUidHash: firstSourceUidHash,
    startsAt,
    endsAt,
  }
}
