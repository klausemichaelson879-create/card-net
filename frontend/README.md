# Card Net

Card Net is a small Vite storefront with a Node API for its catalog, orders, and contact form.

## Run locally

1. Copy `.env.example` to `.env`.
2. Add your payment-provider and AI credentials to `.env` as needed. Keep `.env` private; it is ignored by Git.
3. Run `npm install` if dependencies have not already been installed.
4. Run `npm run dev` and open the local URL printed by Vite.

## Publish a free preview on Render

1. Create a GitHub repository that you control. A private repository is recommended. Push the `frontend` folder to it; do not include `.env` or provider secrets.
2. In Render, choose **New → Blueprint**, connect that repository, and select the root-level `render.yaml`.
3. Review and deploy the free web service. The free blueprint is read-only: customers can browse the store, but checkout and contact submissions are disabled, and no order/contact data is stored. Free instances may sleep when idle.
4. Open the assigned `https://...onrender.com` URL and confirm `/api/health` responds with `{"status":"ok"}`.

The Render blueprint builds and serves the Vite assets and Node API from the same service. Render's free service has ephemeral storage; do not switch off `CARDNET_READ_ONLY` for real orders. Enable sales only after arranging durable order storage and reviewing any hosting/provider fees.

Payment and AI integrations are disabled until their credentials and account details are configured. The site never collects or stores card numbers: card payments use Stripe's hosted Checkout page. Start with a Stripe test-mode secret key. Configure the public website URL in `CARDNET_PUBLIC_URL`, and register `POST /api/webhooks/stripe` as a Stripe webhook endpoint for `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Put that endpoint's signing secret in `STRIPE_WEBHOOK_SECRET`; signed webhook events and the success-page return are both verified before an order is marked paid.

For bank transfer, fill in the bank name, account name, account number, and either the routing number or IBAN. Those details are shown to customers during checkout. Bank-transfer orders remain pending until the transfer is received and verified manually.

The shopping assistant sends the latest chat messages and the public product catalog to the OpenAI API from the backend. Its API key is only read by the server. Do not put provider credentials in frontend code.

## Checks

- `npm run build` builds the storefront.
- `npm run test:api` runs the backend API tests.
- `npm run server` runs only the API; `npm run dev` starts the API and Vite together; `npm start` serves the production build and API together.
