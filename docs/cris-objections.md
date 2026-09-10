# Cris: objections, pauses and inbound delivery

- A sequence of commercial objections receives at most three distinct replies.
  A further refusal pauses the conversation, keeping its state and customer data.
- Explicit requests to stop skip persuasion and pause immediately. Follow-up
  reminders remain disabled while paused. A request to resume or a valid answer
  resumes the pending step and resets the objection counter.
- Loyalty terms must be consulted after registration, before confirmation.
  Generated or configured loyalty claims are replaced before sending.
- Inbound processing uses a PostgreSQL transaction advisory lock per normalized
  phone number, through DIRECT_URL (or DATABASE_URL). No schema migration.
  Lock contention or processing failures return an error, never a success claiming
  the customer was answered. Delivery then depends on provider retries.
- Responses reference the exact inbound provider ID, not any later outbound
  timestamp. Reply receipt and conversation state are persisted atomically.
- Read receipts have a two-second timeout. Inbound rate limits are per sender and
  instance, not a shared provider IP.

Verification:

```sh
npx tsx --test scripts/cris-interpretation.test.mjs scripts/cris-objections.test.mjs scripts/conversation-loading.test.mjs
npm run build
```

Tests use mocks, not real customer messages or production integrations. Confirm
provider retries and database connectivity in deployment logs after publishing.
Exactly-once WhatsApp delivery is not guaranteed: a network timeout after provider
acceptance, or database failure after sending, can still cause a duplicate retry.
