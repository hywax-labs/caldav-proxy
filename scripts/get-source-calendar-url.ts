import { Buffer } from 'node:buffer'
import { propfind } from 'tsdav'
import { loadConfig } from '../src/config.ts'

const config = loadConfig()
const headers = {
  authorization: `Basic ${Buffer
    .from(`${config.sourceCalDavUsername}:${config.sourceCalDavPassword}`)
    .toString('base64')}`,
}

const principal = await propfind({
  url: config.sourceCalDavUrl,
  props: { 'c:calendar-home-set': {} },
  depth: '0',
  headers,
})

const homeHref = principal.find(response => response.ok)
  ?.props
  ?.calendarHomeSet
  ?.href

const homeUrl = new URL(homeHref, config.sourceCalDavUrl).href

const resources = await propfind({
  url: homeUrl,
  props: {
    'd:displayname': {},
    'd:resourcetype': {},
    'c:supported-calendar-component-set': {},
  },
  depth: '1',
  headers,
})

for (const resource of resources) {
  if (
    resource.ok
    && Object.keys(resource.props?.resourcetype ?? {}).includes('calendar')
  ) {
    console.log(resource.props?.displayname ?? '(no name)')
    console.log(new URL(resource.href ?? '', homeUrl).href)
    console.log()
  }
}
