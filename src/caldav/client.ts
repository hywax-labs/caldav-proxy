import type { DAVResponse } from 'tsdav'
import type { AppConfig } from '../config'
import { Buffer } from 'node:buffer'
import { calendarMultiGet, calendarQuery, propfind, syncCollection } from 'tsdav'
import { createOpaqueHash } from '../calendar/uid'

export interface SourceCalendarObject {
  hrefHash: string
  href: string
  etag: string | null
  data: string
}

export interface SourceSnapshot {
  mode: 'full'
  objects: SourceCalendarObject[]
  presentHashes: Set<string>
  syncToken: string | null
}

export interface SourceChanges {
  mode: 'incremental'
  objects: SourceCalendarObject[]
  deletedHashes: Set<string>
  syncToken: string
}

export type SourceResult = SourceSnapshot | SourceChanges

export interface SourceCalendarClient {
  fetch: (options: {
    start: Date
    end: Date
    knownEtags: Map<string, string | null>
    syncToken: string | null
    forceFull: boolean
  }) => Promise<SourceResult>
}

const PROPS = {
  'd:getetag': {},
  'c:calendar-data': {},
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function propertyText(value: unknown): string | null {
  if (typeof value === 'string')
    return value
  if (!isRecord(value))
    return null
  const cdata = value._cdata
  if (typeof cdata === 'string')
    return cdata
  const text = value._text
  return typeof text === 'string' ? text : null
}

function responseEtag(response: DAVResponse): string | null {
  const etag = response.props?.getetag
  return etag == null ? null : String(etag)
}

function responseCalendarData(response: DAVResponse): string | null {
  return propertyText(response.props?.calendarData)
}

function responseHref(response: DAVResponse, calendarUrl: string): string {
  if (!response.href)
    throw new Error('CalDAV response is missing href')
  return new URL(response.href, calendarUrl).href
}

function findSyncToken(value: unknown, depth = 0): string | null {
  if (depth > 8 || !isRecord(value))
    return null
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'syncToken' || key === 'sync-token') && typeof child === 'string' && child.length > 0)
      return child
    const nested = findSyncToken(child, depth + 1)
    if (nested)
      return nested
  }
  return null
}

function validateResponses(responses: DAVResponse[], operation: string): void {
  const failed = responses.find(response => !response.ok && response.status !== 404)
  if (failed)
    throw new Error(`${operation} failed with HTTP ${failed.status}`)
}

function toDavTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace(/[-:.]/g, '')}Z`
}

export function toDavRequestHref(href: string, baseUrl: string): string {
  const url = new URL(href, baseUrl)
  return `${url.pathname}${url.search}`
}

export class TsdavSourceClient implements SourceCalendarClient {
  readonly #calendarUrl: string
  readonly #headers: Record<string, string>
  readonly #uidSecret: string
  readonly #fetchOptions: RequestInit

  constructor(config: AppConfig) {
    // SOURCE_CALDAV_URL is validated separately and documents the account endpoint.
    // SOURCE_CALENDAR_URL is deliberately the only URL queried for calendar data.
    void config.sourceCalDavUrl
    this.#calendarUrl = config.sourceCalendarUrl
    this.#uidSecret = config.uidSecret
    this.#headers = {
      authorization: `Basic ${Buffer.from(`${config.sourceCalDavUsername}:${config.sourceCalDavPassword}`, 'utf8').toString('base64')}`,
    }
    this.#fetchOptions = { signal: AbortSignal.timeout(30_000) }
  }

  async fetch(options: {
    start: Date
    end: Date
    knownEtags: Map<string, string | null>
    syncToken: string | null
    forceFull: boolean
  }): Promise<SourceResult> {
    if (options.syncToken && !options.forceFull) {
      try {
        return await this.#fetchIncremental(options.syncToken)
      }
      catch {
        // Invalid/expired sync tokens and unsupported sync-collection both fall back safely.
      }
    }
    return this.#fetchFull(options.start, options.end, options.knownEtags)
  }

  async #fetchFull(start: Date, end: Date, knownEtags: Map<string, string | null>): Promise<SourceSnapshot> {
    const filters = [{
      'comp-filter': {
        '_attributes': { name: 'VCALENDAR' },
        'comp-filter': {
          '_attributes': { name: 'VEVENT' },
          'time-range': { _attributes: { start: toDavTimestamp(start), end: toDavTimestamp(end) } },
        },
      },
    }]
    const metadata = await calendarQuery({
      url: this.#calendarUrl,
      props: { 'd:getetag': {} },
      filters,
      depth: '1',
      headers: this.#headers,
      fetchOptions: this.#fetchOptions,
    })
    validateResponses(metadata, 'calendar-query')

    const presentHashes = new Set<string>()
    const changedHrefs: string[] = []
    for (const response of metadata) {
      if (!response.ok || !response.href)
        continue
      const href = responseHref(response, this.#calendarUrl)
      const hash = createOpaqueHash(this.#uidSecret, 'resource-href', href)
      const etag = responseEtag(response)
      presentHashes.add(hash)
      if (!knownEtags.has(hash) || !etag || knownEtags.get(hash) !== etag)
        changedHrefs.push(href)
    }

    const objects: SourceCalendarObject[] = []
    for (let index = 0; index < changedHrefs.length; index += 100) {
      const responses = await calendarMultiGet({
        url: this.#calendarUrl,
        props: PROPS,
        objectUrls: changedHrefs
          .slice(index, index + 100)
          .map(href => toDavRequestHref(href, this.#calendarUrl)),
        depth: '1',
        headers: this.#headers,
        fetchOptions: this.#fetchOptions,
      })
      validateResponses(responses, 'calendar-multiget')
      for (const response of responses) {
        if (!response.ok)
          continue
        objects.push(this.#toObject(response))
      }
    }
    if (objects.length !== changedHrefs.length)
      throw new Error('CalDAV multiget returned an incomplete snapshot')

    return {
      mode: 'full',
      objects,
      presentHashes,
      syncToken: await this.#readSyncToken(),
    }
  }

  async #fetchIncremental(syncToken: string): Promise<SourceChanges> {
    const responses = await syncCollection({
      url: this.#calendarUrl,
      props: PROPS,
      syncLevel: 1,
      syncToken,
      headers: this.#headers,
      fetchOptions: this.#fetchOptions,
    })
    validateResponses(responses, 'sync-collection')
    const nextToken = responses.map(response => findSyncToken(response.raw)).find(Boolean)
    if (!nextToken)
      throw new Error('sync-collection did not return a sync-token')

    const objects: SourceCalendarObject[] = []
    const missingDataHrefs: string[] = []
    const deletedHashes = new Set<string>()
    for (const response of responses) {
      if (!response.href)
        continue
      const href = responseHref(response, this.#calendarUrl)
      const hash = createOpaqueHash(this.#uidSecret, 'resource-href', href)
      if (response.status === 404) {
        deletedHashes.add(hash)
      }
      else if (response.ok) {
        if (responseCalendarData(response))
          objects.push(this.#toObject(response))
        else
          missingDataHrefs.push(href)
      }
    }

    if (missingDataHrefs.length > 0) {
      const fetched = await calendarMultiGet({
        url: this.#calendarUrl,
        props: PROPS,
        objectUrls: missingDataHrefs.map(href => toDavRequestHref(href, this.#calendarUrl)),
        depth: '1',
        headers: this.#headers,
        fetchOptions: this.#fetchOptions,
      })
      validateResponses(fetched, 'calendar-multiget')
      for (const response of fetched) {
        if (response.ok)
          objects.push(this.#toObject(response))
      }
      if (fetched.filter(response => response.ok).length !== missingDataHrefs.length)
        throw new Error('CalDAV multiget returned incomplete incremental data')
    }

    return { mode: 'incremental', objects, deletedHashes, syncToken: nextToken }
  }

  #toObject(response: DAVResponse): SourceCalendarObject {
    const href = responseHref(response, this.#calendarUrl)
    const data = responseCalendarData(response)
    if (!data)
      throw new Error('CalDAV object is missing calendar-data')
    return {
      href,
      hrefHash: createOpaqueHash(this.#uidSecret, 'resource-href', href),
      etag: responseEtag(response),
      data,
    }
  }

  async #readSyncToken(): Promise<string | null> {
    try {
      const responses = await propfind({
        url: this.#calendarUrl,
        props: { 'd:sync-token': {} },
        depth: '0',
        headers: this.#headers,
        fetchOptions: this.#fetchOptions,
      })
      return responses.map(response => propertyText(response.props?.syncToken) ?? findSyncToken(response.raw)).find(Boolean) ?? null
    }
    catch {
      return null
    }
  }
}
