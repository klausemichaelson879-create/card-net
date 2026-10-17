const productsElement = document.querySelector('#products')
const searchInput = document.querySelector('#search')
const shopMessage = document.querySelector('#shop-message')
const cartDrawer = document.querySelector('#cart-drawer')
const drawerBackdrop = document.querySelector('#drawer-backdrop')
const cartItemsElement = document.querySelector('#cart-items')
const cartEmpty = document.querySelector('#cart-empty')
const checkoutButton = document.querySelector('#checkout-open')
const checkoutDialog = document.querySelector('#checkout-dialog')
const checkoutForm = document.querySelector('#checkout-form')
const checkoutStatus = document.querySelector('#checkout-status')
const checkoutTotal = document.querySelector('#checkout-total')
const checkoutSubmit = document.querySelector('#checkout-submit')
const cardPaymentOption = document.querySelector('#payment-card')
const transferPaymentOption = document.querySelector('#payment-transfer')
const paymentSetupNote = document.querySelector('#payment-setup-note')
const transferDetailsPanel = document.querySelector('#bank-transfer-details')
const assistantPanel = document.querySelector('#assistant-panel')
const assistantMessages = document.querySelector('#assistant-messages')
const assistantForm = document.querySelector('#assistant-form')
const assistantInput = document.querySelector('#assistant-input')
const assistantStatus = document.querySelector('#assistant-status')

let products = []
let activeCategory = 'All'
let cart = loadCart()
let lastFocusedElement = null
let assistantHistory = []
let paymentOptions = { card: { enabled: false }, transfer: { enabled: false }, assistant: { enabled: false }, contact: { enabled: false } }

document.querySelector('#year').textContent = new Date().getFullYear()

function loadCart() {
  try {
    const savedCart = JSON.parse(localStorage.getItem('card-net-cart') || localStorage.getItem('celebrio-cart') || '{}')
    if (!savedCart || typeof savedCart !== 'object' || Array.isArray(savedCart)) return {}
    return Object.fromEntries(
      Object.entries(savedCart).filter(([, quantity]) => Number.isInteger(quantity) && quantity > 0 && quantity <= 10),
    )
  } catch (error) {
    console.warn('Could not restore the saved shopping bag.', error)
    return {}
  }
}

function saveCart() {
  try {
    localStorage.setItem('card-net-cart', JSON.stringify(cart))
  } catch (error) {
    console.warn('Could not save the shopping bag in this browser.', error)
    shopMessage.textContent = 'Your bag is available for this visit, but could not be saved on this device.'
  }
}

