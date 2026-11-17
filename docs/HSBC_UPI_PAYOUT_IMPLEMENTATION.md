# HSBC UPI Buyback Payout

## Implemented flow

1. Super Admin enables the company payout master setting and configures
   cooldown/customer-frequency limits. Each store is then configured with
   either `MANUAL` or `HSBC_UPI`, a payout ceiling and optional approval.
2. The existing `item-purchased` API retains the current receipt flow for
   manual stores.
3. For an HSBC-enabled store, `item-purchased` creates one payout record for
   the lead and displays **Pay Now** to the lead generator.
4. **Pay Now** creates and sends a time-limited customer link using the
   configured notification channel. A delivered link cannot be regenerated
   until it expires, preventing accidental invalidation.
5. The customer enters a VPA on the public link. The backend validates it
   through HSBC before storing it encrypted.
6. If the configured approval threshold applies, an administrator must approve
   it. Otherwise it becomes ready immediately.
7. The lead generator or an administrator selects **Make Payment**.
8. The backend submits a `P` payment on channel `U` to HSBC.
9. On confirmed success, the existing receipt PDF and email flow runs and a
   success SMS is sent.
10. A timeout never triggers an automatic second payment. The status enquiry is
   used first, manually or by the five-minute reconciliation job.

## Runtime configuration

Secrets must be stored in the deployment secret manager and must not be
committed to source control.

```dotenv
# Credentials supplied for RADICAL RETAIL PRIVATE LIMITED UAT onboarding
HSBC_UPI_MERCHANT_ID=
HSBC_UPI_MERCHANT_KEY=

# HSBC UAT v3.2
HSBC_UPI_BASE_URL=https://upiapi-uat.hsbc.co.in
HSBC_UPI_VALIDATE_PATH=/upi/api/v2/meValidateVPA
HSBC_UPI_PAY_PATH=/upi/api/v2/mePayRefundApi
HSBC_UPI_STATUS_PATHS=/upi/v2/mePayTransQuery,/upi/api/v2/mePayTransQuery
HSBC_UPI_TIMEOUT_MS=30000
HSBC_UPI_MCC=

# HSBC message protection. UPIKIT uses AES-128-ECB with the hexadecimal
# merchant key, PKCS padding and an uppercase hexadecimal payload.
HSBC_UPI_ENCRYPTION_MODE=UPIKIT
HSBC_UPI_KEY_ENCODING=hex
HSBC_UPI_OUTPUT_ENCODING=hex
# Override only if the HSBC onboarding toolkit specifies another cipher.
# HSBC_UPI_CIPHER=aes-128-ecb
# HSBC_UPI_IV=
# HSBC_UPI_CA_CERT_PATH=
# HSBC_UPI_CLIENT_CERT_PATH=
# HSBC_UPI_CLIENT_KEY_PATH=
# HSBC_UPI_CLIENT_KEY_PASSPHRASE=
# Alternatively, use a PKCS#12 bundle:
# HSBC_UPI_CLIENT_PFX_PATH=
# HSBC_UPI_CLIENT_PFX_PASSPHRASE=

# Public frontend route used in the customer SMS
PAYOUT_CUSTOMER_APP_URL=https://grest.in/payout
PAYOUT_VPA_HASH_KEY=
PAYOUT_FRAUD_HASH_KEY=

# Initial payment link uses the approved MSG91 flow. Success remains email
# until its separate SMS template is approved.
PAYOUT_NOTIFICATION_MODE=EMAIL
PAYOUT_LINK_NOTIFICATION_MODE=SMS
PAYOUT_SUCCESS_NOTIFICATION_MODE=EMAIL
PAYOUT_NOTIFICATION_EMAIL= # fallback when a lead has no valid customer email

MSG91_AUTHKEY=
MSG91_PAYOUT_LINK_TEMPLATE_ID=6a6af62f055973017007be53
MSG91_PAYOUT_SUCCESS_TEMPLATE_ID=
MSG91_PAYOUT_SHORT_URL_ENABLED=true

# Enabled by default outside Lambda
HSBC_PAYOUT_RECONCILIATION_ENABLED=true

# Local developer convenience only. Never enable in UAT or production.
PAYOUT_FORCE_HSBC_IN_DEVELOPMENT=false
```

`PAYOUT_VPA_HASH_KEY` should be a separate random secret. It supports
deterministic duplicate detection without storing a readable VPA.

For isolated application testing without contacting HSBC:

