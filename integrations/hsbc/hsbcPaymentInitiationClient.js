import crypto from 'crypto'
import axios from 'axios'
import { safeLog } from '../../utils/piiMasking.js'
import {
  pgpConfigured,
  encryptSignToBase64,
  decryptVerifyFromBase64,
} from './hsbcPgp.js'

// HSBC Treasury "Payment Initiation" API client — IMPS bank-transfer payout.
//
// Distinct from the UPI merchant client. Uses the P2A (Person-to-Account)
// proprietary XML (XMLPF) for India IMPS: debit account -> beneficiary
// account + IFSC. Auth is Profile ID + Client ID/Secret headers. Endpoints and
// credentials come from the environment; mock mode returns a canned success so
// the flow can be exercised without contacting HSBC.
//
// Sandbox: https://sandbox.corporate-api.hsbc.com/mock/v1
// Real UAT/prod additionally require PGP encryption/signing of ISO-20022
// payloads and (for prod) mutual TLS — wired once HSBC supplies the keys.

const DEFAULT_BASE_URL = 'https://sandbox.corporate-api.hsbc.com/mock/v1'
const DEFAULT_TIMEOUT_MS = 30000

const XML_DECLARATION = '<?xml version="1.0" encoding="utf-8" ?>'

export class HsbcPaymentConfigurationError extends Error {}
export class HsbcPaymentTransportError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'HsbcPaymentTransportError'
    this.status = status
  }
}

const env = (key) => String(process.env[key] ?? '').trim()

export const paymentInitiationConfig = () => ({
  baseUrl: env('HSBC_PAYMENT_BASE_URL') || DEFAULT_BASE_URL,
  profileId: env('HSBC_PAYMENT_PROFILE_ID'),
  clientId: env('HSBC_PAYMENT_CLIENT_ID'),
  clientSecret: env('HSBC_PAYMENT_CLIENT_SECRET'),
  serviceProviderId:
    env('HSBC_PAYMENT_SERVICE_PROVIDER_ID') || env('HSBC_PAYMENT_PROFILE_ID'),
  remitterAccount: env('HSBC_PAYMENT_DEBIT_ACCOUNT'),
  authToken: env('HSBC_PAYMENT_AUTH_TOKEN') || '1234',
  countryCode: env('HSBC_PAYMENT_COUNTRY_CODE') || 'IN',
  timeoutMs: Number(env('HSBC_PAYMENT_TIMEOUT_MS') || DEFAULT_TIMEOUT_MS),
  mockMode: env('HSBC_PAYMENT_MOCK_MODE') === 'true',
  debtorName: env('HSBC_PAYMENT_DEBIT_NAME') || 'GREST',
  debtorBic: env('HSBC_PAYMENT_DEBIT_BIC'),
  // 'none' sends plain XML (works in sandbox); 'pgp' encrypts+signs the payload
  // into the JSON paymentBase64 field (required for real UAT/production).
  payloadEncryption: (env('HSBC_PAYMENT_PAYLOAD_ENCRYPTION') || 'none').toLowerCase(),
  // NEFT codes — placeholders pending HSBC confirmation.
  neftServiceLevel: env('HSBC_NEFT_SERVICE_LEVEL') || 'NURG',
  neftLocalInstrument: env('HSBC_NEFT_LOCAL_INSTRUMENT') || 'NEFT',
})

export const paymentInitiationStatus = () => {
  const cfg = paymentInitiationConfig()
  return {
    provider: 'HSBC_IMPS',
    mockMode: cfg.mockMode,
    configured:
      cfg.mockMode ||
      Boolean(
        cfg.baseUrl &&
          cfg.profileId &&
          cfg.clientId &&
          cfg.clientSecret &&
          cfg.remitterAccount,
      ),
  }
}

const xmlEscape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

// Extract a flat tag value, allowing the namespace prefixes used by pain.002.
export const extractTag = (xml, tag) => {
  const match = new RegExp(
    `<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`,
    'i',
  ).exec(String(xml || ''))
  return match ? match[1].trim() : ''
}

export const generateRequestId = () =>
  `IMPS${Date.now()}${crypto.randomInt(1000, 10000)}`

