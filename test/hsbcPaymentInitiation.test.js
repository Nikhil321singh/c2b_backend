import { expect } from 'chai'
import {
  HsbcPaymentConfigurationError,
  buildImpsPaymentXml,
  buildImpsStatusXml,
  parseP2aResponse,
  extractTag,
  generateRequestId,
  paymentInitiationStatus,
  initiateImpsPayout,
  enquireImpsStatus,
} from '../integrations/hsbc/hsbcPaymentInitiationClient.js'
import {
  parseStatusNotification,
  inspectNotificationEvent,
  buildNotificationAck,
  isAuthorisedNotification,
} from '../integrations/hsbc/hsbcPaymentNotification.js'

describe('hsbc payment initiation - IMPS request/response', () => {
  it('builds a P2A IMPS payment request with the beneficiary account + IFSC', () => {
    const xml = buildImpsPaymentXml({
      serviceProviderId: 'PC000016070',
      requestId: 'IMPS123',
      remitterAccount: '073048084001',
      beneficiaryIfsc: 'HDFC0000007',
      beneficiaryAccount: '9876543210',
      amount: 5000,
    })
    expect(extractTag(xml, 'REQUESTTYPE')).to.equal('R')
    expect(extractTag(xml, 'REMITTORACCOUNTNO')).to.equal('073048084001')
    expect(extractTag(xml, 'BENEFICIARYBANKIFSC')).to.equal('HDFC0000007')
    expect(extractTag(xml, 'BENEFICIARYACCOUNTNO')).to.equal('9876543210')
    expect(extractTag(xml, 'AMOUNT')).to.equal('5000')
    expect(extractTag(xml, 'CHANNELID')).to.equal('CDP')
  })

  it('requires debit account and beneficiary details', () => {
    expect(() =>
      buildImpsPaymentXml({ requestId: 'x', beneficiaryIfsc: 'A', beneficiaryAccount: 'B', amount: 1 }),
    ).to.throw(HsbcPaymentConfigurationError, /Remitter/)
    expect(() =>
      buildImpsPaymentXml({ requestId: 'x', remitterAccount: '1', amount: 1 }),
    ).to.throw(HsbcPaymentConfigurationError, /Beneficiary/)
  })

  it('builds a P2A status enquiry (REQUESTTYPE E)', () => {
    const xml = buildImpsStatusXml({ requestId: 'IMPS123', remitterAccount: '1', amount: 1 })
    expect(extractTag(xml, 'REQUESTTYPE')).to.equal('E')
  })

  it('parses a successful p2aResponse (RESPONSECODE 00)', () => {
    const xml =
      '<p2aResponse>' +
      '<RESPONSECODE>00</RESPONSECODE>' +
      '<RESPONSEDESCRIPTION>Successful Transaction</RESPONSEDESCRIPTION>' +
      '<RRN>012119135393</RRN>' +
      '<BENEFICIARYNAME>P3ACustomer</BENEFICIARYNAME>' +
      '</p2aResponse>'
    const parsed = parseP2aResponse(xml)
    expect(parsed.success).to.equal(true)
    expect(parsed.rrn).to.equal('012119135393')
    expect(parsed.beneficiaryName).to.equal('P3ACustomer')
  })

  it('treats a non-00 response code as unsuccessful', () => {
    const parsed = parseP2aResponse('<p2aResponse><RESPONSECODE>XX</RESPONSECODE></p2aResponse>')
    expect(parsed.success).to.equal(false)
  })

  it('maps an accepted ISO-20022 JSON status to success', () => {
    expect(parseP2aResponse({ statusCode: 'ACSC', statusDesc: 'Settled' }).success).to.equal(true)
    expect(parseP2aResponse({ statusCode: 'RJCT' }).success).to.equal(false)
  })

  it('generates unique request ids', () => {
    expect(generateRequestId()).to.match(/^IMPS\d+$/)
    expect(generateRequestId()).to.not.equal(generateRequestId())
  })
})

