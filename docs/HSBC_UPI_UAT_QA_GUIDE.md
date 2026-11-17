# GREST C2B — HSBC UPI Payout UAT Guide

## 1. Scope

This guide covers the complete merchant-to-customer HSBC UPI payout flow:

1. Store payment-mode configuration.
2. Lead purchase completion.
3. Customer-link delivery.
4. Customer VPA verification.
5. Optional approval.
6. Payout initiation and status enquiry.
7. Lead status, receipt PDF and customer notification.
8. Manual-payment compatibility and negative scenarios.

Current UAT scope is UPI with email notifications. SMS, bank-account payout,
refund/reversal APIs and HSBC callbacks are deferred until HSBC or the message
templates are provided.

The UAT integration uses the real HSBC UAT APIs. It is not mock payment
behavior.

## 2. UAT test data

| Item | Value |
| --- | --- |
| Merchant | RADICAL RETAIL PRIVATE LIMITED |
| HSBC environment | UAT |
| Supported currency | INR |
| HSBC-provided customer test VPA | `7776968905@hsbc` |
| Payment type | `P` |
| Channel | `U` |
| Notification during current UAT | Email |

Merchant credentials must be supplied through the deployment secret manager.
They must not be placed in this document, screenshots, tickets or source
control.

The merchant VPA identifies the onboarded merchant. Do not enter it as the
customer/payee VPA.

## 3. Deployment readiness

Before handing the build to QA:

- Deploy the backend using values based on `.env.uat.example`.
- Set `NODE_ENV=production`.
- Set `HSBC_UPI_MOCK_MODE=false`.
- Set `PAYOUT_FORCE_HSBC_IN_DEVELOPMENT=false`.
- Set `PAYOUT_CUSTOMER_APP_URL` to the QA-accessible frontend `/payout` route.
- Configure MongoDB, email, PDF and S3 settings used by the existing receipt
  flow.
- Configure `PAYOUT_LINK_NOTIFICATION_MODE=SMS`, the MSG91 auth key and
  approved link template `6a6af62f055973017007be53`. Its placeholders are
  `amount`, `device` and `link`. Set `MSG91_PAYOUT_SHORT_URL_ENABLED=true`
  after MSG91 Short URL is enabled and its sender-specific `m.9m.io` CTA has
  been whitelisted on the DLT portal.
- Keep `PAYOUT_SUCCESS_NOTIFICATION_MODE=EMAIL` until the separate
  payout-success SMS template is approved. Success email uses the address
  captured on the lead and falls back to `PAYOUT_NOTIFICATION_EMAIL`.
- Configure `PAYOUT_FRAUD_HASH_KEY` as a separate secret.
- Ensure the frontend points `VITE_REACT_APP_ENDPOINT` to the UAT backend.
- Build the frontend with `npm run build`; production validation remains
  mandatory in this build.

An authenticated user can call:

```http
GET /api/buyback-payouts/configuration-status
```

Expected minimum result:

```json
{
  "success": true,
  "data": {
    "configured": true,
    "baseUrl": "https://upiapi-uat.hsbc.co.in",
    "encryptionMode": "UPIKIT",
    "mockMode": false,
    "notificationMode": "SMS",
    "successNotificationMode": "EMAIL",
    "emailNotificationConfigured": true,
    "linkNotificationConfigured": true,
    "successNotificationConfigured": true,
    "uatReady": true
  }
}
```

## 4. Store configurations

Super Admin must first enable **HSBC UPI Customer Payout** from Company Edit.
The same section configures device cooldown and customer frequency limits.
Then configure the scenarios from Store Edit.

### HSBC without approval

```json
{
  "enabled": true,
  "mode": "HSBC_UPI",
  "approvalEnabled": false,
  "approvalThreshold": 0,
  "payoutCeiling": 50000,
  "customerLinkExpiryMinutes": 30
}
```

### HSBC with approval

```json
{
  "enabled": true,
  "mode": "HSBC_UPI",
  "approvalEnabled": true,
  "approvalThreshold": 100,
  "payoutCeiling": 50000,
  "customerLinkExpiryMinutes": 30
}
```