/**
 * Build the P2A (XMLPF) IMPS payment request. Pure — no I/O.
 */
export const buildImpsPaymentXml = ({
  serviceProviderId,
  requestId,
  remitterAccount,
  beneficiaryIfsc,
  beneficiaryAccount,
  amount,
  authToken = '1234',
}) => {
  if (!remitterAccount) {
    throw new HsbcPaymentConfigurationError('Remitter (debit) account is not configured')
  }
  if (!beneficiaryIfsc || !beneficiaryAccount) {
    throw new HsbcPaymentConfigurationError(
      'Beneficiary account number and IFSC are required',
    )
  }
  return [
    XML_DECLARATION,
    '<p2aRequest>',
    `  <SERVICEPROVIDERID>${xmlEscape(serviceProviderId)}</SERVICEPROVIDERID>`,
    `  <REQUESTID>${xmlEscape(requestId)}</REQUESTID>`,
    '  <REQUESTTYPE>R</REQUESTTYPE>',
    `  <REMITTORACCOUNTNO>${xmlEscape(remitterAccount)}</REMITTORACCOUNTNO>`,
    `  <BENEFICIARYBANKIFSC>${xmlEscape(beneficiaryIfsc)}</BENEFICIARYBANKIFSC>`,
    `  <BENEFICIARYACCOUNTNO>${xmlEscape(beneficiaryAccount)}</BENEFICIARYACCOUNTNO>`,
    `  <AMOUNT>${xmlEscape(amount)}</AMOUNT>`,
    '  <CHANNELID>CDP</CHANNELID>',
    `  <AUTHENTICATIONTOKEN>${xmlEscape(authToken)}</AUTHENTICATIONTOKEN>`,
    '</p2aRequest>',
  ].join('\n')
}

export const buildImpsStatusXml = ({
  requestId,
  remitterAccount,
  amount,
  authToken = '1234',
  merchantId = '',
}) =>
  [
    XML_DECLARATION,
    '<p2aRequest>',
    `  <REQUESTID>${xmlEscape(requestId)}</REQUESTID>`,
    '  <REQUESTTYPE>E</REQUESTTYPE>',
    `  <REMITTORACCOUNTNO>${xmlEscape(remitterAccount)}</REMITTORACCOUNTNO>`,
    `  <AMOUNT>${xmlEscape(amount)}</AMOUNT>`,
    '  <CHANNELID>CDP</CHANNELID>',
    `  <AUTHENTICATIONTOKEN>${xmlEscape(authToken)}</AUTHENTICATIONTOKEN>`,
    `  <MERCHANTID>${xmlEscape(merchantId)}</MERCHANTID>`,
    '</p2aRequest>',
  ].join('\n')

/**
 * Parse a P2A response (or a JSON PaymentResponse). Pure. `success` is true only
 * on RESPONSECODE '00' (P2A) or an accepted/settled ISO-20022 status.
 */
export const parseP2aResponse = (data) => {
  const raw = typeof data === 'string' ? data : JSON.stringify(data || {})
  // JSON PaymentResponse fallback (ISO-20022 flow).
  if (typeof data === 'object' && data && data.statusCode) {
    const accepted = ['ACCP', 'ACSP', 'ACSC', 'ACTC', 'RCVD'].includes(
      data.statusCode,
    )
    return {
      responseCode: data.statusCode,
      responseDescription: data.statusDesc || '',
      rrn: '',
      beneficiaryName: '',
      transactionDateTime: '',
      success: accepted,
    }
  }
  const responseCode = extractTag(raw, 'RESPONSECODE')
  return {
    responseCode,
    responseDescription: extractTag(raw, 'RESPONSEDESCRIPTION'),
    rrn: extractTag(raw, 'RRN'),
    beneficiaryName: extractTag(raw, 'BENEFICIARYNAME'),
    transactionDateTime: extractTag(raw, 'TRANSACTIONDATETIME'),
    success: responseCode === '00',
  }
}

