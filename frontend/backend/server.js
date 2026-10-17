import { createServer as createHttpServer } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { products } from './catalog.js'

const directory = dirname(fileURLToPath(import.meta.url))
const defaultDataFile = resolve(directory, 'data', 'store.json')
const maxBodyBytes = 32 * 1024
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const frontendDirectory = resolve(directory, '..')
const defaultStaticDirectory = resolve(frontendDirectory, 'dist')
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
])

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function readStore(dataFile) {
  try {
    const parsed = JSON.parse(await readFile(dataFile, 'utf8'))
    if (!parsed || !Array.isArray(parsed.orders) || !Array.isArray(parsed.messages)) {
      throw new Error('Store file must contain orders and messages arrays.')
    }
    return parsed
  } catch (error) {
    if (error.code === 'ENOENT') return { orders: [], messages: [] }
    throw new Error(`Could not load the store data at ${dataFile}: ${error.message}`, { cause: error })
  }
}

async function saveStore(dataFile, store) {
  await mkdir(dirname(dataFile), { recursive: true })
  const temporaryFile = `${dataFile}.${process.pid}.tmp`
  await writeFile(temporaryFile, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  await rename(temporaryFile, dataFile)
}

async function readJsonBody(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Send this request as JSON.')
  }

  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > maxBodyBytes) throw new HttpError(413, 'Request body is too large.')
    chunks.push(chunk)
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.')
  }
}

async function readRawBody(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > maxBodyBytes) throw new HttpError(413, 'Request body is too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function requireText(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new HttpError(400, `${field} is required and must be no longer than ${maxLength} characters.`)
  }
  return value.trim()
}

function requireEmail(value) {
  const email = requireText(value, 'Email', 254)
  if (!emailPattern.test(email)) throw new HttpError(400, 'Enter a valid email address.')
  return email
}

function paymentConfiguration(env) {
  const readOnly = env.CARDNET_READ_ONLY === 'true'
  const transferDetails = {
    bankName: env.CARDNET_BANK_NAME?.trim() || '',
    accountName: env.CARDNET_ACCOUNT_NAME?.trim() || '',
    accountNumber: env.CARDNET_ACCOUNT_NUMBER?.trim() || '',
    routingNumber: env.CARDNET_ROUTING_NUMBER?.trim() || '',
    iban: env.CARDNET_IBAN?.trim() || '',
  }
  const transferConfigured = Boolean(
    transferDetails.bankName
      && transferDetails.accountName
      && transferDetails.accountNumber
      && (transferDetails.routingNumber || transferDetails.iban),
  )

  return {
    transfer: {
      enabled: !readOnly && transferConfigured,
      details: !readOnly && transferConfigured ? transferDetails : null,
    },
    card: { enabled: !readOnly && Boolean(env.STRIPE_SECRET_KEY) },
    assistant: { enabled: Boolean(env.OPENAI_API_KEY) },
    contact: { enabled: !readOnly },
    readOnly,
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(`${JSON.stringify(payload)}\n`)
}

function createOrder(body, paymentMethod) {
  const name = requireText(body?.customer?.name, 'Name', 100)
  const email = requireEmail(body?.customer?.email)
  if (!Array.isArray(body?.items) || body.items.length < 1 || body.items.length > 20) {
    throw new HttpError(400, 'An order must contain between 1 and 20 different items.')
  }

  const itemMap = new Map()
  for (const item of body.items) {
    if (!item || typeof item.productId !== 'string' || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) {
      throw new HttpError(400, 'Each order item must have a product ID and a quantity between 1 and 10.')
    }
    itemMap.set(item.productId, (itemMap.get(item.productId) || 0) + item.quantity)
    if (itemMap.get(item.productId) > 10) throw new HttpError(400, 'You can order at most 10 of each item.')
  }

  const orderItems = [...itemMap].map(([productId, quantity]) => {
    const product = products.find((entry) => entry.id === productId)
    if (!product) throw new HttpError(400, `Product "${productId}" is not available.`)
    return { productId, name: product.name, unitPrice: product.price, quantity, lineTotal: product.price * quantity }
  })

  return {
    id: randomUUID(),
    customer: { name, email },
    items: orderItems,
    total: Number(orderItems.reduce((sum, item) => sum + item.lineTotal, 0).toFixed(2)),
    paymentMethod,
    status: paymentMethod === 'bank_transfer' ? 'awaiting_transfer' : 'awaiting_payment',
    createdAt: new Date().toISOString(),
  }
}

async function readStripeResponse(response, action) {
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    console.error(`Stripe ${action} failed:`, result.error?.message || response.statusText)
    throw new HttpError(502, `Card checkout is temporarily unavailable. Please try again or choose bank transfer.`)
  }
  return result
}