A threshold of `0` requires approval for every payout. A positive threshold
requires approval when the payout amount is equal to or greater than it.

### Manual payment

```json
{
  "enabled": true,
  "mode": "MANUAL"
}
```

Disabled payout configuration also follows the existing manual flow.

## 5. Primary QA scenario

### UAT-PAY-001 — Successful payout without approval

1. Configure the test store as HSBC without approval.
2. Create and complete a new lead.
3. Confirm the Product Sold page shows the exact payout amount and
   `AWAITING VPA`.
4. Select **Pay Now – Send Customer Link** once.
5. Confirm one email is delivered to the customer email captured on the lead
   and the page says it is waiting for the customer.
6. Open the newest link. Confirm it contains a random token and no customer
   name, phone, email or VPA.
7. Enter `7776968905@hsbc` and select **Verify UPI ID**.
8. Confirm the customer page reports successful verification.
9. Within approximately five seconds, confirm the lead-generator page changes
   to `READY FOR PAYMENT` and displays **Make Payment**.
10. Select **Make Payment** once.
11. Confirm the final status becomes `SUCCESS`.
12. Confirm the lead status becomes `Payment Completed`.
13. Confirm the payout contains an HSBC RRN/order reference.
14. Confirm the receipt PDF is generated and the receipt email is delivered.
15. Confirm the payout-success notification is delivered.

Pass criteria: all steps complete with one payout record, one successful HSBC
payment attempt and no duplicate debit.

## 6. Required UAT scenarios

| ID | Scenario | Steps | Expected result |
| --- | --- | --- | --- |
| UAT-PAY-002 | Invalid VPA | Enter a real/non-UAT VPA | HSBC message such as `VPA not Available`; status remains `AWAITING_VPA`; Make Payment is unavailable |
| UAT-PAY-003 | Invalid VPA format | Enter a value without a valid `name@bank` format | Request rejected before payout; customer can correct it |
| UAT-PAY-004 | Approval below threshold | Enable approval with threshold above payout, then verify VPA | Status becomes `READY_FOR_PAYMENT`; approval is not required |
| UAT-PAY-005 | Approval at threshold | Use payout equal to threshold | Status becomes `PENDING_APPROVAL`; a Store Manager, Company Admin or Super Admin can approve/reject |
| UAT-PAY-006 | Approval above threshold | Use payout above threshold and approve it | Status changes `PENDING_APPROVAL` → `READY_FOR_PAYMENT`; payment can then proceed |
| UAT-PAY-007 | Reject approval | Reject a pending payout | Status becomes `REJECTED`; no Make Payment action and no HSBC debit |
| UAT-PAY-007A | First approver wins | Two eligible approvers act concurrently | First decision succeeds; second receives conflict; only one decision is retained |
| UAT-PAY-007B | Manager store scope | Manager tries assigned and unassigned stores | Assigned-store approval succeeds; unassigned store returns `403` |
| UAT-PAY-008 | Duplicate Pay click | Double-click or send two concurrent pay requests | Only one request claims the payout; the other receives conflict/already-processing behavior |
| UAT-PAY-009 | Delivered-link protection | Try to send the link again before expiry | UI hides resend; API rejects regeneration; delivered link remains valid |
| UAT-PAY-010 | Expired link | Let the configured expiry pass and open/refresh the link | Status becomes `EXPIRED`; old link cannot submit VPA; resend creates one new valid link |
| UAT-PAY-011 | Status unknown/timeout | Exercise the HSBC-agreed timeout case | Status becomes `STATUS_UNKNOWN`; another payment cannot be initiated; Check Status/reconciliation is used |
| UAT-PAY-012 | Status enquiry success | Check an unknown/processing payout | HSBC status is stored; success triggers the receipt exactly once |
| UAT-PAY-013 | Receipt retry | Make receipt delivery fail after confirmed payment, then restore dependency | Payment remains `SUCCESS`; reconciliation retries receipt without a second HSBC payment |
| UAT-PAY-014 | Manual store | Configure `MANUAL` and complete a lead | Existing manual purchase/receipt flow runs; no HSBC payout is created |
| UAT-PAY-014A | Company master disabled | Disable company payout while store remains HSBC-enabled | Existing manual/offline flow runs; no payout link is created |
| UAT-PAY-014B | Store ceiling | Set ceiling below purchase amount | Sell Now is blocked before payout/link creation |
| UAT-PAY-014C | Device cooldown | Reuse a recently sold IMEI within configured days | Sell Now is blocked with device cooldown message |
| UAT-PAY-014D | Customer frequency limit | Exceed configured device count for the same customer phone | Sell Now is blocked with customer selling-limit message |
| UAT-PAY-015 | Unauthorized access | Use a user from another company or an unauthorized role | API returns `403`; no payout data or action is exposed |
| UAT-PAY-016 | Rate limiting | Exceed 30 public-link attempts within 15 minutes | Public endpoint returns `429` |