// ---------------------------------------------------------------------------
// NEFT (ISO-20022 pain.001 credit transfer)
// ---------------------------------------------------------------------------
// NEFT is not a distinct payment-type in the spec enum; it is a domestic
// account credit transfer. The service-level / local-instrument codes below are
// configurable and default to placeholders pending HSBC confirmation. Real
// sending additionally requires the payload to be PGP-encrypted/signed (the
// `paymentBase64` flow) — deferred until the HSBC PGP key is provisioned.

const iso = (date) => {
  const d = date instanceof Date ? date : new Date(date)
  return {
    dateTime: d.toISOString().replace(/\.\d{3}Z$/, ''),
    date: d.toISOString().slice(0, 10),
  }
}

// Classify an ISO-20022 status into the payout lifecycle. NEFT settles in
// batches, so an accepted status is "processing", not final success.
export const classifyIsoStatus = (statusCode) => {
  const code = String(statusCode || '').toUpperCase()
  if (code === 'ACSC') {
    return 'SUCCESS'
  }
  // RJCT is the only definitive rejection. PART (partially accepted) is NOT a
  // failure: treating it as failed would allow a re-payment on an in-flight
  // transfer and risk double payment, so it is handled as still-processing and
  // left for reconciliation.
  if (code === 'RJCT') {
    return 'FAILED'
  }
  if (['ACTC', 'ACCP', 'ACSP', 'RCVD', 'PDNG', 'ACWC', 'PART'].includes(code)) {
    return 'PROCESSING'
  }
  return 'UNKNOWN'
}

/**
 * Build a pain.001.001.03 Customer Credit Transfer for a NEFT payout. Pure.
 * The beneficiary IFSC is carried as the creditor agent clearing-system member
 * id (India convention).
 */
export const buildNeftPaymentXml = ({
  initiatingPartyId,
  messageId,
  debtorName,
  debtorAccount,
  debtorBic = '',
  beneficiaryName,
  beneficiaryAccount,
  beneficiaryIfsc,
  amount,
  remittanceInfo = '',
  serviceLevel = 'NURG',
  localInstrument = 'NEFT',
  now = new Date(),
}) => {
  if (!debtorAccount) {
    throw new HsbcPaymentConfigurationError('Remitter (debit) account is not configured')
  }
  if (!beneficiaryIfsc || !beneficiaryAccount) {
    throw new HsbcPaymentConfigurationError(
      'Beneficiary account number and IFSC are required',
    )
  }
  const { dateTime, date } = iso(now)
  const debtorAgent =
    debtorBic
      ? `<BIC>${xmlEscape(debtorBic)}</BIC>`
      : '<Othr><Id>HSBC</Id></Othr>'
  return [
    XML_DECLARATION,
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">',
    '  <CstmrCdtTrfInitn>',
    '    <GrpHdr>',
    `      <MsgId>${xmlEscape(messageId)}</MsgId>`,
    `      <CreDtTm>${dateTime}</CreDtTm>`,
    '      <NbOfTxs>1</NbOfTxs>',
    `      <InitgPty><Id><OrgId><Othr><Id>${xmlEscape(initiatingPartyId)}</Id></Othr></OrgId></Id></InitgPty>`,
    '    </GrpHdr>',
    '    <PmtInf>',
    `      <PmtInfId>${xmlEscape(messageId)}</PmtInfId>`,
    '      <PmtMtd>TRF</PmtMtd>',
    `      <PmtTpInf><SvcLvl><Cd>${xmlEscape(serviceLevel)}</Cd></SvcLvl><LclInstrm><Cd>${xmlEscape(localInstrument)}</Cd></LclInstrm></PmtTpInf>`,
    `      <ReqdExctnDt>${date}</ReqdExctnDt>`,
    `      <Dbtr><Nm>${xmlEscape(debtorName || 'GREST')}</Nm></Dbtr>`,
    `      <DbtrAcct><Id><Othr><Id>${xmlEscape(debtorAccount)}</Id></Othr></Id><Ccy>INR</Ccy></DbtrAcct>`,
    `      <DbtrAgt><FinInstnId>${debtorAgent}</FinInstnId></DbtrAgt>`,
    '      <CdtTrfTxInf>',
    `        <PmtId><InstrId>${xmlEscape(messageId)}</InstrId><EndToEndId>${xmlEscape(messageId)}</EndToEndId></PmtId>`,
    `        <Amt><InstdAmt Ccy="INR">${xmlEscape(amount)}</InstdAmt></Amt>`,
    `        <CdtrAgt><FinInstnId><ClrSysMmbId><MmbId>${xmlEscape(beneficiaryIfsc)}</MmbId></ClrSysMmbId></FinInstnId></CdtrAgt>`,
    `        <Cdtr><Nm>${xmlEscape(beneficiaryName || 'Beneficiary')}</Nm></Cdtr>`,
    `        <CdtrAcct><Id><Othr><Id>${xmlEscape(beneficiaryAccount)}</Id></Othr></Id></CdtrAcct>`,
    `        <RmtInf><Ustrd>${xmlEscape(remittanceInfo || messageId)}</Ustrd></RmtInf>`,
    '      </CdtTrfTxInf>',
    '    </PmtInf>',
    '  </CstmrCdtTrfInitn>',
    '</Document>',
  ].join('\n')
}

