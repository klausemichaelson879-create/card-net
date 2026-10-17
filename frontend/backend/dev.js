import { createServer as createViteServer } from 'vite'
import { createServer as createApiServer } from './server.js'

const apiPort = Number(process.env.PORT || 3001)
let apiServer
let viteServer
let shutdownPromise

async function closeServers() {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    if (viteServer) await viteServer.close()
    if (apiServer?.listening) {
      await new Promise((resolve, reject) => {
        apiServer.close((error) => error ? reject(error) : resolve())
      })
    }
  })()
  return shutdownPromise
}

async function start() {
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error('PORT must be a whole number between 1 and 65535.')
  }

  apiServer = await createApiServer()
  await new Promise((resolve, reject) => {
    apiServer.once('error', reject)
    apiServer.listen(apiPort, '127.0.0.1', resolve)
  })
  console.log(`Card Net API listening at http://127.0.0.1:${apiPort}`)

  viteServer = await createViteServer()
  await viteServer.listen()
  viteServer.printUrls()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    closeServers().then(() => {
      process.exitCode = 0
    }).catch((error) => {
      console.error('Could not stop the Card Net servers cleanly:', error)
      process.exitCode = 1
    })
  })
}

start().catch(async (error) => {
  console.error('Could not start Card Net:', error)
  try {
    await closeServers()
  } catch (closeError) {
    console.error('Could not stop partially started servers:', closeError)
  }
  process.exitCode = 1
})