function formatPrice(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

function getVisibleProducts() {
  const searchTerm = searchInput.value.trim().toLocaleLowerCase()
  return products.filter((product) => {
    const matchesCategory = activeCategory === 'All' || product.category === activeCategory
    const matchesSearch = !searchTerm || `${product.name} ${product.description} ${product.category}`.toLocaleLowerCase().includes(searchTerm)
    return matchesCategory && matchesSearch
  })
}

function renderProducts() {
  const visibleProducts = getVisibleProducts()
  productsElement.setAttribute('aria-busy', 'false')

  if (!visibleProducts.length) {
    productsElement.innerHTML = '<div class="empty-results"><span aria-hidden="true">✳</span><h3>No little finds just yet.</h3><p>Try another search or browse everything.</p><button class="text-link" type="button" data-reset-filters>Show me everything →</button></div>'
    return
  }

  productsElement.innerHTML = visibleProducts.map((product, index) => `
    <article class="product-card" style="--card-accent: ${escapeHtml(product.accent)}; --card-delay: ${index * 55}ms">
      <div class="product-art ${escapeHtml(product.artStyle)}">
        <span class="product-art-icon" aria-hidden="true">${escapeHtml(product.icon)}</span>
        <span class="product-art-label">${escapeHtml(product.artLabel)}</span>
        <span class="product-art-spark" aria-hidden="true">✳</span>
      </div>
      <div class="product-details">
        <div class="product-category">${escapeHtml(product.category)}</div>
        <h3>${escapeHtml(product.name)}</h3>
        <p>${escapeHtml(product.description)}</p>
        <div class="product-buy">
          <span class="product-price">${formatPrice(product.price)}</span>
          <button class="add-button" type="button" data-add-product="${escapeHtml(product.id)}" aria-label="Add ${escapeHtml(product.name)} to bag">Add to bag <span aria-hidden="true">+</span></button>
        </div>
      </div>
    </article>
  `).join('')
}

function cartEntries() {
  return Object.entries(cart)
    .map(([id, quantity]) => ({ product: products.find((product) => product.id === id), quantity }))
    .filter((entry) => entry.product && entry.quantity > 0)
}

function cartSubtotal() {
  return cartEntries().reduce((sum, entry) => sum + entry.product.price * entry.quantity, 0)
}

function renderCart() {
  const entries = cartEntries()
  const itemCount = entries.reduce((sum, entry) => sum + entry.quantity, 0)
  const subtotal = cartSubtotal()

  document.querySelector('#cart-count').textContent = itemCount
  document.querySelector('#drawer-count').textContent = `(${itemCount})`
  document.querySelector('#cart-total').textContent = formatPrice(subtotal)
  checkoutTotal.textContent = formatPrice(subtotal)
  cartEmpty.hidden = entries.length > 0
  cartItemsElement.hidden = entries.length === 0
  checkoutButton.disabled = entries.length === 0

  cartItemsElement.innerHTML = entries.map(({ product, quantity }) => `
    <article class="cart-item">
      <div class="cart-item-art" style="--card-accent: ${escapeHtml(product.accent)}" aria-hidden="true">${escapeHtml(product.icon)}</div>
      <div class="cart-item-info">
        <h3>${escapeHtml(product.name)}</h3>
        <p>${formatPrice(product.price)}</p>
        <div class="quantity-control" aria-label="Quantity for ${escapeHtml(product.name)}">
          <button type="button" data-quantity="${escapeHtml(product.id)}" data-change="-1" aria-label="Remove one ${escapeHtml(product.name)}">−</button>
          <span>${quantity}</span>
          <button type="button" data-quantity="${escapeHtml(product.id)}" data-change="1" aria-label="Add one ${escapeHtml(product.name)}" ${quantity >= 10 ? 'disabled' : ''}>+</button>
        </div>
      </div>
      <button class="remove-item" type="button" data-remove="${escapeHtml(product.id)}" aria-label="Remove ${escapeHtml(product.name)} from bag">Remove</button>
    </article>
  `).join('')
}

function updateCheckoutButton() {
  const selectedMethod = checkoutForm.elements.paymentMethod.value
  checkoutSubmit.disabled = !selectedMethod
  checkoutSubmit.innerHTML = selectedMethod === 'card'
    ? 'Continue to secure card payment <span aria-hidden="true">→</span>'
    : selectedMethod === 'bank_transfer'
      ? 'Place order &amp; see transfer details <span aria-hidden="true">→</span>'
      : 'Choose a payment method <span aria-hidden="true">→</span>'
}

async function loadPaymentOptions() {
  try {
    const response = await fetch('/api/payment-options')
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Payment options could not be loaded.')
    paymentOptions = result
    const assistantAvailability = document.querySelector('#assistant-availability')
    const assistantOnline = document.querySelector('.assistant-online')
    assistantAvailability.textContent = result.assistant.enabled ? 'Here for whatever you need' : 'AI setup needed'
    assistantOnline.classList.toggle('is-unavailable', !result.assistant.enabled)

    cardPaymentOption.disabled = !result.card.enabled
    transferPaymentOption.disabled = !result.transfer.enabled
    document.querySelector('#card-payment-help').textContent = result.card.enabled
      ? 'Secure checkout powered by Stripe'
      : 'Not configured yet'
    document.querySelector('#transfer-payment-help').textContent = result.transfer.enabled
      ? `Direct transfer to ${result.transfer.details.bankName}`
      : 'Not configured yet'

    const firstAvailable = result.card.enabled ? cardPaymentOption : result.transfer.enabled ? transferPaymentOption : null
    if (firstAvailable && !checkoutForm.elements.paymentMethod.value) firstAvailable.checked = true

    if (!result.card.enabled && !result.transfer.enabled) {
      paymentSetupNote.textContent = 'Online payments are not configured yet. Please contact the store to place your order.'
    } else if (!result.card.enabled || !result.transfer.enabled) {
      paymentSetupNote.textContent = 'Only the payment options shown as available can be used right now.'
    } else {
      paymentSetupNote.textContent = ''
    }
    assistantStatus.textContent = result.assistant.enabled
      ? ''
      : 'To start AI chat, add OPENAI_API_KEY to your frontend/.env file and restart the app.'
    if (!result.contact.enabled) {
      contactForm.querySelectorAll('input, textarea, button').forEach((field) => {
        field.disabled = true
      })
      document.querySelector('#contact-status').textContent = 'Contact messages are disabled on this free preview.'
    }
    updateCheckoutButton()
  } catch (error) {
    console.error('Could not load payment options.', error)
    paymentSetupNote.textContent = 'Payment options could not be loaded. Please close checkout and try again.'
  }
}

function renderBankTransferDetails(order, details) {
  transferDetailsPanel.replaceChildren()
  const heading = document.createElement('h3')
  heading.textContent = 'Your order is ready for transfer'
  const intro = document.createElement('p')
  intro.textContent = 'Send the exact amount below using these bank details. We will process your order after the transfer arrives.'
  const list = document.createElement('dl')
  const rows = [
    ['Bank', details.bankName],
    ['Account name', details.accountName],
    ['Account number', details.accountNumber],
    ...(details.routingNumber ? [['Routing number', details.routingNumber]] : []),
    ...(details.iban ? [['IBAN', details.iban]] : []),
    ['Amount', formatPrice(order.total)],
    ['Payment reference', details.reference],
  ]
  for (const [label, value] of rows) {
    const term = document.createElement('dt')
    term.textContent = label
    const description = document.createElement('dd')
    description.textContent = value
    list.append(term, description)
  }
  transferDetailsPanel.append(heading, intro, list)
  transferDetailsPanel.hidden = false
}

function updateCart() {
  saveCart()
  renderCart()
}

function openCart() {
  lastFocusedElement = document.activeElement
  cartDrawer.classList.add('is-open')
  cartDrawer.removeAttribute('inert')
  cartDrawer.setAttribute('aria-hidden', 'false')
  drawerBackdrop.hidden = false
  document.body.classList.add('drawer-open')
  document.querySelector('#cart-close').focus()
}

function closeCart() {
  cartDrawer.classList.remove('is-open')
  cartDrawer.setAttribute('aria-hidden', 'true')
  cartDrawer.setAttribute('inert', '')
  drawerBackdrop.hidden = true
  document.body.classList.remove('drawer-open')
  if (lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus()
}

cartDrawer.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return
  const focusableElements = [...cartDrawer.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])')]
  if (!focusableElements.length) return
  const firstElement = focusableElements[0]
  const lastElement = focusableElements[focusableElements.length - 1]

  if (event.shiftKey && document.activeElement === firstElement) {
    event.preventDefault()
    lastElement.focus()
  } else if (!event.shiftKey && document.activeElement === lastElement) {
    event.preventDefault()
    firstElement.focus()
  }
})

