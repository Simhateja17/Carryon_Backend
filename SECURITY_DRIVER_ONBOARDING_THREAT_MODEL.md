# Driver Onboarding and Admin Review Threat Model

## Scope

This covers the final driver onboarding submission path and the admin review surface:

- Driver app submits 13-step onboarding data through `PUT /api/driver/onboarding`.
- Admin panel reads pending submissions through `/api/admin/drivers/onboarding-queue`.
- Admin panel reviews driver detail, documents, verification status, and masked PII.
- Legacy unverified drivers without an aggregate submission timestamp are still review candidates.

## Assets

- Driver identity data: MyKad, passport, PLKS, driver license, address, emergency contact.
- Financial data: bank account number, DuitNow ID, TNG eWallet ID, tax IDs.
- Private document objects in the `driver-documents` bucket.
- Verification decisions and audit logs.

## Trust Boundaries

- Driver endpoints trust only the authenticated driver JWT and the server-side `req.driver`.
- Admin endpoints require the admin API key plus signed admin-panel assertion.
- Storage object paths are untrusted input and must be proven to belong to the authenticated driver.
- Admin UI receives masked PII by default; raw values require a separate audited reveal request.

## Threats and Controls

| Threat | Control |
| --- | --- |
| Driver submits another driver's document path | `submitDriverOnboarding` rejects paths that do not match the authenticated driver's storage prefix. |
| Driver sends public URLs or forged document locations | Aggregate submit rejects HTTP URLs and only accepts storage object paths. |
| Malformed onboarding payload creates partial state | Aggregate submit validates the full payload and persists profile, vehicle, documents, snapshot, and audit event inside one transaction. |
| Admin detail page leaks sensitive numbers by default | Admin driver detail returns masked PII metadata only. |
| Admin reveals PII without accountability | `POST /api/admin/drivers/:id/pii/reveal` requires a field and reason, returns one field only, and records `DRIVER_PII_REVEALED`. |
| Broad admin proxy route permits unsafe mutations | Admin proxy has explicit schema validation for document review, verification, and PII reveal payloads. |
| Document previews expose permanent URLs | Admin detail signs private object paths with short-lived Supabase signed URLs. |
| Review queue hides legacy unverified drivers | The admin review module selects by reviewable verification status, not only by aggregate submission timestamp. |

## Verification

- `src/services/__tests__/driverOnboarding.test.js` covers aggregate validation, document path rejection, transaction writes, snapshot creation, and audit creation.
- `src/services/__tests__/adminDriverReview.test.js` covers legacy unverified review candidates and default PII masking.
- Existing admin auth tests cover the signed admin assertion path.
- Backend full test suite passes after adding the onboarding service tests.