const impsHeaders = (cfg, requestId) => ({
  'Content-Type': 'application/xml',
  'x-hsbc-profile-id': cfg.profileId,
  'x-hsbc-client-id': cfg.clientId,
  'x-hsbc-client-secret': cfg.clientSecret,
  'x-payload-type': 'XMLPF',
  'x-hsbc-payment-type': 'IMPSRTP',
  'x-hsbc-country-code': cfg.countryCode,
  'x-hsbc-unique-ref-id': requestId,
})

const assertConfigured = (cfg) => {
  if (!cfg.baseUrl || !cfg.profileId || !cfg.clientId || !cfg.clientSecret) {
    throw new HsbcPaymentConfigurationError(
      'HSBC Payment Initiation is not configured (set HSBC_PAYMENT_BASE_URL, PROFILE_ID, CLIENT_ID, CLIENT_SECRET)',
    )
  }
}

const mockResult = (requestId) => ({
  requestId,
  responseCode: '00',
  responseDescription: 'Successful Transaction (mock)',
  rrn: `MOCK${Date.now()}`.slice(0, 12),
  beneficiaryName: 'MOCK BENEFICIARY',
  transactionDateTime: '20200101000000',
  success: true,
  mock: true,
})

// Build the request body + headers, applying PGP encrypt/sign when enabled.
const buildBodyAndHeaders = async (cfg, xml, headers) => {
  if (cfg.payloadEncryption === 'pgp' && pgpConfigured()) {
    const paymentBase64 = await encryptSignToBase64(xml)
    return {
      body: { paymentBase64 },
      headers: { ...headers, 'Content-Type': 'application/json' },
    }
  }
  return { body: xml, headers }
}

// Decrypt a PGP responseBase64 (if present + keys configured) to surface the RRN.
// The sandbox returns a canned placeholder, so failures are ignored.
const decryptedResponseFields = async (data) => {
  const b64 = data && typeof data === 'object' ? data.responseBase64 : ''
  if (!b64 || !pgpConfigured()) {
    return {}
  }
  try {
    const { text } = await decryptVerifyFromBase64(b64)
    return {
      rrn: extractTag(text, 'RRN') || extractTag(text, 'AcctSvcrRef') || '',
      decryptedResponse: text,
    }
  } catch {
    return {}
  }
}

const post = async (cfg, path, xml, requestId) => {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
  try {
    const { body, headers } = await buildBodyAndHeaders(
      cfg,
      xml,
      impsHeaders(cfg, requestId),
    )
    const response = await axios.post(url, body, {
      timeout: cfg.timeoutMs,
      headers,
    })
    return { data: response.data, httpStatus: response.status }
  } catch (error) {
    safeLog.error('HSBC Payment Initiation request failed', {
      path,
      message: error.message,
    })
    throw new HsbcPaymentTransportError(
      `HSBC Payment Initiation transport error: ${error.message}`,
      error.response?.status,
    )
  }
}

/**
 * Initiate an IMPS payout to a beneficiary bank account.
 */
