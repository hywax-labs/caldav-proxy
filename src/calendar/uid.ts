import { createHmac } from 'node:crypto'

function hmac(secret: string, scope: string, value: string): string {
  return createHmac('sha256', secret).update(`${scope}\0${value}`, 'utf8').digest('hex')
}

export function createAnonymousUid(secret: string, sourceUid: string): string {
  return `${hmac(secret, 'event-uid', sourceUid)}@anonymous-caldav.local`
}

export function createOpaqueHash(secret: string, scope: 'resource-href' | 'source-uid', value: string): string {
  return hmac(secret, scope, value)
}