async function loadProducts() {
  productsElement.setAttribute('aria-busy', 'true')
  shopMessage.textContent = 'Finding your little something...'
  try {
    const response = await fetch('/api/products')
    if (!response.ok) throw new Error(`Products could not be loaded (${response.status}).`)
    const result = await response.json()
    if (!Array.isArray(result.products)) throw new Error('The product list returned an unexpected response.')
    products = result.products
    cart = Object.fromEntries(Object.entries(cart).filter(([id]) => products.some((product) => product.id === id)))
    updateCart()
    shopMessage.textContent = `${products.length} thoughtful finds, ready for you.`
    renderProducts()
  } catch (error) {
    console.error('Could not load the product collection.', error)
    shopMessage.innerHTML = 'We could not reach the shop right now. Please try again. <button class="text-link" type="button" data-retry>Try again →</button>'
    productsElement.setAttribute('aria-busy', 'false')
    productsElement.innerHTML = ''
  }
}

document.querySelector('#cart-open').addEventListener('click', openCart)
document.querySelector('#cart-close').addEventListener('click', closeCart)
drawerBackdrop.addEventListener('click', closeCart)
document.querySelector('#continue-shopping').addEventListener('click', closeCart)

document.querySelector('.filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-category]')
  if (!button) return
  activeCategory = button.dataset.category
  document.querySelectorAll('.filter-button').forEach((filter) => {
    const isActive = filter === button
    filter.classList.toggle('active', isActive)
    filter.setAttribute('aria-pressed', String(isActive))
  })
  renderProducts()
})

