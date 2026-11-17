import { expect } from 'chai'
import mongoose from 'mongoose'
import companyModel from '../models/companyModel.js'
import devicesLotModel from '../models/devicesLotModel.js'
import leadsModel from '../models/leadsModel.js'
import {
  STORE_PAYMENT_MODES,
  STORE_PAYMENT_STATUSES,
  StorePaymentError,
  assertLeadEligible,
} from '../services/storePaymentService.js'
import { courierConfigurationStatus } from '../integrations/courier/courierClient.js'

describe('Store payment workflow contract', () => {
  it('defaults companies to the company-accounts payment mode', () => {
    const company = new companyModel()
    expect(company.storePaymentSettings.mode).to.equal(
      STORE_PAYMENT_MODES.COMPANY_ACCOUNTS,
    )
  })

  it('creates device lots in the payment-requested state by default', () => {
    const lot = new devicesLotModel()
    expect(lot.paymentStatus).to.equal(STORE_PAYMENT_STATUSES.REQUESTED)
    expect(lot.paymentMode).to.equal(STORE_PAYMENT_MODES.COMPANY_ACCOUNTS)
    expect(lot.warehouseStatus).to.equal('NOT_READY')
    expect(lot.notification.state).to.equal('NOT_SENT')
  })

  it('keeps new leads outside the store-payment and warehouse queues', () => {
    const lead = new leadsModel()
    expect(lead.storePaymentStatus).to.equal('')
    expect(lead.warehouseStatus).to.equal('')
    expect(lead.deliveryStatus).to.equal('')
  })

  it('blocks store payment while a related customer payout is incomplete', () => {
    const lead = {
      _id: new mongoose.Types.ObjectId(),
      uniqueCode: 'LEAD-1',
      status: 'Picked Up',
      storeId: new mongoose.Types.ObjectId(),
      companyId: new mongoose.Types.ObjectId(),
      payoutId: new mongoose.Types.ObjectId(),
      payoutStatus: 'AWAITING_VPA',
    }
    const store = { companyId: lead.companyId }
    expect(() => assertLeadEligible(lead, store)).to.throw(
      StorePaymentError,
      /payout succeeds/,
    )
    expect(() => assertLeadEligible({ ...lead, payoutStatus: 'SUCCESS' }, store))
      .to.not.throw()
  })

  it('keeps courier push disabled without server-side configuration', () => {
    const previousProvider = process.env.COURIER_PROVIDER
    const previousUrl = process.env.COURIER_CREATE_ORDER_URL
    const previousToken = process.env.COURIER_API_TOKEN
    delete process.env.COURIER_PROVIDER
    delete process.env.COURIER_CREATE_ORDER_URL
    delete process.env.COURIER_API_TOKEN
    expect(courierConfigurationStatus().configured).to.equal(false)
    if (previousProvider) {
      process.env.COURIER_PROVIDER = previousProvider
    }
    if (previousUrl) {
      process.env.COURIER_CREATE_ORDER_URL = previousUrl
    }
    if (previousToken) {
      process.env.COURIER_API_TOKEN = previousToken
    }
  })
})
