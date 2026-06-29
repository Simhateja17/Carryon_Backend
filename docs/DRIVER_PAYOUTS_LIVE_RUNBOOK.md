# Driver Payouts Live Runbook

## Stripe Dashboard prerequisites

- Confirm the Stripe account is in live mode and Connect is enabled.
- Confirm the platform business profile is verified.
- Confirm Stripe-hosted connected account onboarding is enabled for Express-dashboard accounts.
- Confirm drivers can request the `transfers` capability during onboarding.

## Environment variable swaps

- Swap `STRIPE_SECRET_KEY` from `sk_test_*` to `sk_live_*`.
- Swap `STRIPE_PUBLISHABLE_KEY` from `pk_test_*` to `pk_live_*`.
- Set `ALLOW_LIVE_DRIVER_PAYOUTS=true` only after the live webhook endpoint is registered and verified.
- Keep `STRIPE_CONNECT_RETURN_URL=carryon-driver://stripe-connect/return`.
- Keep `STRIPE_CONNECT_REFRESH_URL=carryon-driver://stripe-connect/refresh`.
- Keep `STRIPE_CONNECT_COUNTRY=MY` unless the operating country changes.
- Keep `STRIPE_CURRENCY=myr` unless finance confirms a currency migration.

## Webhook endpoint registration

- Register the live webhook URL in Stripe Dashboard: `https://api.carryon.example/api/stripe/webhook`.
- Copy the live signing secret into `STRIPE_WEBHOOK_SECRET`.
- Subscribe at minimum to:
  - `account.updated`
  - `payout.paid`
  - `payout.failed`
  - `payment_intent.succeeded`
  - `payment_intent.payment_failed`
  - `payment_intent.canceled`
  - `charge.refunded`

## Database hygiene

- Existing test-mode `acct_*` records on drivers are orphaned after the live flip. Leave them in place.
- Drivers who re-open payout setup after the flip should receive fresh live `acct_*` IDs.
- Do not bulk-clear driver Stripe fields during the live switchover.

## Monitoring

- Watch `GET /api/admin/revenue/issues` for:
  - `failedPayouts`
  - `stalePendingPayouts`
- Investigate any stale pending payout older than five minutes.
- Check backend logs for:
  - `[driver-payout-webhook] payout.paid for unknown payout id`
  - `[driver-payout-webhook] payout.failed for unknown payout id`
  - `[driver-payout-reconciliation] warning: idempotency key reused: driver-withdrawal-<id>`

## Idempotency key monitoring

- Reconciliation uses `driver-withdrawal-<driverPayout.id>` as the Stripe idempotency key.
- A reused-key warning means the retry path recovered a transfer creation attempt. Confirm exactly one Stripe transfer exists for that payout ID.
- If warnings increase, pause live driver payouts by setting `ALLOW_LIVE_DRIVER_PAYOUTS=false`.

## Manual rollback plan

- Set `ALLOW_LIVE_DRIVER_PAYOUTS=false` to stop new live payout account creation, onboarding links, and withdrawals.
- In-progress live transfers and bank payouts continue through Stripe; do not delete those rows.
- If a full revert is required, swap `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` back to test keys after new live payout requests are locked.
- Keep the webhook endpoint active during rollback until all in-progress live payouts reach `COMPLETED` or `FAILED`.

## Driver communications

- Drivers who onboarded in test mode must onboard again after the live flip.
- Send a notice before enabling live mode that Wallet may show "Set up payouts" again.
- Direct drivers to Wallet > Set up payouts for the Stripe-hosted onboarding flow.
