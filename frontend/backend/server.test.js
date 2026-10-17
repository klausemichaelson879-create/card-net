import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createServer } from './server.js'

const testServers = []

async function startTestServer(options = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'card-net-api-'))
  const dataFile = join(dataDirectory, 'store.json')
  const server = await createServer({ dataFile, ...options })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const testServer = {
    server,
    dataFile,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await rm(dataDirectory, { recursive: true, force: true })
    },
  }
  testServers.push(testServer)
  return testServer
}

let app

before(async () => {
  app = await startTestServer({ env: {} })
})

after(async () => {
  await Promise.all(testServers.map((testServer) => testServer.close()))
})

test('returns the product collection and supports category filtering', async () => {
  const response = await fetch(`${app.baseUrl}/api/products?category=Tickets`)
  const result = await response.json()

  assert.equal(response.status, 200)
  assert.ok(result.products.length > 0)
  assert.ok(result.products.every((product) => product.category === 'Tickets'))
})

test('reports unavailable payments explicitly when providers are not configured', async () => {
  const response = await fetch(`${app.baseUrl}/api/payment-options`)
  const result = await response.json()

  assert.equal(response.status, 200)
  assert.equal(result.card.enabled, false)
  assert.equal(result.transfer.enabled, false)
})

test('keeps a free preview read-only even when payment credentials are present', async () => {
  const preview = await startTestServer({
    env: {
      CARDNET_READ_ONLY: 'true',
      CARDNET_BANK_NAME: 'Example Bank',
      CARDNET_ACCOUNT_NAME: 'Card Net LLC',
      CARDNET_ACCOUNT_NUMBER: '12345678',
      CARDNET_ROUTING_NUMBER: '87654321',
      STRIPE_SECRET_KEY: 'sk_test_private',
      STRIPE_WEBHOOK_SECRET: 'whsec_private',
    },
  })
  const optionsResponse = await fetch(`${preview.baseUrl}/api/payment-options`)
  const options = await optionsResponse.json()
  const orderResponse = await fetch(`${preview.baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paymentMethod: 'bank_transfer',
      customer: { name: 'Sam', email: 'sam@example.com' },
      items: [{ productId: 'birthday-wishes', quantity: 1 }],
    }),
  })
  const contactResponse = await fetch(`${preview.baseUrl}/api/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sam', email: 'sam@example.com', message: 'Hello' }),
  })
  const cardResponse = await fetch(`${preview.baseUrl}/api/checkout/card`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: { name: 'Sam', email: 'sam@example.com' },
      items: [{ productId: 'birthday-wishes', quantity: 1 }],
    }),
  })

  assert.equal(options.readOnly, true)
  assert.equal(options.transfer.enabled, false)
  assert.equal(options.card.enabled, false)
  assert.equal(options.contact.enabled, false)
  assert.equal(orderResponse.status, 503)
  assert.equal(contactResponse.status, 503)
  assert.equal(cardResponse.status, 503)
  await assert.rejects(readFile(preview.dataFile, 'utf8'), { code: 'ENOENT' })
})

test('serves the production frontend and static assets from the Node server', async () => {
  const appDirectory = await mkdtemp(join(tmpdir(), 'card-net-production-'))
  const staticDirectory = join(appDirectory, 'dist')
  await mkdir(join(staticDirectory, 'assets'), { recursive: true })
  await writeFile(join(staticDirectory, 'index.html'), '<!doctype html><title>Card Net</title>', 'utf8')
  await writeFile(join(staticDirectory, 'assets', 'app.css'), 'body { color: brown; }', 'utf8')
  const productionApp = await startTestServer({
    env: { NODE_ENV: 'production', CARDNET_STATIC_DIR: staticDirectory },
  })
  try {
    const pageResponse = await fetch(productionApp.baseUrl)
    const assetResponse = await fetch(`${productionApp.baseUrl}/assets/app.css`)
    const traversalResponse = await fetch(`${productionApp.baseUrl}/%2e%2e%2fstore.json`)

    assert.equal(pageResponse.status, 200)
    assert.match(pageResponse.headers.get('content-type'), /text\/html/)
    assert.match(await pageResponse.text(), /Card Net/)
    assert.equal(assetResponse.status, 200)
    assert.match(assetResponse.headers.get('cache-control'), /immutable/)
    assert.match(await assetResponse.text(), /color: brown/)
    assert.equal(traversalResponse.status, 404)
  } finally {
    await rm(appDirectory, { recursive: true, force: true })
  }
})

