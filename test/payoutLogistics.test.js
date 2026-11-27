// Customer payout -> logistics hand-off.
//
// Database calls are replaced with in-memory fakes so every scenario
// (including races and duplicate-key errors) runs without a MongoDB server.
import { expect } from 'chai'
import mongoose from 'mongoose'
import BuybackPayout, { PAYOUT_STATUS } from '../models/buybackPayoutModel.js'
import devicesLot from '../models/devicesLotModel.js'
import leads from '../models/leadsModel.js'
import UsersModel from '../models/UsersModel.js'
import {
  assignPayoutToLogistics,
  PayoutBusinessError,
} from '../services/buybackPayoutService.js'
import {
  PAYOUT_LOT_STATUS,
  LOT_SOURCE,
} from '../services/buybackPayout/logistics.js'
import { PAID_LOT_MATCH } from '../controller/logisticsHelpers.js'
import logisticsController from '../controller/logisticsController.js'
import pickupDevicesController from '../controller/pickupDevicesController.js'
import { listStorePayments } from '../services/storePaymentService.js'
import { executeErasure } from '../controller/erasureController.js'
import erasureRequestModel from '../models/erasureRequestModel.js'
import quoteLogModel from '../models/QuoteLogModel.js'

const oid = () => new mongoose.Types.ObjectId()

// A query-like value: chainable (select/populate/sort/...) and awaitable.
const chain = (value) => {
  const query = {
    select: () => query,
    populate: () => query,
    lean: () => query,
    sort: () => query,
    skip: () => query,
    limit: () => query,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  }
  return query
}

// Swap model statics for fakes; restore them after each test.
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

const companyId = oid()
const storeId = oid()
const otherStoreId = oid()

const makePayout = (overrides = {}) => ({
  _id: oid(),
  leadId: oid(),
  companyId,
  storeId,
  initiatedBy: oid(),
  amount: 2915,
  provider: 'HSBC_IMPS',
  status: PAYOUT_STATUS.SUCCESS,
  merchantOrderNo: '1795712242083304870',
  providerTransactionRrn: '',
  paidAt: new Date('2026-11-26T16:57:23.269Z'),
  logistics: undefined,
  ...overrides,
})

const makeActor = (role, overrides = {}) => ({
  _id: oid(),
  role,
  companyId,
  storeId: undefined,
  assignedStores: [],
  ...overrides,
})

/**
 * Wire the fakes for one hand-off attempt and record what was written.
 * Options let a test simulate an existing lot, a lost race, or failures.
 */
const setup = ({
  payout = makePayout(),
  actor = makeActor('Company Admin'),
  existingLot = null,
  createError = null,
  claimWins = true,
  leadHistoryError = null,
} = {}) => {
  const calls = { created: [], claimed: [], deleted: [], leadUpdates: [] }
  fake(BuybackPayout, 'findById', () => chain(payout))
  fake(UsersModel, 'findById', () => chain(actor))
  fake(devicesLot, 'findOne', () => chain(existingLot))
  fake(devicesLot, 'create', async (doc) => {
    if (createError) {
      throw createError
    }
    const lot = { _id: oid(), ...doc }
    calls.created.push(lot)
    return lot
  })
  fake(BuybackPayout, 'findOneAndUpdate', (filter, update) => {
    calls.claimed.push({ filter, update })
    if (!claimWins) {
      return chain(null)
    }
    payout.logistics = update.$set.logistics
    return chain(payout)
  })
  fake(devicesLot, 'deleteOne', async (filter) => {
    calls.deleted.push(filter)
    return { deletedCount: 1 }
  })
  fake(leads, 'updateOne', async (filter, update) => {
    if (leadHistoryError) {
      throw leadHistoryError
    }
    calls.leadUpdates.push({ filter, update })
    return { modifiedCount: 1 }
  })
  return { payout, actor, calls }
}

const expectBusinessError = async (promise, statusCode, messagePattern) => {
  try {
    await promise
  } catch (error) {
    expect(error).to.be.instanceOf(PayoutBusinessError)
    expect(error.statusCode).to.equal(statusCode)
    if (messagePattern) {
      expect(error.message).to.match(messagePattern)
    }
    return error
  }
  throw new Error('Expected a PayoutBusinessError')
}

