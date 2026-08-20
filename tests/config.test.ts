import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../src/config'
import { TEST_SECRET } from './helpers'

const REQUIRED_ENV = {
  PUBLIC_CALDAV_PASSWORD: 'public-password',
  SOURCE_CALDAV_PASSWORD: 'source-password',
  SOURCE_CALDAV_URL: 'https://source.example.test/dav/',
  SOURCE_CALDAV_USERNAME: 'source-user',
  SOURCE_CALENDAR_URL: 'https://source.example.test/dav/calendar/',
  UID_SECRET: TEST_SECRET,
}

describe('configuration', () => {
  test('allows TLS only when certificate and key are configured together', () => {
    expect(() => loadConfig({
      ...REQUIRED_ENV,
      TLS_CERT_PATH: '.certs/localhost.pem',
    })).toThrow('TLS_CERT_PATH and TLS_KEY_PATH must be configured together')

    expect(loadConfig({
      ...REQUIRED_ENV,
      TLS_CERT_PATH: '.certs/localhost.pem',
      TLS_KEY_PATH: '.certs/localhost-key.pem',
    })).toMatchObject({
      tlsCertPath: '.certs/localhost.pem',
      tlsKeyPath: '.certs/localhost-key.pem',
    })
  })
})