export async function createServer({ dataFile = defaultDataFile, env = process.env, fetchImpl = fetch } = {}) {
  const dataPath = resolve(env.CARDNET_DATA_FILE || dataFile)
  const staticDirectory = resolve(env.CARDNET_STATIC_DIR || defaultStaticDirectory)
  let store = await readStore(dataPath)
  let writeQueue = Promise.resolve()
  const chatRateLimits = new Map()

  function persistMutation(mutate) {
    const operation = writeQueue.then(async () => {
      const updatedStore = structuredClone(store)
      const result = mutate(updatedStore)
      await saveStore(dataPath, updatedStore)
      store = updatedStore
      return result
    })
    writeQueue = operation.catch(() => {})
    return operation
  }

  return createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost')

      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { status: 'ok' })
        return
      }

      if (request.method === 'GET' && url.pathname === '/api/products') {
        const query = (url.searchParams.get('q') || '').trim().toLocaleLowerCase()
        const category = url.searchParams.get('category') || 'All'
        const filteredProducts = products.filter((product) => {
          const matchesCategory = category === 'All' || product.category === category
          const matchesQuery = !query || `${product.name} ${product.description} ${product.category}`.toLocaleLowerCase().includes(query)
          return matchesCategory && matchesQuery
        })
        sendJson(response, 200, { products: filteredProducts })
        return
      }

      if (request.method === 'GET' && url.pathname === '/api/payment-options') {
        sendJson(response, 200, paymentConfiguration(env))
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/orders') {
        if (env.CARDNET_READ_ONLY === 'true') {
          throw new HttpError(503, 'Ordering is disabled on this free preview.')
        }
        const body = await readJsonBody(request)
        if (body?.paymentMethod !== 'bank_transfer') {
          throw new HttpError(400, 'Choose a supported payment method.')
        }
        const payment = paymentConfiguration(env).transfer
        if (!payment.enabled) {
          throw new HttpError(503, 'Bank transfer is not configured yet. Please contact the store.')
        }

        const order = createOrder(body, 'bank_transfer')
        await persistMutation((updatedStore) => updatedStore.orders.push(order))
        sendJson(response, 201, {
          order,
          bankTransfer: { ...payment.details, reference: order.id },
        })
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/checkout/card') {
        if (env.CARDNET_READ_ONLY === 'true') {
          throw new HttpError(503, 'Card checkout is disabled on this free preview.')
        }
        if (!env.STRIPE_SECRET_KEY) {
          throw new HttpError(503, 'Card payments are not configured yet. Please choose bank transfer.')
        }
        const publicUrl = env.CARDNET_PUBLIC_URL || 'http://localhost:5173'
        let baseUrl
        try {
          baseUrl = new URL(publicUrl)
          if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) throw new Error('Invalid public URL.')
        } catch {
          throw new HttpError(500, 'Set CARDNET_PUBLIC_URL to the public website URL.')
        }

        const body = await readJsonBody(request)
        const order = createOrder(body, 'card')
        const parameters = new URLSearchParams({
          mode: 'payment',
          customer_email: order.customer.email,
          'payment_method_types[0]': 'card',
          client_reference_id: order.id,
          success_url: new URL('/?payment=success&session_id={CHECKOUT_SESSION_ID}', baseUrl).href,
          cancel_url: new URL('/?payment=cancelled', baseUrl).href,
          'metadata[order_id]': order.id,
        })
        order.items.forEach((item, index) => {
          parameters.set(`line_items[${index}][quantity]`, String(item.quantity))
          parameters.set(`line_items[${index}][price_data][currency]`, 'usd')
          parameters.set(`line_items[${index}][price_data][unit_amount]`, String(Math.round(item.unitPrice * 100)))
          parameters.set(`line_items[${index}][price_data][product_data][name]`, item.name)
          parameters.set(`line_items[${index}][price_data][product_data][metadata][product_id]`, item.productId)
        })

        const stripeResponse = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: parameters,
          signal: AbortSignal.timeout(15000),
        })
        const session = await readStripeResponse(stripeResponse, 'checkout session creation')
        if (typeof session.id !== 'string' || typeof session.url !== 'string' || !session.url.startsWith('https://checkout.stripe.com/')) {
          console.error('Stripe returned an invalid Checkout Session.')
          throw new HttpError(502, 'Card checkout is temporarily unavailable. Please try again.')
        }

        order.stripeSessionId = session.id
        await persistMutation((updatedStore) => updatedStore.orders.push(order))
        sendJson(response, 201, { orderId: order.id, checkoutUrl: session.url })
        return
      }

      if (request.method === 'GET' && url.pathname === '/api/orders/payment-status') {
        if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, 'Card payment verification is not configured.')
        const sessionId = url.searchParams.get('session_id') || ''
        if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) throw new HttpError(400, 'Invalid checkout session.')
        const stripeResponse = await fetchImpl(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
          headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
          signal: AbortSignal.timeout(15000),
        })
        const session = await readStripeResponse(stripeResponse, 'payment verification')
        const order = store.orders.find((entry) => entry.id === session.metadata?.order_id && entry.stripeSessionId === session.id)
        if (!order || session.client_reference_id !== order.id) throw new HttpError(404, 'Order not found for this checkout session.')
        if (session.currency !== 'usd' || session.amount_total !== Math.round(order.total * 100)) {
          throw new HttpError(409, 'The payment amount does not match this order.')
        }

        if (session.payment_status === 'paid' && order.status !== 'paid') {
          await persistMutation((updatedStore) => {
            const savedOrder = updatedStore.orders.find((entry) => entry.id === order.id)
            savedOrder.status = 'paid'
            savedOrder.paidAt = new Date().toISOString()
          })
        }
        sendJson(response, 200, { orderId: order.id, status: session.payment_status === 'paid' ? 'paid' : 'awaiting_payment' })
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/webhooks/stripe') {
        if (env.CARDNET_READ_ONLY === 'true') {
          throw new HttpError(503, 'Payments are disabled on this free preview.')
        }
        if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, 'Stripe webhooks are not configured.')
        const payload = await readRawBody(request)
        const signatureHeader = request.headers['stripe-signature'] || ''
        const signatureParts = signatureHeader.split(',').map((part) => part.split('=', 2))
        const timestamp = signatureParts.find(([key]) => key === 't')?.[1]
        const signatures = signatureParts.filter(([key, value]) => key === 'v1' && /^[0-9a-f]{64}$/i.test(value || '')).map(([, value]) => value)
        if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || signatures.length === 0) {
          throw new HttpError(400, 'Invalid Stripe webhook signature.')
        }

        const expectedSignature = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET)
          .update(`${timestamp}.${payload}`)
          .digest()
        const signatureIsValid = signatures.some((signature) => timingSafeEqual(Buffer.from(signature, 'hex'), expectedSignature))
        if (!signatureIsValid) throw new HttpError(400, 'Invalid Stripe webhook signature.')

        let event
        try {
          event = JSON.parse(payload.toString('utf8'))
        } catch {
          throw new HttpError(400, 'Invalid Stripe webhook payload.')
        }

        if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
          const session = event.data?.object
          if (session?.payment_status === 'paid' && typeof session.id === 'string' && typeof session.metadata?.order_id === 'string') {
            const order = store.orders.find((entry) => entry.id === session.metadata.order_id && entry.stripeSessionId === session.id)
            if (!order || session.client_reference_id !== order.id) throw new HttpError(404, 'Order not found for this checkout session.')
            if (session.currency !== 'usd' || session.amount_total !== Math.round(order.total * 100)) {
              throw new HttpError(409, 'The payment amount does not match this order.')
            }
            if (order.status !== 'paid') {
              await persistMutation((updatedStore) => {
                const savedOrder = updatedStore.orders.find((entry) => entry.id === order.id)
                savedOrder.status = 'paid'
                savedOrder.paidAt = new Date().toISOString()
              })
            }
          }
        }
        sendJson(response, 200, { received: true })
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/contact') {
        if (env.CARDNET_READ_ONLY === 'true') {
          throw new HttpError(503, 'The contact form is unavailable on this free preview.')
        }
        const body = await readJsonBody(request)
        const message = {
          id: randomUUID(),
          name: requireText(body?.name, 'Name', 100),
          email: requireEmail(body?.email),
          message: requireText(body?.message, 'Message', 2000),
          createdAt: new Date().toISOString(),
        }
        await persistMutation((updatedStore) => updatedStore.messages.push(message))
        sendJson(response, 201, { message: 'Thanks for reaching out.', id: message.id })
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/chat') {
        if (!env.OPENAI_API_KEY) throw new HttpError(503, 'The chat assistant is not configured yet. Please try again later.')
        const now = Date.now()
        const address = request.socket.remoteAddress || 'unknown'
        const rateLimit = chatRateLimits.get(address)
        if (!rateLimit || rateLimit.resetAt <= now) {
          chatRateLimits.set(address, { count: 1, resetAt: now + 60000 })
        } else {
          rateLimit.count += 1
          if (rateLimit.count > 20) throw new HttpError(429, 'That is a lot of messages. Please wait a minute and try again.')
        }
        if (chatRateLimits.size > 1000) {
          for (const [client, limit] of chatRateLimits) {
            if (limit.resetAt <= now) chatRateLimits.delete(client)
          }
        }
        const body = await readJsonBody(request)
        if (!Array.isArray(body?.messages) || body.messages.length < 1 || body.messages.length > 8) {
          throw new HttpError(400, 'Send between 1 and 8 chat messages.')
        }
        const messages = body.messages.map((message) => {
          if (!message || !['user', 'assistant'].includes(message.role)) {
            throw new HttpError(400, 'Chat messages must have a user or assistant role.')
          }
          return { role: message.role, content: requireText(message.content, 'Chat message', 2000) }
        })
        if (messages[messages.length - 1].role !== 'user') {
          throw new HttpError(400, 'Your latest chat message must be from you.')
        }

        const model = env.OPENAI_MODEL?.trim() || 'gpt-4o-mini'
        const assistantResponse = await fetchImpl('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_tokens: 500,
            messages: [
              {
                role: 'system',
                content: `You are Card Net's friendly, clear, helpful AI assistant. Answer general questions helpfully and assist shoppers with choosing cards, invitations, experiences, and gifts. When relevant, use this current product catalog and prices in USD: ${JSON.stringify(products.map(({ id, name, category, description, price }) => ({ id, name, category, description, price })))}. Do not invent store policies, delivery dates, inventory, or payment status. Say when you do not know, and direct order-specific requests to the contact form. Never request or accept full card numbers, security codes, passwords, or bank login credentials. Keep answers concise and warm.`,
              },
              ...messages,
            ],
          }),
          signal: AbortSignal.timeout(20000),
        })
        if (!assistantResponse.ok) {
          const errorBody = await assistantResponse.json().catch(() => ({}))
          console.error('AI provider request failed:', errorBody.error?.message || assistantResponse.statusText)
          throw new HttpError(502, 'The chat assistant is temporarily unavailable. Please try again in a moment.')
        }
        const answer = await assistantResponse.json()
        const reply = answer.choices?.[0]?.message?.content
        if (typeof reply !== 'string' || !reply.trim() || reply.length > 4000) {
          console.error('AI provider returned an invalid chat response.')
          throw new HttpError(502, 'The chat assistant could not prepare a reply. Please try again.')
        }
        sendJson(response, 200, { reply: reply.trim() })
        return
      }

      if (env.NODE_ENV === 'production' && !url.pathname.startsWith('/api/') && ['GET', 'HEAD'].includes(request.method)) {
        let decodedPath
        try {
          decodedPath = decodeURIComponent(url.pathname)
        } catch {
          throw new HttpError(400, 'Invalid URL path.')
        }
        const filePath = resolve(staticDirectory, `.${decodedPath === '/' ? '/index.html' : decodedPath}`)
        const relativePath = relative(staticDirectory, filePath)
        if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || relativePath === '') {
          throw new HttpError(404, 'Page not found.')
        }

        let content
        try {
          content = await readFile(filePath)
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'EISDIR') throw new HttpError(404, 'Page not found.')
          throw error
        }

        const isHashedAsset = relativePath.startsWith(`assets${sep}`)
        response.writeHead(200, {
          'Content-Type': contentTypes.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
          'Cache-Control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        })
        response.end(request.method === 'HEAD' ? undefined : content)
        return
      }

      sendJson(response, 404, { error: 'API endpoint not found.' })
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message })
        return
      }

      console.error('API request failed:', error)
      if (response.headersSent) {
        response.destroy(error)
        return
      }
      sendJson(response, 500, { error: 'The request could not be completed. Please try again.' })
    }
  })
}

async function startServer() {
  const port = Number(process.env.PORT || 3001)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a whole number between 1 and 65535.')
  }
  const server = await createServer()
  server.listen(port, '0.0.0.0', () => {
    console.log(`Card Net API listening at http://127.0.0.1:${port}`)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer().catch((error) => {
    console.error('Could not start the Card Net API:', error)
    process.exitCode = 1
  })
}