describe('Payout -> logistics: models', () => {
  it('payout lots carry no store-payment fields', () => {
    const lot = new devicesLot({ source: 'PAYOUT', status: PAYOUT_LOT_STATUS, uniqueCode: 'x' })
    expect(lot.source).to.equal('PAYOUT')
    expect(lot.paymentMode).to.equal(undefined)
    expect(lot.paymentStatus).to.equal(undefined)
  })

  it('manual lots keep the store-payment defaults (unchanged behaviour)', () => {
    const lot = new devicesLot({ status: 'Payment Requested', uniqueCode: 'y' })
    expect(lot.source).to.equal(undefined)
    expect(lot.paymentMode).to.equal('COMPANY_ACCOUNTS')
    expect(lot.paymentStatus).to.equal('PAYMENT_REQUESTED')
  })

  it('rejects an unknown lot source', () => {
    const errors = new devicesLot({ source: 'OTHER' }).validateSync()?.errors || {}
    expect(errors.source).to.not.equal(undefined)
  })

  it('declares one lot per payout as a unique, partial index', () => {
    const index = devicesLot.schema
      .indexes()
      .find(([keys]) => keys.buybackPayoutId === 1)
    expect(index, 'buybackPayoutId index').to.not.equal(undefined)
    expect(index[1].unique).to.equal(true)
    expect(index[1].partialFilterExpression).to.deep.equal({
      buybackPayoutId: { $exists: true },
    })
  })

  it('new payouts start with no logistics hand-off', () => {
    expect(new BuybackPayout().logistics?.lotId).to.equal(undefined)
  })

  it('the lot status used is one the logistics screen treats as paid', () => {
    const paidStatuses = PAID_LOT_MATCH.$or[0].status.$in
    expect(paidStatuses).to.include(PAYOUT_LOT_STATUS)
  })
})

describe('Payout -> logistics: positive scenarios', () => {
  afterEach(restoreAll)

  it('Company Admin sends a paid payout: lot, payout and lead are all updated', async () => {
    const { payout, actor, calls } = setup()
    const result = await assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) })

    expect(calls.created).to.have.length(1)
    const lot = calls.created[0]
    expect(lot.source).to.equal(LOT_SOURCE.PAYOUT)
    expect(lot.buybackPayoutId).to.equal(payout._id)
    expect(lot.status).to.equal('Out For Pickup')
    expect(lot.totalDevice).to.equal(1)
    expect(lot.totalAmount).to.equal(2915)
    expect(lot.deviceList).to.deep.equal([payout.leadId])
    expect(lot.storeId).to.equal(storeId)
    expect(lot.companyId).to.equal(companyId)
    expect(lot.userId).to.equal(actor._id)
    expect(lot.uniqueCode).to.match(/^LOT-PO-\d{13}$/)
    expect(lot.paidAt).to.equal(payout.paidAt)
    expect(lot.paymentReference).to.equal('HSBC IMPS · Order 1795712242083304870')
    expect(lot.remarks).to.equal('Customer paid via HSBC IMPS · Order 1795712242083304870')
    expect(lot.history[0].action).to.equal('SENT_FROM_CUSTOMER_PAYOUT')

    // Claim is conditional so a second click cannot overwrite it.
    expect(calls.claimed[0].filter).to.deep.include({ 'logistics.lotId': { $exists: false } })
    expect(payout.logistics.lotCode).to.equal(lot.uniqueCode)
    expect(payout.logistics.assignedBy).to.equal(actor._id)

    expect(calls.leadUpdates).to.have.length(1)
    expect(calls.leadUpdates[0].filter).to.deep.equal({ _id: payout.leadId })
    expect(calls.leadUpdates[0].update.$push.history.action).to.equal('SENT_TO_LOGISTICS')

    expect(calls.deleted).to.have.length(0)
    expect(result).to.equal(payout)
  })

  it('the sales person who raised the payout can send it', async () => {
    const actor = makeActor('Sale User', { storeId })
    const payout = makePayout({ initiatedBy: actor._id })
    const { calls } = setup({ payout, actor })
    await assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) })
    expect(calls.created).to.have.length(1)
  })

  it('Accounts User of the company can send it (any store)', async () => {
    const { payout, actor, calls } = setup({ actor: makeActor('Accounts User') })
    await assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) })
    expect(calls.created).to.have.length(1)
  })

  it('Admin Manager of the company can send it', async () => {
    const { payout, actor, calls } = setup({ actor: makeActor('Admin Manager') })
    await assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) })
    expect(calls.created).to.have.length(1)
  })

  it('a Manager of that store can send it (own store)', async () => {
    const { payout, actor, calls } = setup({ actor: makeActor('Manager', { storeId }) })
    await assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) })
    expect(calls.created).to.have.length(1)
  })

  it('a Manager of that store can send it (assigned store)', async () => {
    const actor = makeActor('Manager', { storeId: otherStoreId, assignedStores: [storeId] })
    const { payout, calls } = setup({ actor })
    await assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) })
    expect(calls.created).to.have.length(1)
  })

  it('Super Admin can send a payout of any company', async () => {
    const actor = makeActor('Super Admin', { companyId: oid() })
    const { payout, calls } = setup({ actor })
    await assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) })
    expect(calls.created).to.have.length(1)
  })

  it('uses the RRN as the payment reference when HSBC returned one', async () => {
    const payout = makePayout({ providerTransactionRrn: '633012345678' })
    const { actor, calls } = setup({ payout })
    await assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) })
    expect(calls.created[0].paymentReference).to.equal('HSBC IMPS · RRN 633012345678')
  })

  it('labels UPI and NEFT payouts correctly', async () => {
    for (const [provider, label] of [['HSBC_UPI', 'HSBC UPI'], ['HSBC_NEFT', 'HSBC NEFT']]) {
      const payout = makePayout({ provider })
      const { actor, calls } = setup({ payout })
      await assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) })
      expect(calls.created[0].paymentReference).to.match(new RegExp(`^${label} · `))
      restoreAll()
    }
  })

  it('works without a note (the popup sends none)', async () => {
    const { payout, actor, calls } = setup()
    await assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) })
    expect(calls.created[0].history[0].remarks).to.equal('')
    expect(payout.logistics.remarks).to.equal('')
  })

  it('trims a note and caps it at 250 characters', async () => {
    const { payout, actor, calls } = setup()
    await assignPayoutToLogistics({
      payoutId: String(payout._id),
      actorId: String(actor._id),
      remarks: `   ${'x'.repeat(300)}   `,
    })
    expect(calls.created[0].remarks).to.have.length(250)
    expect(payout.logistics.remarks).to.have.length(250)
  })
})

