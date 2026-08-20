import type { AppConfig } from '../config'
import type { CalendarDatabase, StoredCalendarObject } from '../db/database'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

const MAX_BODY_BYTES = 1_048_576
const READ_ONLY_METHODS = new Set(['COPY', 'DELETE', 'MKCALENDAR', 'MKCOL', 'MOVE', 'POST', 'PUT'])
const ALLOW = 'OPTIONS, PROPFIND, REPORT, GET, HEAD'

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  processEntities: false,
  trimValues: true,
})

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;')
}

function xmlResponse(body: string, status = 207): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'DAV': '1, 3, calendar-access',
    },
  })
}

function multistatus(responses: string[]): Response {
  return xmlResponse(`<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses.join('')}</D:multistatus>`)
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  if (actualBuffer.length !== expectedBuffer.length)
    return false
  return timingSafeEqual(actualBuffer, expectedBuffer)
}

function authorized(request: Request, config: AppConfig): boolean {
  const header = request.headers.get('authorization')
  if (!header?.startsWith('Basic '))
    return false
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    if (separator < 0)
      return false
    return constantTimeEqual(decoded.slice(0, separator), config.publicCalDavUsername)
      && constantTimeEqual(decoded.slice(separator + 1), config.publicCalDavPassword)
  }
  catch {
    return false
  }
}

function unauthorized(): Response {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Anonymous Calendar", charset="UTF-8"',
      'Cache-Control': 'no-store',
    },
  })
}

function requestOrigin(request: Request): string {
  const url = new URL(request.url)
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  const protocol = forwarded === 'https' || forwarded === 'http' ? `${forwarded}:` : url.protocol
  return `${protocol}//${url.host}`
}

function href(request: Request, path: string): string {
  return xmlEscape(new URL(path, `${requestOrigin(request)}/`).href)
}

function collectionProperties(request: Request, path: string, database: CalendarDatabase): string {
  const principal = href(request, '/caldav/principal/')
  if (path === '/caldav/principal/') {
    return `
      <D:resourcetype><D:principal/></D:resourcetype>
      <D:displayname>Anonymous Calendar User</D:displayname>
      <D:current-user-principal><D:href>${principal}</D:href></D:current-user-principal>
      <D:principal-URL><D:href>${principal}</D:href></D:principal-URL>
      <C:calendar-home-set><D:href>${href(request, '/caldav/')}</D:href></C:calendar-home-set>
      <D:current-user-privilege-set><D:privilege><D:read/></D:privilege><D:privilege><D:read-current-user-privilege-set/></D:privilege></D:current-user-privilege-set>`
  }
  if (path === '/caldav/calendar/') {
    const state = database.getSyncState()
    const token = xmlEscape(`${state.lastSuccessfulSync ?? 'empty'}-${database.countObjects()}`)
    return `
      <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
      <D:displayname>Busy</D:displayname>
      <D:current-user-principal><D:href>${principal}</D:href></D:current-user-principal>
      <D:current-user-privilege-set><D:privilege><D:read/></D:privilege><D:privilege><D:read-current-user-privilege-set/></D:privilege></D:current-user-privilege-set>
      <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
      <D:supported-report-set>
        <D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report>
        <D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report>
      </D:supported-report-set>
      <D:getcontenttype>text/calendar; component=vevent</D:getcontenttype>
      <D:getetag>&quot;${token}&quot;</D:getetag>`
  }
  return `
    <D:resourcetype><D:collection/></D:resourcetype>
    <D:displayname>Anonymous CalDAV</D:displayname>
    <D:current-user-principal><D:href>${principal}</D:href></D:current-user-principal>
    <D:principal-URL><D:href>${principal}</D:href></D:principal-URL>
    <C:calendar-home-set><D:href>${href(request, '/caldav/')}</D:href></C:calendar-home-set>
    <D:current-user-privilege-set><D:privilege><D:read/></D:privilege></D:current-user-privilege-set>`
}

