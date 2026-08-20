export type LogValue = boolean | number | string | null | undefined
export type LogFields = Record<string, LogValue>

const SENSITIVE_FIELD_NAMES = [
  'authorization',
  'password',
  'credential',
  'ics',
  'summary',
  'description',
  'location',
  'attendee',
]

function write(level: 'error' | 'info', event: string, fields: LogFields = {}): void {
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => {
      const lowerKey = key.toLowerCase()
      return value !== undefined && !SENSITIVE_FIELD_NAMES.some(name => lowerKey.includes(name))
    }),
  )
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...safeFields,
  })
  if (level === 'error')
    console.error(line)
  else
    console.info(line)
}

export const logger = {
  info(event: string, fields?: LogFields): void {
    write('info', event, fields)
  },
  error(event: string, fields?: LogFields): void {
    write('error', event, fields)
  },
}