describe('Payout -> logistics: negative scenarios', () => {
  afterEach(restoreAll)

  it('rejects an invalid payout id (400) without touching the database', async () => {
    const { calls } = setup()
    await expectBusinessError(
      assignPayoutToLogistics({ payoutId: 'not-an-id', actorId: String(oid()) }),
      400,
      /Invalid payout ID/,
    )
    expect(calls.created).to.have.length(0)
  })

  it('rejects an unknown payout (404)', async () => {
    setup({ payout: null })
    await expectBusinessError(
      assignPayoutToLogistics({ payoutId: String(oid()), actorId: String(oid()) }),
      404,
      /Payout not found/,
    )
  })

  it('rejects an unknown / deleted user (401)', async () => {
    const { payout, calls } = setup({ actor: null })
    await expectBusinessError(
      assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(oid()) }),
      401,
    )
    expect(calls.created).to.have.length(0)
  })

  it('rejects a user from another company (403)', async () => {
    const { payout, actor, calls } = setup({ actor: makeActor('Company Admin', { companyId: oid() }) })
    await expectBusinessError(
      assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) }),
      403,
      /Access denied/,
    )
    expect(calls.created).to.have.length(0)
  })

  it('rejects a Manager of a different store (403)', async () => {
    const { payout, actor, calls } = setup({ actor: makeActor('Manager', { storeId: otherStoreId }) })
    await expectBusinessError(
      assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) }),
      403,
      /assigned stores/,
    )
    expect(calls.created).to.have.length(0)
  })

  it('rejects a Sale User who did not raise the payout (403)', async () => {
    const { payout, actor, calls } = setup({ actor: makeActor('Sale User', { storeId }) })
    await expectBusinessError(
      assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) }),
      403,
      /sales person or an administrator/,
    )
    expect(calls.created).to.have.length(0)
  })

  it('rejects roles that have no part in this flow (403)', async () => {
    for (const role of ['Technician', 'Store Admin', 'Logistics Admin']) {
      const { payout, actor, calls } = setup({ actor: makeActor(role, { storeId }) })
      await expectBusinessError(
        assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) }),
        403,
      )
      expect(calls.created, role).to.have.length(0)
      restoreAll()
    }
  })

  it('rejects every payout status except SUCCESS (409), creating nothing', async () => {
    const notPaid = Object.values(PAYOUT_STATUS).filter((s) => s !== PAYOUT_STATUS.SUCCESS)
    expect(notPaid.length).to.be.greaterThan(0)
    for (const status of notPaid) {
      const { payout, actor, calls } = setup({ payout: makePayout({ status }) })
      await expectBusinessError(
        assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) }),
        409,
        /Only a successful payout/,
      )
      expect(calls.created, status).to.have.length(0)
      restoreAll()
    }
  })

  it('rejects a payout already sent to logistics (409) and names the lot', async () => {
    const payout = makePayout({ logistics: { lotId: oid(), lotCode: 'LOT-PO-1795717406560' } })
    const { actor, calls } = setup({ payout })
    await expectBusinessError(
      assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) }),
      409,
      /LOT-PO-1795717406560/,
    )
    expect(calls.created).to.have.length(0)
  })

  it('rejects a device that is already in a manual lot (409) and names it', async () => {
    const { payout, actor, calls } = setup({
      existingLot: { uniqueCode: 'LOT-1793770648015', status: 'Pending Payment Confirmation' },
    })
    await expectBusinessError(
      assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) }),
      409,
      /LOT-1793770648015 \(Pending Payment Confirmation\)/,
    )
    expect(calls.created).to.have.length(0)
  })
})