searchInput.addEventListener('input', renderProducts)

productsElement.addEventListener('click', (event) => {
  const addButton = event.target.closest('[data-add-product]')
  const resetButton = event.target.closest('[data-reset-filters]')
  if (resetButton) {
    activeCategory = 'All'
    searchInput.value = ''
    document.querySelectorAll('.filter-button').forEach((filter) => {
      const isActive = filter.dataset.category === 'All'
      filter.classList.toggle('active', isActive)
      filter.setAttribute('aria-pressed', String(isActive))
    })
    renderProducts()
  }
  if (!addButton) return
  const id = addButton.dataset.addProduct
  const nextQuantity = (cart[id] || 0) + 1
  if (nextQuantity > 10) {
    shopMessage.textContent = 'You can add up to 10 of the same item.'
    return
  }
  cart[id] = nextQuantity
  updateCart()
  shopMessage.textContent = `${products.find((product) => product.id === id).name} added to your bag.`
  addButton.classList.add('added')
  window.setTimeout(() => addButton.classList.remove('added'), 650)
})

shopMessage.addEventListener('click', (event) => {
  if (event.target.closest('[data-retry]')) loadProducts()
})

cartItemsElement.addEventListener('click', (event) => {
  const removeButton = event.target.closest('[data-remove]')
  const quantityButton = event.target.closest('[data-quantity]')
  if (removeButton) delete cart[removeButton.dataset.remove]
  if (quantityButton) {
    const id = quantityButton.dataset.quantity
    const quantity = (cart[id] || 0) + Number(quantityButton.dataset.change)
    if (quantity <= 0) delete cart[id]
    else if (quantity <= 10) cart[id] = quantity
  }
  if (removeButton || quantityButton) updateCart()
})

checkoutButton.addEventListener('click', () => {
  checkoutStatus.textContent = ''
  checkoutStatus.classList.remove('is-error')
  transferDetailsPanel.hidden = true
  loadPaymentOptions()
  checkoutDialog.showModal()
})
document.querySelector('#checkout-close').addEventListener('click', () => checkoutDialog.close())
checkoutDialog.addEventListener('click', (event) => {
  if (event.target === checkoutDialog) checkoutDialog.close()
})

checkoutForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const submitButton = checkoutForm.querySelector('[type="submit"]')
  const paymentMethod = checkoutForm.elements.paymentMethod.value
  if (!paymentMethod) return

  submitButton.disabled = true
  checkoutStatus.classList.remove('is-error')
  checkoutStatus.textContent = paymentMethod === 'card' ? 'Connecting to secure card checkout...' : 'Preparing your bank transfer...'
  const formData = new FormData(checkoutForm)
  const payload = {
    customer: { name: formData.get('name'), email: formData.get('email') },
    items: cartEntries().map(({ product, quantity }) => ({ productId: product.id, quantity })),
  }

  try {
    const response = await fetch(paymentMethod === 'card' ? '/api/checkout/card' : '/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, paymentMethod }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Checkout could not be completed.')

    if (paymentMethod === 'card') {
      if (typeof result.checkoutUrl !== 'string' || !result.checkoutUrl.startsWith('https://checkout.stripe.com/')) {
        throw new Error('The secure card checkout link was invalid.')
      }
      window.location.assign(result.checkoutUrl)
      return
    }

    renderBankTransferDetails(result.order, result.bankTransfer)
    cart = {}
    updateCart()
    checkoutStatus.textContent = `Order ${result.order.id} is awaiting your transfer. Use the reference shown below.`
    checkoutSubmit.disabled = true
  } catch (error) {
    console.error('Could not place order.', error)
    checkoutStatus.classList.add('is-error')
    checkoutStatus.textContent = error.message
  } finally {
    if (!transferDetailsPanel.hidden) submitButton.disabled = true
    else updateCheckoutButton()
  }
})

checkoutForm.addEventListener('change', (event) => {
  if (event.target.name === 'paymentMethod') {
    transferDetailsPanel.hidden = true
    updateCheckoutButton()
  }
})

