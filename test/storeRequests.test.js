// Store Requests tab (Customer Payouts): list filters, receipt upload on
// Confirm Payment, and hand-off of paid requests to Logistics. Database
// calls are in-memory fakes.
import { expect } from 'chai'
import mongoose from 'mongoose'
import devicesLot from '../models/devicesLotModel.js'
import UsersModel from '../models/UsersModel.js'
import storeModel from '../models/storeModel.js'
import {
  listStorePayments,
  markStorePaymentPaid,
  nextLotCode,
  StorePaymentError,
} from '../services/storePaymentService.js'
import { PAID_LOT_MATCH } from '../controller/logisticsHelpers.js'

const oid = () => new mongoose.Types.ObjectId()

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

const expectRefused = async (promise, statusCode, pattern) => {
  try {
    await promise
  } catch (error) {
    expect(error).to.be.instanceOf(StorePaymentError)
    expect(error.statusCode).to.equal(statusCode)
    if (pattern) {
      expect(error.message).to.match(pattern)
    }
    return
  }
  throw new Error('Expected the request to be refused')
}

describe('Store Requests: list filters', () => {
  afterEach(restoreAll)

  const run = async (actor, query, { regionStores = [], lotStores = [], stores = [] } = {}) => {
    let filter
    fake(UsersModel, 'findById', () => chain({ status: true, ...actor }))
    fake(devicesLot, 'find', (f) => {
      filter = f
      return chain([])
    })
    fake(devicesLot, 'countDocuments', async () => 0)
    fake(devicesLot, 'distinct', async () => lotStores)
    fake(storeModel, 'find', (q) => chain(q.region ? regionStores : stores))
    const result = await listStorePayments({ actorId: String(actor._id), query })
    return { filter, result }
  }

  const admin = () => ({ _id: oid(), role: 'Company Admin', companyId })

  it('default (Store Payments screen): unchanged, no extra filters', async () => {
    const { filter, result } = await run(admin(), {})
    expect(filter).to.deep.equal({ source: { $ne: 'PAYOUT' }, companyId })
    expect(result).to.not.have.property('stores')
  })

  it('requestsOnly: hides old pickup lots (they have no paymentMode)', async () => {
    const { filter } = await run(admin(), { requestsOnly: 'true' })
    expect(filter.paymentMode).to.deep.equal({ $exists: true })
  })

  it('lot search is a safe, case-insensitive contains match', async () => {
    const { filter } = await run(admin(), { search: ' PAY-17(86 ' })
    expect(filter.uniqueCode).to.deep.equal({ $regex: 'PAY-17\\(86', $options: 'i' })
  })

  it('date range covers the whole of both days', async () => {
    const { filter } = await run(admin(), { fromDate: '2026-08-12', toDate: '2026-08-13' })
    expect(filter.createdAt.$gte.getHours()).to.equal(0)
    expect(filter.createdAt.$lte.getHours()).to.equal(23)
    expect(filter.createdAt.$lte > filter.createdAt.$gte).to.equal(true)
  })

  it('refuses a one-sided, invalid or reversed date range (400)', async () => {
    await expectRefused(run(admin(), { fromDate: '2026-08-12' }), 400, /both a valid/)
    await expectRefused(run(admin(), { fromDate: 'x', toDate: '2026-08-12' }), 400)
    await expectRefused(run(admin(), { fromDate: '2026-08-13', toDate: '2026-08-12' }), 400, /before/)
  })

  it('region narrows to that region\'s stores', async () => {
    const a = oid()
    const b = oid()
    const { filter } = await run(admin(), { region: 'South' }, { regionStores: [{ _id: a }, { _id: b }] })
    expect(filter.storeId.$in.map(String)).to.deep.equal([String(a), String(b)])
  })

  it('region never widens a Manager beyond their own stores', async () => {
    const own = oid()
    const other = oid()
    const manager = { _id: oid(), role: 'Manager', companyId, storeId: own, assignedStores: [] }
    const { filter } = await run(manager, { region: 'South' }, { regionStores: [{ _id: own }, { _id: other }] })
    expect(filter.storeId.$in.map(String)).to.deep.equal([String(own)])
  })

  it('region with a picked store keeps only that store if it is in the region', async () => {
    const inRegion = oid()
    const { filter } = await run(admin(), { region: 'South', storeId: String(oid()) }, { regionStores: [{ _id: inRegion }] })
    expect(filter.storeId.$in).to.deep.equal([])
  })

  it('withStores returns the stores for the filter dropdowns', async () => {
    const storeId = oid()
    const { result } = await run(admin(), { withStores: 'true' }, {
      lotStores: [storeId],
      stores: [{ _id: storeId, storeName: 'Payout at store', region: 'North' }],
    })
    expect(result.stores).to.deep.equal([{ _id: storeId, storeName: 'Payout at store', region: 'North' }])
  })

  it('roles outside the flow still cannot list (403)', async () => {
    await expectRefused(run({ _id: oid(), role: 'Sale User', companyId }, {}), 403)
  })
})