describe('hsbc payment initiation - config + mock mode', () => {
  const KEYS = [
    'HSBC_PAYMENT_MOCK_MODE',
    'HSBC_PAYMENT_BASE_URL',
    'HSBC_PAYMENT_PROFILE_ID',
    'HSBC_PAYMENT_CLIENT_ID',
    'HSBC_PAYMENT_CLIENT_SECRET',
    'HSBC_PAYMENT_DEBIT_ACCOUNT',
  ]
  let saved
  beforeEach(() => {
    saved = {}
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = saved[k]
      }
    }
  })

  it('is unconfigured with no credentials', () => {
    expect(paymentInitiationStatus().configured).to.equal(false)
    expect(paymentInitiationStatus().provider).to.equal('HSBC_IMPS')
  })

  it('is configured with full credentials + debit account', () => {
    process.env.HSBC_PAYMENT_BASE_URL = 'https://sandbox.example'
    process.env.HSBC_PAYMENT_PROFILE_ID = 'PIC1'
    process.env.HSBC_PAYMENT_CLIENT_ID = 'cid'
    process.env.HSBC_PAYMENT_CLIENT_SECRET = 'sec'
    process.env.HSBC_PAYMENT_DEBIT_ACCOUNT = '073048084001'
    expect(paymentInitiationStatus().configured).to.equal(true)
  })

  it('returns a canned success in mock mode without a network call', async () => {
    process.env.HSBC_PAYMENT_MOCK_MODE = 'true'
    process.env.HSBC_PAYMENT_DEBIT_ACCOUNT = '073048084001'
    const result = await initiateImpsPayout({
      beneficiaryIfsc: 'HDFC0000007',
      beneficiaryAccount: '9876543210',
      amount: 5000,
    })
    expect(result.success).to.equal(true)
    expect(result.mock).to.equal(true)
    expect(result.requestId).to.match(/^IMPS\d+$/)

    const status = await enquireImpsStatus({ requestId: result.requestId, amount: 5000 })
    expect(status.enquiry).to.equal(true)
    expect(status.success).to.equal(true)
  })
})

describe('hsbc payment status notification (webhook)', () => {
  it('parses the notification envelope', () => {
    const n = parseStatusNotification({
      subscriptionId: 'sub-1',
      eventId: 'evt-1',
      eventCat: 'Payment_Status',
      eventFrmt: 'PAIN002',
      event: 'Zm9v',
    })
    expect(n.subscriptionId).to.equal('sub-1')
    expect(n.eventCat).to.equal('Payment_Status')
  })

  it('detects a PGP event and marks decryption pending', () => {
    const pgp = Buffer.from('-----BEGIN PGP MESSAGE-----\nabc\n-----END PGP MESSAGE-----').toString('base64')
    const info = inspectNotificationEvent(pgp)
    expect(info.isPgp).to.equal(true)
    expect(info.pending).to.equal(true)
  })

  it('builds a success acknowledgement', () => {
    const ack = buildNotificationAck({ subscriptionId: 'sub-1', eventId: 'evt-1' }, true)
    expect(ack.statusCode).to.equal('Success')
    expect(ack.subscriptionId).to.equal('sub-1')
  })

  it('is lenient without a secret only outside production, and matches when set', () => {
    const savedEnv = process.env.NODE_ENV
    delete process.env.HSBC_PAYMENT_WEBHOOK_SECRET

    // No secret configured: allowed in dev/sandbox, fail closed in production.
    process.env.NODE_ENV = 'development'
    expect(isAuthorisedNotification({})).to.equal(true)
    process.env.NODE_ENV = 'production'
    expect(isAuthorisedNotification({})).to.equal(false)

    // Secret configured: reject mismatch, accept exact match.
    process.env.HSBC_PAYMENT_WEBHOOK_SECRET = 'shh'
    expect(isAuthorisedNotification({ secret: 'wrong' })).to.equal(false)
    expect(isAuthorisedNotification({ secret: 'shh' })).to.equal(true)

    delete process.env.HSBC_PAYMENT_WEBHOOK_SECRET
    if (savedEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = savedEnv
    }
  })
})
