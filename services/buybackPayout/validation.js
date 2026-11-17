import crypto from 'crypto'
import { HsbcPaymentConfigurationError } from '../../integrations/hsbc/hsbcPaymentInitiationClient.js'

const ROLE_SUPER_ADMIN = 'Super Admin'
const ROLE_COMPANY_ADMIN = 'Company Admin'
const ROLE_MANAGER = 'Manager'
const ROLE_ADMIN_MANAGER = 'Admin Manager'
const ADMIN_ROLES = new Set([
  ROLE_SUPER_ADMIN,
  ROLE_COMPANY_ADMIN,
  ROLE_ADMIN_MANAGER,
])
const APPROVER_ROLES = new Set([
  ROLE_SUPER_ADMIN,
  ROLE_COMPANY_ADMIN,
  ROLE_MANAGER,
  ROLE_ADMIN_MANAGER,
])
const UPI_VPA_PATTERN = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/
const ACCOUNT_PATTERN = /^\d{6,20}$/
const ACCOUNT_HOLDER_PATTERN = /^[\p{L}][\p{L}\p{M} .'-]{1,99}$/u
const SUPPORTED_HSBC_MODES = ['HSBC_UPI', 'HSBC_IMPS', 'HSBC_NEFT']
const TOKEN_BYTES = 32
// A store with no ceiling of its own is not unlimited: the global default
// applies, overridable with DEFAULT_STORE_PAYOUT_CEILING.
const FALLBACK_STORE_PAYOUT_CEILING = 50000

const isImpsPayout = (payout) => payout?.provider === 'HSBC_IMPS'
const isNeftPayout = (payout) => payout?.provider === 'HSBC_NEFT'
const isBankTransferPayout = (payout) =>
  isImpsPayout(payout) || isNeftPayout(payout)

const tokenHash = (token) =>
  crypto.createHash('sha256').update(token).digest('hex')

const vpaHash = (vpa) =>
  crypto
    .createHmac(
      'sha256',
      process.env.PAYOUT_VPA_HASH_KEY ||
        process.env.JWT_SECERET ||
        (() => {
          throw new Error('PAYOUT_VPA_HASH_KEY is not configured')
        })(),
    )
    .update(vpa.toLowerCase())
    .digest('hex')

const identityHash = (value) =>
  crypto
    .createHmac(
      'sha256',
      process.env.PAYOUT_FRAUD_HASH_KEY ||
        process.env.PAYOUT_VPA_HASH_KEY ||
        process.env.JWT_SECERET ||
        (() => {
          throw new Error('PAYOUT_FRAUD_HASH_KEY is not configured')
        })(),
    )
    .update(String(value || '').trim().toLowerCase())
    .digest('hex')

const maskVpa = (vpa) => {
  const [name, handle] = vpa.split('@')
  const visible = name.slice(0, Math.min(3, name.length))
  return `${visible}${'*'.repeat(Math.max(3, name.length - visible.length))}@${handle}`
}

const publicPayout = (payout) => ({
  id: payout._id,
  amount: payout.amount,
  currency: payout.currency,
  provider: payout.provider,
  status: payout.status,
  statusMessage: payout.statusMessage,
  customerLinkExpiresAt: payout.customerLinkExpiresAt,
  beneficiaryVpaMasked: payout.beneficiaryVpaMasked,
  beneficiaryAccountMasked: payout.beneficiaryAccountMasked,
  approvalRequired: payout.approval?.required,
  approvalStatus: payout.approval?.status,
  providerTransactionRrn: payout.providerTransactionRrn,
  paidAt: payout.paidAt,
  receiptUrl: payout.receiptUrl,
  receiptState: payout.receiptState,
})

const paymentLinkForToken = (token) => {
  const baseUrl =
    process.env.PAYOUT_CUSTOMER_APP_URL ||
    `${process.env.DOMAIN || 'http://localhost:5173'}/payout`
  return `${baseUrl.replace(/\/$/, '')}/${token}`
}

const numericReference = () =>
  `${Date.now()}${crypto.randomInt(100000, 1000000)}`

const numericEnquiryReference = () =>
  `${Date.now()}${crypto.randomInt(100, 1000)}`

// Validate and normalise a beneficiary bank account + IFSC. Pure.
export const validateBankDetails = ({ accountNumber, ifsc, accountName }) => {
  const account = String(accountNumber || '').replace(/\s/g, '')
  const code = String(ifsc || '').trim().toUpperCase()
  const holderName = String(accountName || '').trim().replace(/\s+/g, ' ')
  if (!ACCOUNT_PATTERN.test(account)) {
    throw new PayoutBusinessError('Enter a valid bank account number')
  }
  if (!IFSC_PATTERN.test(code)) {
    throw new PayoutBusinessError('Enter a valid IFSC code')
  }
  if (!ACCOUNT_HOLDER_PATTERN.test(holderName)) {
    throw new PayoutBusinessError('Enter a valid account holder name')
  }
  return { accountNumber: account, ifsc: code, accountName: holderName }
}

export const validateApprovalDecision = ({ approved, remarks }) => {
  if (typeof approved !== 'boolean') {
    throw new PayoutBusinessError('approved must be true or false')
  }
  const normalizedRemarks = String(remarks || '').trim()
  if (!approved && !normalizedRemarks) {
    throw new PayoutBusinessError('Rejection remark is required')
  }
  if (normalizedRemarks.length > 250) {
    throw new PayoutBusinessError('Approval remarks cannot exceed 250 characters')
  }
  return { approved, remarks: normalizedRemarks }
}

export const maskAccount = (accountNumber) => {
  const value = String(accountNumber || '')
  return value.length <= 4
    ? value
    : `${'*'.repeat(value.length - 4)}${value.slice(-4)}`
}

export class PayoutBusinessError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.name = 'PayoutBusinessError'
    this.statusCode = statusCode
  }
}