function propResponse(request: Request, path: string, properties: string): string {
  return `<D:response><D:href>${href(request, path)}</D:href><D:propstat><D:prop>${properties}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
}

function objectProperties(request: Request, object: StoredCalendarObject, includeData: boolean): string {
  const calendarData = includeData ? `<C:calendar-data content-type="text/calendar" version="2.0">${xmlEscape(object.ical)}</C:calendar-data>` : ''
  return propResponse(request, `/caldav/calendar/${object.publicId}.ics`, `
    <D:resourcetype/>
    <D:getetag>${xmlEscape(object.publicEtag)}</D:getetag>
    <D:getcontenttype>text/calendar; charset=utf-8; component=vevent</D:getcontenttype>
    <D:getcontentlength>${new TextEncoder().encode(object.ical).byteLength}</D:getcontentlength>
    <D:getlastmodified>${new Date(object.updatedAt).toUTCString()}</D:getlastmodified>
    ${calendarData}`)
}

function notFoundPropResponse(request: Request, path: string): string {
  return `<D:response><D:href>${href(request, path)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`
}

async function safeXmlBody(request: Request): Promise<{ body: string, parsed: unknown }> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES)
    throw new RangeError('Request body too large')
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES)
    throw new RangeError('Request body too large')
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(body))
    throw new Error('DOCTYPE and ENTITY are forbidden')
  const validation = XMLValidator.validate(body)
  if (validation !== true)
    throw new Error('Malformed XML')
  return { body, parsed: xmlParser.parse(body) as unknown }
}

function hasNode(value: unknown, nodeName: string, depth = 0): boolean {
  if (depth > 32 || typeof value !== 'object' || value === null)
    return false
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === nodeName)
      return true
    if (hasNode(child, nodeName, depth + 1))
      return true
  }
  return false
}

function collectHrefs(value: unknown, output: string[] = [], depth = 0): string[] {
  if (depth > 32 || typeof value !== 'object' || value === null)
    return output
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === 'href') {
      if (typeof child === 'string')
        output.push(child)
      else if (Array.isArray(child))
        output.push(...child.filter(item => typeof item === 'string'))
    }
    else {
      collectHrefs(child, output, depth + 1)
    }
  }
  return output
}

function objectIdFromHref(rawHref: string): string | null {
  try {
    const path = new URL(rawHref, 'http://caldav.local').pathname
    const match = path.match(/^\/caldav\/calendar\/([a-f0-9]{64})\.ics$/)
    return match?.[1] ?? null
  }
  catch {
    return null
  }
}

async function handlePropfind(request: Request, path: string, database: CalendarDatabase): Promise<Response> {
  if (!['/caldav/', '/caldav/principal/', '/caldav/calendar/'].includes(path)) {
    const id = objectIdFromHref(path)
    const object = id ? database.getObject(id) : null
    return object ? multistatus([objectProperties(request, object, false)]) : new Response('Not found', { status: 404 })
  }

  if (request.body) {
    try {
      await safeXmlBody(request)
    }
    catch (error) {
      return new Response(error instanceof RangeError ? 'Request body too large' : 'Malformed XML', { status: error instanceof RangeError ? 413 : 400 })
    }
  }

  const responses = [propResponse(request, path, collectionProperties(request, path, database))]
  if (request.headers.get('depth') === '1') {
    if (path === '/caldav/')
      responses.push(propResponse(request, '/caldav/calendar/', collectionProperties(request, '/caldav/calendar/', database)))
    else if (path === '/caldav/calendar/')
      responses.push(...database.listObjects().map(object => objectProperties(request, object, false)))
  }
  return multistatus(responses)
}

async function handleReport(request: Request, path: string, database: CalendarDatabase): Promise<Response> {
  if (path !== '/caldav/calendar/')
    return new Response('REPORT is only supported on the calendar collection', { status: 405, headers: { Allow: ALLOW } })

  let parsed: unknown
  try {
    parsed = (await safeXmlBody(request)).parsed
  }
  catch (error) {
    return new Response(error instanceof RangeError ? 'Request body too large' : 'Malformed XML', { status: error instanceof RangeError ? 413 : 400 })
  }

  if (hasNode(parsed, 'calendar-query'))
    return multistatus(database.listObjects().map(object => objectProperties(request, object, true)))

  if (hasNode(parsed, 'calendar-multiget')) {
    const responses = collectHrefs(parsed).map((requestedHref) => {
      const id = objectIdFromHref(requestedHref)
      const object = id ? database.getObject(id) : null
      return object ? objectProperties(request, object, true) : notFoundPropResponse(request, requestedHref)
    })
    return multistatus(responses)
  }

  return new Response('Unsupported REPORT', { status: 403 })
}

function getCalendarObject(request: Request, path: string, database: CalendarDatabase): Response {
  const id = objectIdFromHref(path)
  const object = id ? database.getObject(id) : null
  if (!object)
    return new Response('Not found', { status: 404 })
  if (request.headers.get('if-none-match') === object.publicEtag)
    return new Response(null, { status: 304, headers: { ETag: object.publicEtag } })
  return new Response(request.method === 'HEAD' ? null : object.ical, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Length': String(new TextEncoder().encode(object.ical).byteLength),
      'ETag': object.publicEtag,
      'Last-Modified': new Date(object.updatedAt).toUTCString(),
      'Cache-Control': 'private, no-cache',
    },
  })
}

export function createCalDavHandler(config: AppConfig, database: CalendarDatabase): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'GET' && path === '/health')
      return Response.json({ status: 'ok' })
    if (path === '/.well-known/caldav')
      return Response.redirect(new URL('/caldav/', request.url), 301)
    if (!authorized(request, config))
      return unauthorized()

    if (request.method === 'GET' && path === '/status') {
      const state = database.getSyncState()
      return Response.json({
        lastSuccessfulSync: state.lastSuccessfulSync,
        lastSyncAttempt: state.lastSyncAttempt,
        events: database.countObjects(),
      }, { headers: { 'Cache-Control': 'no-store' } })
    }

    if (READ_ONLY_METHODS.has(request.method))
      return new Response('Read-only calendar', { status: 403, headers: { Allow: ALLOW } })
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { 'Allow': ALLOW, 'DAV': '1, 3, calendar-access', 'MS-Author-Via': 'DAV' },
      })
    }
    if (request.method === 'PROPFIND')
      return handlePropfind(request, path, database)
    if (request.method === 'REPORT')
      return handleReport(request, path, database)
    if ((request.method === 'GET' || request.method === 'HEAD') && path.startsWith('/caldav/calendar/'))
      return getCalendarObject(request, path, database)
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response('Method not allowed', { status: 405, headers: { Allow: ALLOW } })
    return new Response('Not found', { status: 404 })
  }
}