## 7. Status expectations

| Status | Meaning | Available action |
| --- | --- | --- |
| `AWAITING_VPA` | Customer link can be sent or customer has not verified VPA | Send link only when not already delivered |
| `EXPIRED` | Customer link expired | Resend link |
| `PENDING_APPROVAL` | VPA verified; configured approval required | Approve or reject |
| `READY_FOR_PAYMENT` | VPA verified and approval satisfied | Make Payment |
| `PROCESSING` | Payment request claimed/sent | Check Status; do not retry payment |
| `STATUS_UNKNOWN` | HSBC result not confirmed | Check Status; do not retry payment |
| `FAILED` | HSBC confirmed failure/rejection | Send a new link and collect a fresh UPI ID before another payment |
| `REJECTED` | Administrator rejected approval | No payment |
| `SUCCESS` | HSBC confirmed success | Receipt and success notification |

## 8. API coverage

| Method | Endpoint | Actor |
| --- | --- | --- |
| `POST` | `/api/questionnaires/item-purchased` | Lead generator |
| `GET` | `/api/buyback-payouts/public/:token` | Customer/public |
| `POST` | `/api/buyback-payouts/public/:token/vpa` | Customer/public |
| `GET` | `/api/buyback-payouts/:id` | Authenticated scoped user |
| `POST` | `/api/buyback-payouts/:id/resend-link` | Lead generator/admin |
| `POST` | `/api/buyback-payouts/:id/approval` | Store Manager, Company Admin or Super Admin |
| `POST` | `/api/buyback-payouts/:id/pay` | Lead generator/admin |
| `POST` | `/api/buyback-payouts/:id/status` | Authenticated scoped user |
| `GET` | `/api/buyback-payouts` | Authenticated scoped user |
| `GET` | `/api/buyback-payouts/configuration-status` | Authenticated user |

Import `postman/GREST_HSBC_UPI_UAT.postman_collection.json` for sanitized
requests covering these endpoints. QA must populate `baseUrl`, `authToken`,
`payoutId` and the `customerToken` obtained from the newest delivered link.

## 9. Evidence to attach

For each executed test, QA should record:

- Test-case ID, build/version and execution timestamp.
- Store configuration and payout amount.
- Lead unique code and payout ID.
- Screenshots of each UI status.
- HTTP status and sanitized response body.
- HSBC response code, transaction status, RRN and merchant order number.
- Receipt email and payout notification evidence.
- Confirmation that no secret, full VPA or customer PII appears in logs.

Never attach the merchant key, complete environment files or unmasked customer
data.

## 10. Exit criteria

UAT is ready for sign-off when:

- UAT-PAY-001 through UAT-PAY-010 and UAT-PAY-014 through UAT-PAY-016 pass.
- HSBC supplies or confirms the test conditions needed for timeout/failure
  scenarios UAT-PAY-011 through UAT-PAY-013.
- No duplicate payout is observed.
- Receipt and notification retries do not initiate another payment.
- Manual stores remain backward compatible.
- All defects are closed or formally accepted.
