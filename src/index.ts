import { TsdavSourceClient } from './caldav/client'
import { loadConfig } from './config'
import { CalendarDatabase } from './db/database'
import { logger } from './logger'
import { startServer } from './server'
import { CalendarSync } from './sync/sync'

async function main(): Promise<void> {
  const config = loadConfig()
  const database = new CalendarDatabase(config.databasePath)
  const source = new TsdavSourceClient(config)
  const synchronization = new CalendarSync({ config, database, source })

  await synchronization.run()
  const server = startServer(config, database)
  synchronization.start()

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown)
      return
    shuttingDown = true
    logger.info('server stopping', { signal })
    await synchronization.stop()
    await server.stop(true)
    database.close()
    logger.info('server stopped')
  }

  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((e) => {
  logger.error('startup failed', { message: e.message })
  process.exitCode = 1
})