describe('Payout -> logistics: rare scenarios', () => {
  afterEach(restoreAll)

  it('two clicks at once: the database unique index rejects the second lot (409)', async () => {
    const duplicate = Object.assign(new Error('E11000 duplicate key'), { code: 11000 })
    const { payout, actor, calls } = setup({ createError: duplicate })
    await expectBusinessError(
      assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) }),
      409,
      /already sent to logistics/,
    )
    expect(calls.claimed).to.have.length(0)
  })

  it('two clicks at once without the index: the loser deletes its own lot (409)', async () => {
    const { payout, actor, calls } = setup({ claimWins: false })
    await expectBusinessError(
      assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) }),
      409,
      /already sent to logistics/,
    )
    expect(calls.created).to.have.length(1)
    expect(calls.deleted).to.deep.equal([{ _id: calls.created[0]._id }])
    expect(calls.leadUpdates).to.have.length(0)
  })

  it('a database outage while creating the lot surfaces as a server error', async () => {
    const { payout, actor } = setup({ createError: new Error('connection reset') })
    try {
      await assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) })
      throw new Error('expected failure')
    } catch (error) {
      expect(error).to.not.be.instanceOf(PayoutBusinessError)
      expect(error.message).to.equal('connection reset')
    }
  })

  it('a failed lead-history write does not undo a successful hand-off', async () => {
    const { payout, actor, calls } = setup({ leadHistoryError: new Error('timeout') })
    const result = await assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) })
    expect(calls.created).to.have.length(1)
    expect(calls.deleted).to.have.length(0)
    expect(result.logistics.lotCode).to.equal(calls.created[0].uniqueCode)
  })

  it('the payout is checked before any write, even for an admin', async () => {
    const { payout, actor, calls } = setup({ payout: makePayout({ status: PAYOUT_STATUS.FAILED }) })
    await expectBusinessError(
      assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) }),
      409,
    )
    expect(calls.created).to.have.length(0)
    expect(calls.claimed).to.have.length(0)
    expect(calls.leadUpdates).to.have.length(0)
  })
})

// A minimal Express response that records status and body.
const fakeRes = () => {
  const res = { statusCode: 200, body: undefined }
  res.status = (code) => {
    res.statusCode = code
    return res
  }
  res.json = (body) => {
    res.body = body
    return res
  }
  res.set = () => res
  return res
}

describe('Logistics screen: Source filter', () => {
  afterEach(restoreAll)

  const runList = async (query) => {
    let pipeline
    fake(devicesLot, 'aggregate', (stages) => {
      pipeline = stages
      return { allowDiskUse: async () => [{ total: [{ count: 0 }], items: [] }] }
    })
    const res = fakeRes()
    await logisticsController.paidLeads({ query }, res)
    return { res, match: pipeline?.[0]?.$match, pipeline }
  }

  it('no source: lists every paid lot, payout and manual', async () => {
    const { res, match } = await runList({})
    expect(res.statusCode).to.equal(200)
    expect(match).to.not.have.property('source')
    expect(match.$or).to.deep.equal(PAID_LOT_MATCH.$or)
  })

  it('Customer Payout tab: only payout lots', async () => {
    const { match } = await runList({ source: 'PAYOUT' })
    expect(match.source).to.equal('PAYOUT')
    expect(match.$or).to.deep.equal(PAID_LOT_MATCH.$or)
  })

  it('Manual tab: everything that is not a payout lot (older lots included)', async () => {
    const { match } = await runList({ source: 'MANUAL' })
    expect(match.source).to.deep.equal({ $ne: 'PAYOUT' })
  })

  it('combines with the other filters', async () => {
    const { match } = await runList({ source: 'PAYOUT', lotNo: 'LOT-PO' })
    expect(match.source).to.equal('PAYOUT')
    expect(match.uniqueCode.$regex).to.equal('LOT-PO')
  })

  it('rejects an unknown source value (400)', async () => {
    const { res } = await runList({ source: 'SOMETHING' })
    expect(res.statusCode).to.equal(400)
    expect(res.body.message).to.match(/source/)
  })

  it('every row reports its source, defaulting older lots to MANUAL', async () => {
    const { pipeline } = await runList({})
    const facet = pipeline.find((stage) => stage.$facet).$facet
    const projection = facet.items.find((stage) => stage.$project).$project
    expect(projection.source).to.deep.equal({ $ifNull: ['$source', 'MANUAL'] })
    expect(projection).to.have.property('paymentReference')
    expect(projection).to.have.property('paidAt')
  })
})