export const initiateImpsPayout = async ({
  beneficiaryIfsc,
  beneficiaryAccount,
  amount,
  requestId,
}) => {
  const cfg = paymentInitiationConfig()
  const reqId = requestId || generateRequestId()
  const xml = buildImpsPaymentXml({
    serviceProviderId: cfg.serviceProviderId,
    requestId: reqId,
    remitterAccount: cfg.remitterAccount,
    beneficiaryIfsc,
    beneficiaryAccount,
    amount,
    authToken: cfg.authToken,
  })
  if (cfg.mockMode) {
    return mockResult(reqId)
  }
  assertConfigured(cfg)
  const { data, httpStatus } = await post(
    cfg,
    'payments/instant-settlement',
    xml,
    reqId,
  )
  return {
    requestId: reqId,
    httpStatus,
    ...parseP2aResponse(data),
    ...(await decryptedResponseFields(data)),
    raw: data,
  }
}

/**
 * Enquire the status of a previously initiated IMPS payout.
 */
export const enquireImpsStatus = async ({ requestId, amount }) => {
  const cfg = paymentInitiationConfig()
  const xml = buildImpsStatusXml({
    requestId,
    remitterAccount: cfg.remitterAccount,
    amount,
    authToken: cfg.authToken,
  })
  if (cfg.mockMode) {
    return { ...mockResult(requestId), enquiry: true }
  }
  assertConfigured(cfg)
  const { data, httpStatus } = await post(cfg, 'payments/status', xml, requestId)
  return {
    requestId,
    httpStatus,
    ...parseP2aResponse(data),
    ...(await decryptedResponseFields(data)),
    raw: data,
  }
}

const transactionStatusBlocks = (xml) =>
  String(xml || '').match(
    /<(?:[\w.-]+:)?TxInfAndSts\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?TxInfAndSts>/gi,
  ) || []

// Parse a pain.001 credit-transfer response (PaymentResponse JSON or pain.002).
// A pain.002 may report PART for a batch containing mixed transaction outcomes;
// in that case only the transaction matching our original instruction may drive
// the payout state.
export const parsePaymentResponse = (data, expectedTransactionId = '') => {
  if (data && typeof data === 'object' && data.statusCode) {
    const statusClassification = classifyIsoStatus(data.statusCode)
    return {
      statusCode: data.statusCode,
      statusDescription: data.statusDesc || '',
      referenceId: data.referenceId || '',
      classification: statusClassification,
      success: statusClassification === 'SUCCESS',
    }
  }
  const raw = String(data || '')
  const groupStatusCode = extractTag(raw, 'GrpSts')
  const blocks = transactionStatusBlocks(raw)
  const matchedBlock = expectedTransactionId
    ? blocks.find((block) =>
        [extractTag(block, 'OrgnlInstrId'), extractTag(block, 'OrgnlEndToEndId')]
          .filter(Boolean)
          .includes(String(expectedTransactionId)),
      )
    : blocks.length === 1
      ? blocks[0]
      : ''
  const transactionStatusCode = matchedBlock
    ? extractTag(matchedBlock, 'TxSts')
    : !expectedTransactionId && blocks.length === 0
      ? extractTag(raw, 'TxSts')
      : ''
  const statusCode = transactionStatusCode || groupStatusCode
  const classification = classifyIsoStatus(statusCode)
  return {
    statusCode,
    groupStatusCode,
    transactionStatusCode,
    statusDescription: extractTag(matchedBlock || raw, 'AddtlInf'),
    referenceId: extractTag(raw, 'MsgId'),
    rrn: extractTag(matchedBlock || raw, 'AcctSvcrRef'),
    classification,
    success: classification === 'SUCCESS',
  }
}

const parseNeftResponse = async (data, expectedTransactionId) => {
  const summary = parsePaymentResponse(data, expectedTransactionId)
  const b64 = data && typeof data === 'object' ? data.responseBase64 : ''
  if (!b64 || !pgpConfigured()) {
    return summary
  }
  try {
    const { text, verified } = await decryptVerifyFromBase64(b64)
    if (!verified) {
      return { ...summary, responseVerified: false }
    }
    const transaction = parsePaymentResponse(text, expectedTransactionId)
    return {
      ...transaction,
      referenceId: summary.referenceId || transaction.referenceId,
      responseVerified: true,
    }
  } catch {
    return summary
  }
}