describe('Store Requests: Confirm Payment receipt upload', () => {
  afterEach(restoreAll)

  const setup = ({ actorRole = 'Accounts User', lot: lotOverrides = {}, claimModified = 0 } = {}) => {
    const actor = { _id: oid(), role: actorRole, companyId, status: true }
    const lot = {
      _id: oid(),
      companyId,
      storeId: oid(),
      paymentMode: 'COMPANY_ACCOUNTS',
      paymentStatus: 'PAYMENT_REQUESTED',
      ...lotOverrides,
    }
    const calls = { uploads: 0, claims: 0 }
    fake(UsersModel, 'findById', () => chain(actor))
    fake(devicesLot, 'findById', async () => lot)
    fake(devicesLot, 'updateOne', async () => {
      calls.claims += 1
      return { modifiedCount: claimModified }
    })
    return { actor, lot, calls }
  }

  const uploader = (calls, impl = async () => 'https://s3.example/receipt.pdf') => async (file) => {
    calls.uploads += 1
    calls.uploadedName = file.originalname
    return impl(file)
  }

  const file = { originalname: 'receipt.pdf', mimetype: 'application/pdf', buffer: Buffer.from('x') }

  it('uploads the receipt after the checks and before claiming the payment', async () => {
    const { actor, lot, calls } = setup()
    // Claim returns 0 so the flow stops right after claiming; enough to prove order.
    await expectRefused(
      markStorePaymentPaid({
        actorId: String(actor._id),
        paymentId: String(lot._id),
        receiptFile: file,
        uploadReceipt: uploader(calls),
      }),
      409,
      /already being processed/,
    )
    expect(calls.uploads).to.equal(1)
    expect(calls.uploadedName).to.equal('receipt.pdf')
    expect(calls.claims).to.equal(1)
  })

  it('a user who may not pay never uploads anything (403)', async () => {
    const { actor, lot, calls } = setup({ actorRole: 'Company Admin' })
    await expectRefused(
      markStorePaymentPaid({ actorId: String(actor._id), paymentId: String(lot._id), receiptFile: file, uploadReceipt: uploader(calls) }),
      403,
    )
    expect(calls.uploads).to.equal(0)
    expect(calls.claims).to.equal(0)
  })

  it('a flagged or already paid request never uploads anything (409)', async () => {
    for (const paymentStatus of ['FLAGGED', 'PAYMENT_DONE']) {
      const { actor, lot, calls } = setup({ lot: { paymentStatus } })
      await expectRefused(
        markStorePaymentPaid({ actorId: String(actor._id), paymentId: String(lot._id), receiptFile: file, uploadReceipt: uploader(calls) }),
        409,
      )
      expect(calls.uploads, paymentStatus).to.equal(0)
      restoreAll()
    }
  })

  it('a failed upload stops before anything changes (400)', async () => {
    const { actor, lot, calls } = setup()
    await expectRefused(
      markStorePaymentPaid({
        actorId: String(actor._id),
        paymentId: String(lot._id),
        receiptFile: file,
        uploadReceipt: uploader(calls, async () => {
          throw new Error('Invalid file type')
        }),
      }),
      400,
      /Receipt upload failed: Invalid file type/,
    )
    expect(calls.claims).to.equal(0)
  })

  it('without a file nothing is uploaded (a PDF receipt is generated later)', async () => {
    const { actor, lot, calls } = setup()
    await expectRefused(
      markStorePaymentPaid({ actorId: String(actor._id), paymentId: String(lot._id), uploadReceipt: uploader(calls) }),
      409,
    )
    expect(calls.uploads).to.equal(0)
    expect(calls.claims).to.equal(1)
  })
})

describe('Store Requests: paid requests go to Logistics', () => {
  it('Logistics treats a Payment Done store request as paid', () => {
    expect(PAID_LOT_MATCH.$or).to.deep.include({ paymentStatus: 'PAYMENT_DONE' })
  })

  it('requests still waiting for payment do not reach Logistics', () => {
    const conditions = PAID_LOT_MATCH.$or
    const matches = (lot) =>
      conditions.some((condition) =>
        Object.entries(condition).every(([key, rule]) => {
          if (rule && typeof rule === 'object' && '$in' in rule) {
            return rule.$in.includes(lot[key])
          }
          if (rule && typeof rule === 'object') {
            return false
          }
          return lot[key] === rule
        }),
      )
    expect(matches({ status: 'Payment Requested', paymentStatus: 'PAYMENT_REQUESTED' })).to.equal(false)
    expect(matches({ status: 'Flagged', paymentStatus: 'FLAGGED' })).to.equal(false)
    expect(matches({ status: 'Payment Done', paymentStatus: 'PAYMENT_DONE' })).to.equal(true)
  })
})

describe('Store Requests: lot number', () => {
  afterEach(restoreAll)

  it('uses the original LOT-<milliseconds> format', async () => {
    fake(devicesLot, 'exists', async () => null)
    expect(await nextLotCode(1795717406560)).to.equal('LOT-1795717406560')
  })

  it('moves to the next free number when two requests share a millisecond', async () => {
    const taken = new Set(['LOT-1795717406560', 'LOT-1795717406561'])
    fake(devicesLot, 'exists', async ({ uniqueCode }) => (taken.has(uniqueCode) ? { _id: oid() } : null))
    expect(await nextLotCode(1795717406560)).to.equal('LOT-1795717406562')
  })

  it('gives a clear error if no free number is found', async () => {
    fake(devicesLot, 'exists', async () => ({ _id: oid() }))
    await expectRefused(nextLotCode(1795717406560), 409, /lot number/)
  })
})