test('creates bank-transfer orders with server prices and payment reference', async () => {
  const transferApp = await startTestServer({
    env: {
      CARDNET_BANK_NAME: 'Example Bank',
      CARDNET_ACCOUNT_NAME: 'Card Net LLC',
      CARDNET_ACCOUNT_NUMBER: '12345678',
      CARDNET_ROUTING_NUMBER: '87654321',
    },
  })
  const response = await fetch(`${transferApp.baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paymentMethod: 'bank_transfer',
      customer: { name: 'Sam', email: 'sam@example.com' },
      items: [{ productId: 'birthday-wishes', quantity: 2 }],
    }),
  })
  const result = await response.json()
  const store = JSON.parse(await readFile(transferApp.dataFile, 'utf8'))

  assert.equal(response.status, 201)
  assert.equal(result.order.total, 12)
  assert.equal(result.order.items[0].unitPrice, 6)
  assert.equal(result.order.status, 'awaiting_transfer')
  assert.equal(result.order.paymentMethod, 'bank_transfer')
  assert.equal(result.bankTransfer.reference, result.order.id)
  assert.equal(result.bankTransfer.accountNumber, '12345678')
  assert.equal(store.orders[0].id, result.order.id)
})

test('rejects an unconfigured bank transfer instead of claiming to take payment', async () => {
  const response = await fetch(`${app.baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paymentMethod: 'bank_transfer',
      customer: { name: 'Sam', email: 'sam@example.com' },
      items: [{ productId: 'birthday-wishes', quantity: 1 }],
    }),
  })
  const result = await response.json()

  assert.equal(response.status, 503)
  assert.match(result.error, /not configured/)
})

test('creates hosted Stripe checkout with server-calculated prices and verifies payment', async () => {
  let checkoutParameters
  const checkoutApp = await startTestServer({
    env: {
      STRIPE_SECRET_KEY: 'sk_test_private',
      CARDNET_PUBLIC_URL: 'https://cardnet.example',
    },
    fetchImpl: async (input, options = {}) => {
      assert.equal(options.headers.Authorization, 'Bearer sk_test_private')
      if (String(input).endsWith('/checkout/sessions')) {
        checkoutParameters = new URLSearchParams(options.body)
        return Response.json({
          id: 'cs_test_order123',
          url: 'https://checkout.stripe.com/c/pay/cs_test_order123',
        })
      }
      assert.equal(String(input), 'https://api.stripe.com/v1/checkout/sessions/cs_test_order123')
      return Response.json({
        id: 'cs_test_order123',
        metadata: { order_id: checkoutParameters.get('client_reference_id') },
        client_reference_id: checkoutParameters.get('client_reference_id'),
        currency: 'usd',
        amount_total: 1200,
        payment_status: 'paid',
      })
    },
  })
  const response = await fetch(`${checkoutApp.baseUrl}/api/checkout/card`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: { name: 'Sam', email: 'sam@example.com' },
      items: [{ productId: 'birthday-wishes', quantity: 2, price: 0.01 }],
    }),
  })
  const result = await response.json()
  const storeBeforeVerification = JSON.parse(await readFile(checkoutApp.dataFile, 'utf8'))
  const verificationResponse = await fetch(`${checkoutApp.baseUrl}/api/orders/payment-status?session_id=cs_test_order123`)
  const verification = await verificationResponse.json()
  const storeAfterVerification = JSON.parse(await readFile(checkoutApp.dataFile, 'utf8'))

  assert.equal(response.status, 201)
  assert.equal(result.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_test_order123')
  assert.equal(checkoutParameters.get('line_items[0][price_data][unit_amount]'), '600')
  assert.equal(checkoutParameters.get('line_items[0][quantity]'), '2')
  assert.equal(checkoutParameters.get('payment_method_types[0]'), 'card')
  assert.equal(storeBeforeVerification.orders[0].total, 12)
  assert.equal(storeBeforeVerification.orders[0].status, 'awaiting_payment')
  assert.equal(verificationResponse.status, 200)
  assert.equal(verification.status, 'paid')
  assert.equal(storeAfterVerification.orders[0].status, 'paid')
})

test('does not create card orders if the Stripe Checkout request fails', async () => {
  const checkoutApp = await startTestServer({
    env: { STRIPE_SECRET_KEY: 'sk_test_private' },
    fetchImpl: async () => Response.json({ error: { message: 'provider unavailable' } }, { status: 503 }),
  })
  const response = await fetch(`${checkoutApp.baseUrl}/api/checkout/card`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: { name: 'Sam', email: 'sam@example.com' },
      items: [{ productId: 'birthday-wishes', quantity: 1 }],
    }),
  })
  const result = await response.json()

  assert.equal(response.status, 502)
  assert.match(result.error, /temporarily unavailable/)
  await assert.rejects(readFile(checkoutApp.dataFile, 'utf8'), { code: 'ENOENT' })
})

