export interface AppConfig {
  sourceCalDavUrl: string
  sourceCalDavUsername: string
  sourceCalDavPassword: string
  sourceCalendarUrl: string
  publicCalDavUsername: string
  publicCalDavPassword: string
  uidSecret: string
  anonymousEventTitle: string
  syncIntervalSeconds: number
  syncPastDays: number
  syncFutureDays: number
  databasePath: string
  port: number
  tlsCertPath: string | null
  tlsKeyPath: string | null
}

type Environment = Record<string, string | undefined>

function required(env: Environment, name: string): string {
  const value = env[name]?.trim()
  if (!value)
    throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function positiveInteger(env: Environment, name: string, fallback: number, maximum: number): number {
  const raw = env[name]?.trim()
  if (!raw)
    return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
    throw new Error(`${name} must be an integer between 1 and ${maximum}`)
  return value
}

function httpUrl(value: string, name: string): string {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw new Error(`${name} must be a valid URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`${name} must use http or https`)
  return url.href
}

export function loadConfig(env: Environment = Bun.env): AppConfig {
  const uidSecret = required(env, 'UID_SECRET')
  if (new TextEncoder().encode(uidSecret).byteLength < 32)
    throw new Error('UID_SECRET must be at least 32 bytes')

  const tlsCertPath = env.TLS_CERT_PATH?.trim() || null
  const tlsKeyPath = env.TLS_KEY_PATH?.trim() || null
  if (Boolean(tlsCertPath) !== Boolean(tlsKeyPath))
    throw new Error('TLS_CERT_PATH and TLS_KEY_PATH must be configured together')

  return {
    sourceCalDavUrl: httpUrl(required(env, 'SOURCE_CALDAV_URL'), 'SOURCE_CALDAV_URL'),
    sourceCalDavUsername: required(env, 'SOURCE_CALDAV_USERNAME'),
    sourceCalDavPassword: required(env, 'SOURCE_CALDAV_PASSWORD'),
    sourceCalendarUrl: httpUrl(required(env, 'SOURCE_CALENDAR_URL'), 'SOURCE_CALENDAR_URL'),
    publicCalDavUsername: env.PUBLIC_CALDAV_USERNAME?.trim() || 'calendar',
    publicCalDavPassword: required(env, 'PUBLIC_CALDAV_PASSWORD'),
    uidSecret,
    anonymousEventTitle: env.ANONYMOUS_EVENT_TITLE?.trim() || 'Busy',
    syncIntervalSeconds: positiveInteger(env, 'SYNC_INTERVAL', 60, 86_400),
    syncPastDays: positiveInteger(env, 'SYNC_PAST_DAYS', 30, 3_650),
    syncFutureDays: positiveInteger(env, 'SYNC_FUTURE_DAYS', 365, 3_650),
    databasePath: env.DATABASE_PATH?.trim() || '/data/database.sqlite',
    port: positiveInteger(env, 'PORT', 3000, 65_535),
    tlsCertPath,
    tlsKeyPath,
  }
}