// A bank status enquiry can fail because the client was never configured,
// because HSBC has not enabled the endpoint, or because the call itself failed.
// One shared message for all three makes a setup gap indistinguishable from a
// real payment problem, so classify it. Pure.
export const classifyBankEnquiryFailure = (error) => {
  if (error instanceof HsbcPaymentConfigurationError) {
    return {
      outcome: 'STATUS_NOT_CONFIGURED',
      message:
        'The HSBC payment integration is not configured on this environment, so the status could not be checked. Do not retry the payment; contact support.',
    }
  }
  if (error?.status === 404) {
    return {
      outcome: 'STATUS_ENDPOINT_UNAVAILABLE',
      message:
        'HSBC status enquiry is currently unavailable. Do not retry the payment; check again after HSBC enables the enquiry API.',
    }
  }
  if (error?.status === 401 || error?.status === 403) {
    return {
      outcome: 'STATUS_AUTH_REJECTED',
      message:
        'HSBC rejected the status enquiry credentials. Do not retry the payment; contact support.',
    }
  }
  return {
    outcome: 'STATUS_TRANSPORT_ERROR',
    message:
      'HSBC could not confirm the payment status. Do not retry the payment; check again later.',
  }
}

// A stored ceiling of 0 means the store has no ceiling of its own, so the
// global default applies. Pure.
export const resolveStorePayoutCeiling = (configuredCeiling) => {
  const stored = Number(configuredCeiling || 0)
  if (Number.isFinite(stored) && stored > 0) {
    return stored
  }
  const configured = String(
    process.env.DEFAULT_STORE_PAYOUT_CEILING ?? '',
  ).trim()
  const globalDefault = Number(configured)
  return configured !== '' &&
    Number.isFinite(globalDefault) &&
    globalDefault >= 0
    ? globalDefault
    : FALLBACK_STORE_PAYOUT_CEILING
}

// The block message deliberately omits the ceiling value: the sales person is
// not meant to learn the store's authorised limit. Pure.
export const assertWithinPayoutCeiling = (amount, payoutCeiling) => {
  const ceiling = Number(payoutCeiling || 0)
  if (ceiling > 0 && Number(amount) > ceiling) {
    throw new PayoutBusinessError(
      'This payout exceeds the authorised ceiling for this store. Contact your Company Admin or Super Admin to raise the limit.',
      409,
    )
  }
}

export {
  ROLE_SUPER_ADMIN,
  ROLE_COMPANY_ADMIN,
  ROLE_MANAGER,
  ROLE_ADMIN_MANAGER,
  ADMIN_ROLES,
  APPROVER_ROLES,
  UPI_VPA_PATTERN,
  SUPPORTED_HSBC_MODES,
  TOKEN_BYTES,
  isImpsPayout,
  isNeftPayout,
  isBankTransferPayout,
  tokenHash,
  vpaHash,
  identityHash,
  maskVpa,
  publicPayout,
  paymentLinkForToken,
  numericReference,
  numericEnquiryReference,
}