describe('Payout lots stay off the manual screens', () => {
  afterEach(restoreAll)

  it('Store Payments never lists payout lots', async () => {
    const actor = { _id: oid(), role: 'Accounts User', companyId, status: true }
    let filter
    fake(UsersModel, 'findById', () => chain(actor))
    fake(devicesLot, 'find', (f) => {
      filter = f
      return chain([])
    })
    fake(devicesLot, 'countDocuments', async () => 0)
    await listStorePayments({ actorId: String(actor._id), query: {} })
    expect(filter.source).to.deep.equal({ $ne: 'PAYOUT' })
    expect(String(filter.companyId)).to.equal(String(companyId))
  })

  it('Pickup & Cancel (active and history) never lists payout lots', async () => {
    const superAdmin = { _id: oid(), role: 'Super Admin' }
    for (const handler of ['allLots', 'lotsHistory']) {
      let pipeline
      fake(UsersModel, 'findById', () => chain(superAdmin))
      fake(devicesLot, 'aggregate', async (stages) => {
        pipeline = stages
        return []
      })
      const res = fakeRes()
      await pickupDevicesController[handler]({ userId: String(superAdmin._id), query: {} }, res)
      expect(res.statusCode, handler).to.equal(200)
      expect(pipeline[0].$match.source, handler).to.deep.equal({ $ne: 'PAYOUT' })
      expect(pipeline[0].$match.paymentStatus, handler).to.deep.equal({ $exists: false })
      restoreAll()
    }
  })
})

describe('User erasure keeps payout lots', () => {
  afterEach(restoreAll)

  it('deletes the user\'s manual lots but never lots sent from Customer Payouts', async () => {
    const userId = oid()
    const request = {
      userId,
      status: 'PENDING',
      scheduledDeletionDate: new Date(Date.now() - 1000),
      save: async () => request,
    }
    const deletes = {}
    const record = (name) => async (filter) => {
      deletes[name] = filter
      return { deletedCount: 0 }
    }
    fake(erasureRequestModel, 'findById', async () => request)
    fake(leads, 'deleteMany', record('leads'))
    fake(devicesLot, 'deleteMany', record('lots'))
    fake(quoteLogModel, 'deleteMany', record('quotes'))
    fake(UsersModel, 'deleteOne', async () => ({ deletedCount: 1 }))

    const res = fakeRes()
    await executeErasure(
      { params: { requestId: String(oid()) }, userId: String(oid()), get: () => '' },
      res,
    )

    expect(res.statusCode).to.equal(200)
    expect(deletes.lots).to.deep.equal({ userId, source: { $ne: 'PAYOUT' } })
    // Everything else the user owns is still erased as before.
    expect(deletes.leads).to.deep.equal({ userId })
    expect(deletes.quotes).to.deep.equal({ userId })
    expect(request.status).to.equal('COMPLETED')
  })
})

describe('Accounts User: Send to Logistics for any store of their company', () => {
  afterEach(restoreAll)

  it('works for payouts of different stores of the same company', async () => {
    for (const payoutStore of [storeId, otherStoreId]) {
      const actor = makeActor('Accounts User')
      const { payout, calls } = setup({ payout: makePayout({ storeId: payoutStore }), actor })
      await assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) })
      expect(calls.created, String(payoutStore)).to.have.length(1)
      expect(String(calls.created[0].storeId)).to.equal(String(payoutStore))
      restoreAll()
    }
  })

  it('is refused for a payout of another company', async () => {
    const { payout, actor, calls } = setup({ actor: makeActor('Accounts User', { companyId: oid() }) })
    await expectRefused403(assignPayoutToLogistics({ payoutId: String(payout._id), actorId: String(actor._id) }))
    expect(calls.created).to.have.length(0)
  })
})

async function expectRefused403(promise) {
  try {
    await promise
  } catch (error) {
    expect(error.statusCode).to.equal(403)
    return
  }
  throw new Error('Expected 403')
}