test('verifies Stripe webhook signatures before marking card orders paid', async () => {
  const webhookSecret = 'whsec_test_secret'
  const webhookApp = await startTestServer({
    env: {
      STRIPE_SECRET_KEY: 'sk_test_private',
      STRIPE_WEBHOOK_SECRET: webhookSecret,
    },
    fetchImpl: async () => Response.json({
      id: 'cs_test_webhook123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_webhook123',
    }),
  })
  const createOrderResponse = await fetch(`${webhookApp.baseUrl}/api/checkout/card`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: { name: 'Sam', email: 'sam@example.com' },
      items: [{ productId: 'birthday-wishes', quantity: 1 }],
    }),
  })
  assert.equal(createOrderResponse.status, 201)
  const { orderId } = await createOrderResponse.json()
  const eventBody = JSON.stringify({
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_webhook123',
        metadata: { order_id: orderId },
        client_reference_id: orderId,
        payment_status: 'paid',
        currency: 'usd',
        amount_total: 600,
      },
    },
  })
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = createHmac('sha256', webhookSecret).update(`${timestamp}.${eventBody}`).digest('hex')
  const rejectedResponse = await fetch(`${webhookApp.baseUrl}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Stripe-Signature': `t=${timestamp},v1=${'0'.repeat(64)}` },
    body: eventBody,
  })
  const acceptedResponse = await fetch(`${webhookApp.baseUrl}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Stripe-Signature': `t=${timestamp},v1=${signature}` },
    body: eventBody,
  })
  const store = JSON.parse(await readFile(webhookApp.dataFile, 'utf8'))

  assert.equal(rejectedResponse.status, 400)
  assert.equal(acceptedResponse.status, 200)
  assert.equal(store.orders[0].id, orderId)
  assert.equal(store.orders[0].status, 'paid')
})

test('sends bounded conversation and product context to the AI provider', async () => {
  let providerRequest
  const assistantApp = await startTestServer({
    env: { OPENAI_API_KEY: 'private-test-key' },
    fetchImpl: async (input, options) => {
      assert.equal(String(input), 'https://api.openai.com/v1/chat/completions')
      assert.equal(options.headers.Authorization, 'Bearer private-test-key')
      providerRequest = JSON.parse(options.body)
      return Response.json({ choices: [{ message: { content: 'A Year More Wonderful is $6.' } }] })
    },
  })
  const response = await fetch(`${assistantApp.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Recommend a birthday card.' }] }),
  })
  const result = await response.json()

  assert.equal(response.status, 200)
  assert.match(result.reply, /A Year More Wonderful/)
  assert.equal(providerRequest.model, 'gpt-4o-mini')
  assert.match(providerRequest.messages[0].content, /A Year More Wonderful/)
  assert.deepEqual(providerRequest.messages.at(-1), { role: 'user', content: 'Recommend a birthday card.' })
})

test('reports unavailable AI chat when its provider key is missing', async () => {
  const response = await fetch(`${app.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
  })
  const result = await response.json()

  assert.equal(response.status, 503)
  assert.match(result.error, /not configured/)
})

test('stores valid contact messages and rejects invalid email addresses', async () => {
  const acceptedResponse = await fetch(`${app.baseUrl}/api/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Lee', email: 'lee@example.com', message: 'Hello Card Net' }),
  })
  const rejectedResponse = await fetch(`${app.baseUrl}/api/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Lee', email: 'not-an-email', message: 'Hello' }),
  })
  const store = JSON.parse(await readFile(app.dataFile, 'utf8'))

  assert.equal(acceptedResponse.status, 201)
  assert.equal(rejectedResponse.status, 400)
  assert.equal(store.messages.length, 1)
  assert.equal(store.messages[0].message, 'Hello Card Net')
})

test('rejects invalid order items', async () => {
  const transferApp = await startTestServer({
    env: {
      CARDNET_BANK_NAME: 'Example Bank',
      CARDNET_ACCOUNT_NAME: 'Card Net LLC',
      CARDNET_ACCOUNT_NUMBER: '12345678',
      CARDNET_ROUTING_NUMBER: '87654321',
    },
  })
  const response = await fetch(`${transferApp.baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paymentMethod: 'bank_transfer',
      customer: { name: 'Sam', email: 'sam@example.com' },
      items: [{ productId: 'not-a-product', quantity: 1 }],
    }),
  })
  const result = await response.json()

  assert.equal(response.status, 400)
  assert.match(result.error, /not available/)
})