```dotenv
HSBC_UPI_MOCK_MODE=true
HSBC_UPI_MERCHANT_ID=1234567890123456
```

Mock mode must never be enabled in UAT or production.

## Company and store configuration

The company master configuration is controlled only by Super Admin:

```json
{
  "buybackPayoutSettings": {
    "enabled": true,
    "deviceCooldownDays": 30,
    "customerSellLimitCount": 3,
    "customerSellLimitWindowDays": 30
  }
}
```

Set a numeric validation to `0` to disable it. Customer count and window must
both be configured or both be `0`.

The store edit screen writes:

```json
{
  "payoutSettings": {
    "enabled": true,
    "mode": "HSBC_UPI",
    "approvalEnabled": true,
    "approvalThreshold": 10000,
    "payoutCeiling": 50000,
    "customerLinkExpiryMinutes": 30
  }
}
```

When approval is enabled:

- threshold `0` means every payout requires approval;
- otherwise, payouts equal to or above the threshold require approval.
- ceiling `0` means no store ceiling; a positive ceiling blocks a payout above
  that amount before a customer link is created.

## HSBC mapping

| Purpose | HSBC API | Important values |
| --- | --- | --- |
| Customer/payee VPA validation | `meValidateVPA` | `payerVPA`, `pgMerchantID`, unique `meRefNo`; `VE` is accepted |
| Merchant-to-customer payout | `mePayRefundApi` | `paymentType=P`, `channel=U`, `currency=INR`, `beneVPA`, unique `meOrderNo` |
| Status reconciliation | `mePayTransQuery` | merchant ID, order number, enquiry reference and UPI channel |

The status implementation tolerates the two inconsistencies in the supplied
v3.2 document: the UAT status path with or without `/api`, and `payChannel`
versus `channel`. Fallbacks are used only for HTTP 400/404 status enquiries;
the payout initiation itself is never automatically retried.

## Security and correctness controls

- Customer link tokens contain 256 bits of randomness and are stored only as
  SHA-256 hashes.
- Public endpoints are rate limited.
- VPA values are validated by HSBC, encrypted at rest with the existing AES-GCM
  utility, omitted from normal queries, and masked in UI responses.
- One unique payout is allowed per lead.
- An atomic state claim prevents two users from initiating the same payout.
- Company scoping is checked on every authenticated payout operation.
- Only the lead generator or an administrator can initiate payment.
- Store Managers, Company Admins and Super Admins can approve payouts.
- Store Managers can approve only payouts belonging to their assigned stores;
  the first eligible decision wins.
- Approval is atomically resolved by the first eligible approver.
- Device/customer fraud checks use HMAC fingerprints; readable IMEI and phone
  values are not duplicated.
- Provider request/response metadata is retained without logging the VPA or
  merchant key.
- PDF generation and customer/store email occur only after HSBC reports
  `respCode=00` and `transStatus=S`.

## UAT checklist

1. Deploy backend with secret-manager values and `HSBC_UPI_MOCK_MODE=false`.
2. Confirm `GET /api/buyback-payouts/configuration-status` reports
   `configured: true`, UAT base URL, `mockMode: false`,
   `emailNotificationConfigured: true` and `uatReady: true`.
3. Configure one test store for HSBC UPI with a low approval threshold.
4. Configure the company master toggle, fraud limits and the store ceiling.
5. Create a test lead and finish purchase.
6. Select **Pay Now**, confirm a single notification is delivered, and confirm
   the link opens `/payout/{token}` without customer PII in the URL.
7. Validate HSBC's supplied test VPA `7776968905@hsbc`.
8. Confirm threshold approval is enforced.
9. Initiate a ₹1.00 payout and record the HSBC response code, status, RRN and
   order number.
10. Test status enquiry after a deliberately short client timeout.
11. Confirm no second payout can be submitted while status is unknown.
12. Confirm the receipt and success emails are delivered only after success.
13. Test invalid VPA, expired link, rejection, HSBC failure and receipt retry.

## Files

- `integrations/hsbc/hsbcUpiClient.js`
- `models/buybackPayoutModel.js`
- `services/buybackPayoutService.js`
- `services/payoutNotificationService.js`
- `controller/buybackPayoutController.js`
- `routes/buybackPayoutRoute.js`
- `controller/questionnaireController.js`
- `models/storeModel.js`
- `models/leadsModel.js`
- `swagger/buyback-payouts.yaml`