const neftHeaders = (cfg, requestId) => ({
  'Content-Type': 'application/xml',
  'x-hsbc-profile-id': cfg.profileId,
  'x-hsbc-client-id': cfg.clientId,
  'x-hsbc-client-secret': cfg.clientSecret,
  'x-payload-type': 'pain.001.001.03',
  'x-hsbc-country-code': cfg.countryCode,
  'x-hsbc-unique-ref-id': requestId,
})

const postNeft = async (cfg, path, xml, requestId) => {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
  try {
    const { body, headers } = await buildBodyAndHeaders(
      cfg,
      xml,
      neftHeaders(cfg, requestId),
    )
    const response = await axios.post(url, body, {
      timeout: cfg.timeoutMs,
      headers,
    })
    return { data: response.data, httpStatus: response.status }
  } catch (error) {
    safeLog.error('HSBC NEFT request failed', { path, message: error.message })
    throw new HsbcPaymentTransportError(
      `HSBC NEFT transport error: ${error.message}`,
      error.response?.status,
    )
  }
}

export const generateNeftRequestId = () =>
  `NEFT${Date.now()}${crypto.randomInt(1000, 10000)}`

export const buildNeftStatusXml = ({ profileId, requestId, referenceId }) => {
  const keyTag = referenceId ? 'ReferenceID' : 'MessageID'
  const keyValue = referenceId || requestId
  return [
    '<StatusEnquiry>',
    `  <ProfileID>${xmlEscape(profileId)}</ProfileID>`,
    `  <Key><${keyTag}>${xmlEscape(keyValue)}</${keyTag}></Key>`,
    '</StatusEnquiry>',
  ].join('\n')
}

/**
 * Initiate a NEFT payout (pain.001). NEFT settles in batches, so a successful
 * response is "accepted/processing"; final settlement (ACSC) arrives via status
 * enquiry or the Payment Status Notification webhook.
 */
export const initiateNeftPayout = async ({
  beneficiaryName,
  beneficiaryAccount,
  beneficiaryIfsc,
  amount,
  requestId,
}) => {
  const cfg = paymentInitiationConfig()
  const reqId = requestId || generateNeftRequestId()
  const xml = buildNeftPaymentXml({
    initiatingPartyId: cfg.serviceProviderId,
    messageId: reqId,
    debtorName: cfg.debtorName,
    debtorAccount: cfg.remitterAccount,
    debtorBic: cfg.debtorBic,
    beneficiaryName,
    beneficiaryAccount,
    beneficiaryIfsc,
    amount,
    serviceLevel: cfg.neftServiceLevel,
    localInstrument: cfg.neftLocalInstrument,
  })
  if (cfg.mockMode) {
    return {
      requestId: reqId,
      statusCode: 'ACTC',
      statusDescription: 'Accepted Technical Validation (mock)',
      classification: 'PROCESSING',
      success: false,
      mock: true,
    }
  }
  assertConfigured(cfg)
  const { data, httpStatus } = await postNeft(
    cfg,
    'payments/instant-receipt',
    xml,
    reqId,
  )
  return {
    requestId: reqId,
    httpStatus,
    ...(await parseNeftResponse(data, reqId)),
    raw: data,
  }
}

/**
 * Enquire the settlement status of a NEFT payout.
 */
export const enquireNeftStatus = async ({ requestId, referenceId = '' }) => {
  const cfg = paymentInitiationConfig()
  if (cfg.mockMode) {
    return {
      requestId,
      statusCode: 'ACSC',
      statusDescription: 'Settlement completed (mock)',
      classification: 'SUCCESS',
      success: true,
      enquiry: true,
    }
  }
  assertConfigured(cfg)
  const xml = buildNeftStatusXml({
    profileId: cfg.profileId,
    requestId,
    referenceId,
  })
  const { data, httpStatus } = await postNeft(
    cfg,
    'payments/status',
    xml,
    requestId,
  )
  return {
    requestId,
    httpStatus,
    ...(await parseNeftResponse(data, requestId)),
    raw: data,
  }
}
