import { expect } from 'chai'
import BuybackPayout from '../models/buybackPayoutModel.js'
import {
  HsbcPaymentConfigurationError,
  buildNeftPaymentXml,
  buildNeftStatusXml,
  parsePaymentResponse,
  classifyIsoStatus,
  extractTag,
  initiateNeftPayout,
  enquireNeftStatus,
} from '../integrations/hsbc/hsbcPaymentInitiationClient.js'

describe('hsbc NEFT - pain.001 builder', () => {
  const base = {
    initiatingPartyId: 'PC000016070',
    messageId: 'NEFT123',
    debtorName: 'GREST',
    debtorAccount: '073048084001',
    beneficiaryName: 'Ravi Kumar',
    beneficiaryAccount: '9876543210',
    beneficiaryIfsc: 'HDFC0000007',
    amount: 5000,
    now: new Date('2026-08-05T09:00:00Z'),
  }

  it('builds a pain.001 credit transfer carrying account + IFSC', () => {
    const xml = buildNeftPaymentXml(base)
    expect(xml).to.contain('pain.001.001.03')
    expect(extractTag(xml, 'PmtMtd')).to.equal('TRF')
    // Beneficiary account -> CdtrAcct, IFSC -> creditor agent member id
    expect(xml).to.contain('<MmbId>HDFC0000007</MmbId>')
    expect(xml).to.contain('<Id>9876543210</Id>')
    expect(xml).to.contain('<InstdAmt Ccy="INR">5000</InstdAmt>')
    expect(extractTag(xml, 'MsgId')).to.equal('NEFT123')
  })

  it('requires the debit and beneficiary details', () => {
    expect(() => buildNeftPaymentXml({ ...base, debtorAccount: '' })).to.throw(
      HsbcPaymentConfigurationError,
    )
    expect(() => buildNeftPaymentXml({ ...base, beneficiaryIfsc: '' })).to.throw(
      HsbcPaymentConfigurationError,
    )
  })
})

describe('hsbc NEFT - status classification', () => {
  it('treats settlement complete as success', () => {
    expect(classifyIsoStatus('ACSC')).to.equal('SUCCESS')
  })
  it('treats accepted states as processing (batch settlement)', () => {
    for (const code of ['ACTC', 'ACCP', 'ACSP', 'RCVD', 'PDNG']) {
      expect(classifyIsoStatus(code)).to.equal('PROCESSING')
    }
  })
  it('treats partially-accepted (PART) as processing, not failed', () => {
    // PART must never map to FAILED: FAILED enables re-payment and PART means
    // the transfer may still be in-flight, so failing it risks double payment.
    expect(classifyIsoStatus('PART')).to.equal('PROCESSING')
  })
  it('treats rejected as failed', () => {
    expect(classifyIsoStatus('RJCT')).to.equal('FAILED')
  })

  it('parses a JSON PaymentResponse and an XML pain.002', () => {
    expect(parsePaymentResponse({ statusCode: 'ACSC', statusDesc: 'Settled' }).success).to.equal(true)
    expect(parsePaymentResponse({ statusCode: 'ACTC' }).classification).to.equal('PROCESSING')
    const xml = '<Document><CstmrPmtStsRpt><OrgnlGrpInfAndSts><GrpSts>RJCT</GrpSts></OrgnlGrpInfAndSts></CstmrPmtStsRpt></Document>'
    expect(parsePaymentResponse(xml).classification).to.equal('FAILED')
  })

  it('uses the provider reference for a status enquiry when available', () => {
    const xml = buildNeftStatusXml({
      profileId: 'PROFILE-1',
      requestId: 'NEFT123',
      referenceId: 'HSBC-REF-456',
    })
    expect(extractTag(xml, 'ReferenceID')).to.equal('HSBC-REF-456')
    expect(xml).not.to.contain('<MessageID>')
  })

  it('falls back to the original message id for legacy payouts', () => {
    const xml = buildNeftStatusXml({
      profileId: 'PROFILE-1',
      requestId: 'NEFT123',
    })
    expect(extractTag(xml, 'MessageID')).to.equal('NEFT123')
  })

  it('classifies the matching transaction instead of a mixed batch', () => {
    const xml = `
      <Document><CstmrPmtStsRpt>
        <OrgnlGrpInfAndSts><GrpSts>PART</GrpSts></OrgnlGrpInfAndSts>
        <TxInfAndSts><OrgnlInstrId>NEFT-REJECTED</OrgnlInstrId><TxSts>RJCT</TxSts><StsRsnInf><AddtlInf>Invalid account</AddtlInf></StsRsnInf></TxInfAndSts>
        <TxInfAndSts><OrgnlInstrId>NEFT-SETTLED</OrgnlInstrId><TxSts>ACSC</TxSts><AcctSvcrRef>RRN123</AcctSvcrRef></TxInfAndSts>
      </CstmrPmtStsRpt></Document>`
    const result = parsePaymentResponse(xml, 'NEFT-SETTLED')
    expect(result.groupStatusCode).to.equal('PART')
    expect(result.transactionStatusCode).to.equal('ACSC')
    expect(result.classification).to.equal('SUCCESS')
    expect(result.rrn).to.equal('RRN123')
  })

  it('keeps a mixed batch processing when its transaction cannot be matched', () => {
    const xml = `
      <Document><CstmrPmtStsRpt>
        <OrgnlGrpInfAndSts><GrpSts>PART</GrpSts></OrgnlGrpInfAndSts>
        <TxInfAndSts><OrgnlEndToEndId>OTHER</OrgnlEndToEndId><TxSts>ACSC</TxSts></TxInfAndSts>
      </CstmrPmtStsRpt></Document>`
    const result = parsePaymentResponse(xml, 'NEFT-EXPECTED')
    expect(result.transactionStatusCode).to.equal('')
    expect(result.statusCode).to.equal('PART')
    expect(result.classification).to.equal('PROCESSING')
  })
})

describe('hsbc NEFT - mock mode', () => {
  const KEYS = ['HSBC_PAYMENT_MOCK_MODE', 'HSBC_PAYMENT_DEBIT_ACCOUNT']
  let saved
  beforeEach(() => {
    saved = {}
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    process.env.HSBC_PAYMENT_MOCK_MODE = 'true'
    process.env.HSBC_PAYMENT_DEBIT_ACCOUNT = '073048084001'
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

  it('initiates as accepted (processing) then settles on enquiry', async () => {
    const init = await initiateNeftPayout({
      beneficiaryName: 'Ravi Kumar',
      beneficiaryAccount: '9876543210',
      beneficiaryIfsc: 'HDFC0000007',
      amount: 5000,
    })
    expect(init.classification).to.equal('PROCESSING')
    expect(init.success).to.equal(false)
    expect(init.requestId).to.match(/^NEFT\d+$/)

    const status = await enquireNeftStatus({ requestId: init.requestId })
    expect(status.classification).to.equal('SUCCESS')
    expect(status.success).to.equal(true)
  })
})

describe('hsbc NEFT - model', () => {
  it('accepts HSBC_NEFT as a valid provider', () => {
    const errors = new BuybackPayout({ provider: 'HSBC_NEFT' }).validateSync()?.errors || {}
    expect(errors.provider).to.equal(undefined)
  })
})
