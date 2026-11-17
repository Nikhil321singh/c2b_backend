import { expect } from 'chai'
import {
  validateVpa,
  initiatePayout,
  enquirePayout,
  hsbcUpiClientConfigStatus,
} from '../integrations/hsbc/hsbcUpiClient.js'
import BuybackPayout from '../models/buybackPayoutModel.js'
import Company from '../models/companyModel.js'
import Store from '../models/storeModel.js'
import Lead from '../models/leadsModel.js'
import {
  buildPayoutLinkSmsVariables,
  resolvePayoutEmailRecipient,
} from '../services/payoutNotificationService.js'

describe('HSBC UPI integration contract', () => {
  const originalMerchantId = process.env.HSBC_UPI_MERCHANT_ID
  const originalMerchantKey = process.env.HSBC_UPI_MERCHANT_KEY
  const originalMockMode = process.env.HSBC_UPI_MOCK_MODE
  const originalCustomerAppUrl = process.env.PAYOUT_CUSTOMER_APP_URL
  const originalDevelopmentOverride =
    process.env.PAYOUT_FORCE_HSBC_IN_DEVELOPMENT
  const originalNotificationMode = process.env.PAYOUT_NOTIFICATION_MODE
  const originalLinkNotificationMode =
    process.env.PAYOUT_LINK_NOTIFICATION_MODE
  const originalSuccessNotificationMode =
    process.env.PAYOUT_SUCCESS_NOTIFICATION_MODE
  const originalNotificationEmail = process.env.PAYOUT_NOTIFICATION_EMAIL
  const originalMail = process.env.MAIL
  const originalMailPass = process.env.MAIL_PASS
  const UAT_TEST_VPA = '7776968905@hsbc'
  const UAT_TEST_MERCHANT_ORDER_NO = '1737042642969801001'

  before(() => {
    process.env.HSBC_UPI_MERCHANT_ID = '1234567890123456'
    process.env.HSBC_UPI_MERCHANT_KEY = '00112233445566778899aabbccddeeff'
    process.env.HSBC_UPI_MOCK_MODE = 'true'
    process.env.PAYOUT_CUSTOMER_APP_URL = 'https://uat.example.com/payout'
    process.env.PAYOUT_FORCE_HSBC_IN_DEVELOPMENT = 'false'
    process.env.PAYOUT_NOTIFICATION_MODE = 'EMAIL'
    // notificationMode prefers PAYOUT_LINK_NOTIFICATION_MODE, so override it too
    // to keep this test independent of the ambient .env (which may set SMS).
    process.env.PAYOUT_LINK_NOTIFICATION_MODE = 'EMAIL'
    process.env.PAYOUT_SUCCESS_NOTIFICATION_MODE = 'EMAIL'
    process.env.PAYOUT_NOTIFICATION_EMAIL = 'qa@example.com'
    process.env.MAIL = 'sender@example.com'
    process.env.MAIL_PASS = 'test-app-password'
  })

  after(() => {
    if (originalMerchantId === undefined) {
      delete process.env.HSBC_UPI_MERCHANT_ID
    } else {
      process.env.HSBC_UPI_MERCHANT_ID = originalMerchantId
    }
    if (originalMerchantKey === undefined) {
      delete process.env.HSBC_UPI_MERCHANT_KEY
    } else {
      process.env.HSBC_UPI_MERCHANT_KEY = originalMerchantKey
    }
    if (originalMockMode === undefined) {
      delete process.env.HSBC_UPI_MOCK_MODE
    } else {
      process.env.HSBC_UPI_MOCK_MODE = originalMockMode
    }
    if (originalCustomerAppUrl === undefined) {
      delete process.env.PAYOUT_CUSTOMER_APP_URL
    } else {
      process.env.PAYOUT_CUSTOMER_APP_URL = originalCustomerAppUrl
    }
    if (originalDevelopmentOverride === undefined) {
      delete process.env.PAYOUT_FORCE_HSBC_IN_DEVELOPMENT
    } else {
      process.env.PAYOUT_FORCE_HSBC_IN_DEVELOPMENT =
        originalDevelopmentOverride
    }
    for (const [name, value] of [
      ['PAYOUT_NOTIFICATION_MODE', originalNotificationMode],
      ['PAYOUT_LINK_NOTIFICATION_MODE', originalLinkNotificationMode],
      ['PAYOUT_SUCCESS_NOTIFICATION_MODE', originalSuccessNotificationMode],
      ['PAYOUT_NOTIFICATION_EMAIL', originalNotificationEmail],
      ['MAIL', originalMail],
      ['MAIL_PASS', originalMailPass],
    ]) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  })

  it('validates the HSBC UAT test VPA', async () => {
    const response = await validateVpa({
      vpa: UAT_TEST_VPA,
      reference: UAT_TEST_MERCHANT_ORDER_NO,
    })
    expect(response.data.valStatusCode).to.equal('VE')
    expect(response.data.respVpa).to.equal(UAT_TEST_VPA)
  })

  it('maps a merchant-to-customer payment and status enquiry', async () => {
    const payment = await initiatePayout({
      beneficiaryVpa: UAT_TEST_VPA,
      amount: 1,
      merchantOrderNo: UAT_TEST_MERCHANT_ORDER_NO,
      remarks: 'GREST UAT payout',
    })
    expect(payment.data).to.include({
      paymentType: 'P',
      transAmount: '1.00',
      respCode: '00',
      transStatus: 'S',
    })

    const status = await enquirePayout({
      merchantOrderNo: UAT_TEST_MERCHANT_ORDER_NO,
      reference: '1737042642969801',
      rrn: payment.data.newTransRRN,
    })
    expect(status.data.respCode).to.equal('00')
    expect(status.data.transStatus).to.equal('S')
  })

  it('never serializes stored link tokens or beneficiary VPA data', () => {
    const payout = new BuybackPayout({
      customerLinkTokenHash: 'link-token-hash',
      beneficiaryVpaEncrypted: 'encrypted-vpa',
      beneficiaryVpaHash: 'vpa-hash',
    })
    const serialized = payout.toJSON()
    expect(serialized).not.to.have.property('customerLinkTokenHash')
    expect(serialized).not.to.have.property('beneficiaryVpaEncrypted')
    expect(serialized).not.to.have.property('beneficiaryVpaHash')
  })

  it('reports mock mode as not ready for UAT', () => {
    const status = hsbcUpiClientConfigStatus()
    expect(status).to.include({
      configured: true,
      customerAppConfigured: true,
      mockMode: true,
      notificationMode: 'EMAIL',
      emailNotificationConfigured: true,
      linkNotificationConfigured: true,
      successNotificationConfigured: true,
      developmentOverrideEnabled: false,
      uatReady: false,
    })
  })

  it('tracks customer-link notification delivery state', () => {
    const payout = new BuybackPayout()
    expect(payout.linkNotificationState).to.equal('NOT_SENT')
    payout.linkNotificationState = 'DELIVERED'
    expect(payout.toJSON().linkNotificationState).to.equal('DELIVERED')
  })

  it('defaults new companies and stores to safe payout settings', () => {
    const company = new Company()
    const store = new Store()
    expect(company.buybackPayoutSettings.enabled).to.equal(false)
    expect(company.buybackPayoutSettings.deviceCooldownDays).to.equal(0)
    expect(store.payoutSettings.enabled).to.equal(false)
    expect(store.payoutSettings.mode).to.equal('MANUAL')
    expect(store.payoutSettings.payoutCeiling).to.equal(0)
  })

  it('keeps fraud identity fingerprints excluded from normal lead queries', () => {
    expect(Lead.schema.path('deviceIdentityHash').options.select).to.equal(
      false,
    )
    expect(
      Lead.schema.path('customerIdentityHash').options.select,
    ).to.equal(false)
  })

  it('delivers payout notifications to the customer email when available', () => {
    expect(resolvePayoutEmailRecipient(' Customer@Test.com ')).to.deep.equal({
      recipient: 'customer@test.com',
      recipientSource: 'CUSTOMER',
    })
  })

  it('uses the configured QA email only when customer email is unavailable', () => {
    expect(resolvePayoutEmailRecipient('invalid-email')).to.deep.equal({
      recipient: 'qa@example.com',
      recipientSource: 'FALLBACK',
    })
  })

  it('maps the approved payout-link SMS placeholders exactly', () => {
    expect(
      buildPayoutLinkSmsVariables({
        amount: 130,
        device: 'iPhone 14',
        link: 'https://uat.example.com/payout/token',
      }),
    ).to.deep.equal({
      amount: '130.00',
      device: 'iPhone 14',
      link: 'https://uat.example.com/payout/token',
    })
  })
})