function setAssistantOpen(open) {
  assistantPanel.classList.toggle('is-open', open)
  assistantPanel.setAttribute('aria-hidden', String(!open))
  if (open) assistantPanel.removeAttribute('inert')
  else assistantPanel.setAttribute('inert', '')
  document.querySelector('#assistant-open').setAttribute('aria-expanded', String(open))
  if (open) assistantInput.focus()
}

function appendChatMessage(role, content) {
  const message = document.createElement('div')
  message.className = `chat-message ${role === 'assistant' ? 'assistant-message' : 'user-message'}`
  message.textContent = content
  assistantMessages.append(message)
  assistantMessages.scrollTop = assistantMessages.scrollHeight
}

async function sendAssistantMessage(value) {
  const content = value.trim()
  if (!content || assistantForm.querySelector('button').disabled) return
  assistantInput.value = ''
  document.querySelector('#assistant-suggestions').hidden = true
  appendChatMessage('user', content)
  assistantHistory.push({ role: 'user', content })
  const sendButton = assistantForm.querySelector('button')
  sendButton.disabled = true
  assistantInput.disabled = true
  assistantStatus.classList.remove('is-error')
  assistantStatus.textContent = 'Thinking...'

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: assistantHistory.slice(-8) }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'The assistant could not reply.')
    assistantHistory.push({ role: 'assistant', content: result.reply })
    assistantHistory = assistantHistory.slice(-8)
    appendChatMessage('assistant', result.reply)
    assistantStatus.textContent = ''
  } catch (error) {
    console.error('Could not get an assistant response.', error)
    assistantHistory.pop()
    assistantStatus.classList.add('is-error')
    assistantStatus.textContent = error.message
    assistantInput.value = content
  } finally {
    sendButton.disabled = false
    assistantInput.disabled = false
    assistantInput.focus()
  }
}

document.querySelector('#assistant-open').addEventListener('click', () => setAssistantOpen(true))
document.querySelector('#assistant-close').addEventListener('click', () => setAssistantOpen(false))
assistantForm.addEventListener('submit', (event) => {
  event.preventDefault()
  sendAssistantMessage(assistantInput.value)
})
document.querySelector('#assistant-suggestions').addEventListener('click', (event) => {
  const prompt = event.target.closest('[data-prompt]')?.dataset.prompt
  if (prompt) sendAssistantMessage(prompt)
})

const contactForm = document.querySelector('#contact-form')
contactForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const status = document.querySelector('#contact-status')
  const submitButton = contactForm.querySelector('[type="submit"]')
  const formData = new FormData(contactForm)
  submitButton.disabled = true
  status.classList.remove('is-error')
  status.textContent = 'Sending your note...'

  try {
    const response = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(formData)),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Your note could not be sent.')
    contactForm.reset()
    status.textContent = 'Thanks for the note. We’ll be in touch soon!'
  } catch (error) {
    console.error('Could not send contact message.', error)
    status.classList.add('is-error')
    status.textContent = error.message
  } finally {
    submitButton.disabled = false
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && cartDrawer.classList.contains('is-open')) closeCart()
  if (event.key === 'Escape' && assistantPanel.classList.contains('is-open')) setAssistantOpen(false)
})

renderCart()
Promise.all([loadProducts(), loadPaymentOptions()]).then(async () => {
  const url = new URL(window.location.href)
  const paymentResult = url.searchParams.get('payment')

  if (paymentResult === 'cancelled') {
    shopMessage.textContent = 'Card checkout was cancelled. Your bag is still saved if you would like to try again.'
  } else if (paymentResult === 'success') {
    const sessionId = url.searchParams.get('session_id')
    if (sessionId) {
      shopMessage.textContent = 'Verifying your card payment...'
      try {
        const response = await fetch(`/api/orders/payment-status?session_id=${encodeURIComponent(sessionId)}`)
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Payment could not be verified.')
        if (result.status === 'paid') {
          cart = {}
          updateCart()
          shopMessage.textContent = `Payment received. Thank you! Your Card Net order ${result.orderId} is confirmed.`
        } else {
          shopMessage.textContent = `Your Card Net order ${result.orderId} is awaiting payment confirmation.`
        }
      } catch (error) {
        console.error('Could not verify the card payment.', error)
        shopMessage.textContent = 'We could not verify your card payment just now. Please contact us before trying to pay again.'
      }
    }
  }

  if (paymentResult) window.history.replaceState(window.history.state, '', window.location.pathname)
})
