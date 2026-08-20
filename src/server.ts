import type { AppConfig } from './config'
import type { CalendarDatabase } from './db/database'
import { createCalDavHandler } from './caldav/server'
import { logger } from './logger'

export function startServer(config: AppConfig, database: CalendarDatabase): Bun.Server<undefined> {
  const tls = config.tlsCertPath && config.tlsKeyPath
    ? {
        cert: Bun.file(config.tlsCertPath),
        key: Bun.file(config.tlsKeyPath),
      }
    : null
  const server = Bun.serve({
    hostname: '0.0.0.0',
    port: config.port,
    maxRequestBodySize: 1_048_576,
    ...(tls ? { tls } : {}),
    fetch: createCalDavHandler(config, database),
    error(): Response {
      logger.error('request failed')
      return new Response('Internal server error', { status: 500 })
    },
  })
  logger.info('server started', { port: server.port, tls: Boolean(tls) })
  return server
}
