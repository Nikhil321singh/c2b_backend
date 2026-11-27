// HSBC payout mode: a lead is sold only after the customer is paid. Until
// then it waits as "Payment Pending" (not sold). Database calls are fakes.
import { expect } from 'chai'
import mongoose from 'mongoose'
import leads from '../models/leadsModel.js'
import { PAYOUT_STATUS } from '../models/buybackPayoutModel.js'
import {
  buildSaleLeadUpdate,
  buildPayoutSaleResponse,
} from '../controller/questionnaireController.js'
import { buildLeadPayoutUpdate } from '../services/buybackPayout/processing.js'
import {
  validatePayoutEligibility,
  SOLD_OR_PAYMENT_PENDING,
} from '../services/buybackPayout/settings.js'
import { buildQueryParam } from '../utils/priceCalculationService.js'

const oid = () => new mongoose.Types.ObjectId()

const originals = []
const fake = (target, key, impl) => {
  originals.push([target, key, target[key]])
  target[key] = impl
}
const restoreAll = () => {
  while (originals.length) {
    const [target, key, original] = originals.pop()
    target[key] = original
  }
}

const soldLead = () => ({
  price: 32840,
  bonusPrice: 0,
  slabBonusAmount: 0,
  negotiatedAmount: 0,
  slabApplied: '',
  couponDiscount: 0,
  exactValue: 32840,
  quotedPrice: 32840,
  actualPrice: 32840,
  tncVersion: 'v1',
  soldAt: new Date('2026-11-27T10:53:15Z'),
})

describe('Sell: when the lead becomes sold', () => {
  it('HSBC payout: lead is NOT sold at Sell, it waits as Payment Pending', () => {
    const update = buildSaleLeadUpdate(soldLead(), { isHsbcPayout: true, payoutAmount: 32840 })
    expect(update.is_selled).to.equal(false)
    expect(update.status).to.equal('Payment Pending')
    expect(update.payoutAmount).to.equal(32840)
    expect(update).to.not.have.property('soldAt')
  })

  it('Manual mode: unchanged, the lead is sold straight away', () => {
    const lead = soldLead()
    const update = buildSaleLeadUpdate(lead, { isHsbcPayout: false, payoutAmount: 32840 })
    expect(update.is_selled).to.equal(true)
    expect(update.soldAt).to.equal(lead.soldAt)
    expect(update).to.not.have.property('status')
    expect(update).to.not.have.property('payoutAmount')
  })

  it('both modes still save the sale price fields', () => {
    for (const isHsbcPayout of [true, false]) {
      const update = buildSaleLeadUpdate(soldLead(), { isHsbcPayout, payoutAmount: 1 })
      expect(update).to.include({ price: 32840, quotedPrice: 32840, tncVersion: 'v1' })
    }
  })
})

describe('Payout status → lead', () => {
  const payout = (status, extra = {}) => ({ _id: oid(), leadId: oid(), amount: 500, status, ...extra })

  it('payment SUCCESS: lead becomes sold, sold time = payment time, Completed', () => {
    const paidAt = new Date('2026-11-27T11:00:00Z')
    const update = buildLeadPayoutUpdate(payout(PAYOUT_STATUS.SUCCESS, { paidAt }))
    expect(update).to.include({ is_selled: true, status: 'Completed', payoutStatus: 'SUCCESS' })
    expect(update.soldAt).to.equal(paidAt)
    expect(update.$push.history.action).to.equal('HSBC UPI payout completed')
  })

  it('payout REJECTED: lead is not sold and shows Payout Rejected', () => {
    const update = buildLeadPayoutUpdate(payout(PAYOUT_STATUS.REJECTED))
    expect(update).to.include({ is_selled: false, status: 'Payout Rejected', payoutStatus: 'REJECTED' })
    expect(update.$unset).to.have.property('soldAt')
  })

  it('every other status only records the payout status (lead stays unsold, Payment Pending)', () => {
    for (const status of ['AWAITING_VPA', 'EXPIRED', 'PENDING_APPROVAL', 'READY_FOR_PAYMENT', 'PROCESSING', 'STATUS_UNKNOWN', 'FAILED']) {
      expect(buildLeadPayoutUpdate(payout(status)), status).to.deep.equal({ payoutStatus: status })
    }
  })
})

describe('Selling limits still count pending payouts', () => {
  afterEach(restoreAll)

  const settings = {
    payoutCeiling: 1000000,
    deviceCooldownDays: 7,
    customerSellLimitCount: 3,
    customerSellLimitWindowDays: 4,
  }
  const lead = () => ({ _id: oid(), phoneNumber: '9876543210', documentId: { IMEI: '356789012345678' } })

  it('device cooldown and customer limit both match sold OR Payment Pending leads', async () => {
    const seen = {}
    fake(leads, 'findByIdAndUpdate', async () => ({}))
    fake(leads, 'findOne', (filter) => {
      seen.cooldown = filter
      return { select: () => ({ lean: async () => null }) }
    })
    fake(leads, 'countDocuments', async (filter) => {
      seen.limit = filter
      return 0
    })
    await validatePayoutEligibility({ lead: lead(), amount: 500, settings })
    for (const filter of [seen.cooldown, seen.limit]) {
      expect(filter).to.not.have.property('is_selled')
      expect(filter.$and[0]).to.deep.equal(SOLD_OR_PAYMENT_PENDING)
    }
    expect(SOLD_OR_PAYMENT_PENDING.$or).to.deep.equal([{ is_selled: true }, { status: 'Payment Pending' }])
  })

  it('3 pending payouts in the window still block a 4th (limits cannot be bypassed)', async () => {
    fake(leads, 'findByIdAndUpdate', async () => ({}))
    fake(leads, 'findOne', () => ({ select: () => ({ lean: async () => null }) }))
    fake(leads, 'countDocuments', async () => 3)
    try {
      await validatePayoutEligibility({ lead: lead(), amount: 500, settings })
    } catch (error) {
      expect(error.statusCode).to.equal(409)
      expect(error.message).to.match(/Customer selling limit reached/)
      return
    }
    throw new Error('Expected the 4th sale to be refused')
  })
})

describe('A lead with a payout is never re-quoted', () => {
  it('the lead reuse lookup skips leads that have a payout', () => {
    const query = buildQueryParam('9876543210', oid(), '128', '6', oid())
    expect(query).to.include({ is_selled: false, payoutId: null })
  })
})

describe('Sell response for an existing payout (Back, then Sell again)', () => {
  it('returns the same payout, with no new link', () => {
    const payout = { _id: oid(), amount: 32840, status: 'AWAITING_VPA', statusMessage: 'Waiting', approval: { required: false } }
    const lead = { _id: oid(), modelId: { name: 'iPhone 12' } }
    const body = buildPayoutSaleResponse(lead, payout, { paymentLink: null, notificationDelivered: true, message: 'A payout already exists for this device.' })
    expect(body.success).to.equal(true)
    expect(body.payout).to.include({ id: payout._id, amount: 32840, status: 'AWAITING_VPA', paymentLink: null, approvalRequired: false })
    expect(body.id).to.equal(lead._id)
  })
})
