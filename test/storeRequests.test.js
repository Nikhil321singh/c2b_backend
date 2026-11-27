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
  getStorePayment,
  flagStorePayment,
  unflagStorePayment,
  createStorePaymentRequest,
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
    expect(filter.$or).to.deep.equal([{ uniqueCode: { $regex: 'PAY-17\\(86', $options: 'i' } }])
  })

  it('search also matches requests of stores whose name matches', async () => {
    const storeId = oid()
    const { filter } = await run(admin(), { search: 'payout at' }, { stores: [{ _id: storeId }] })
    expect(filter.$or).to.have.length(2)
    expect(filter.$or[1].storeId.$in.map(String)).to.deep.equal([String(storeId)])
    // The company scope still applies on top of the search.
    expect(filter.companyId).to.equal(companyId)
  })

  it('search never widens a Manager beyond their own stores', async () => {
    const own = oid()
    const manager = { _id: oid(), role: 'Manager', companyId, storeId: own, assignedStores: [] }
    const { filter } = await run(manager, { search: 'store' }, { stores: [{ _id: oid() }] })
    expect(filter.storeId.$in.map(String)).to.deep.equal([String(own)])
    expect(filter.$or).to.have.length(2)
  })

  it('passes page and limit through and caps the page size at 100', async () => {
    let skipped
    let limited
    fake(UsersModel, 'findById', () => chain({ status: true, ...admin() }))
    fake(devicesLot, 'find', () => {
      const query = chain([])
      query.skip = (n) => {
        skipped = n
        return query
      }
      query.limit = (n) => {
        limited = n
        return query
      }
      return query
    })
    fake(devicesLot, 'countDocuments', async () => 164)
    const result = await listStorePayments({ actorId: String(oid()), query: { page: '2', limit: '500' } })
    expect(limited).to.equal(100)
    expect(skipped).to.equal(200)
    expect(result).to.include({ total: 164, page: 2, limit: 100 })
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

describe('Store Payments: only the own company of the user', () => {
  afterEach(restoreAll)

  const noCompany = (role) => ({ _id: oid(), role, status: true })

  const wire = (actor) => {
    const touched = { find: 0, findById: 0 }
    fake(UsersModel, 'findById', () => chain(actor))
    fake(devicesLot, 'find', () => {
      touched.find += 1
      return chain([])
    })
    fake(devicesLot, 'countDocuments', async () => 0)
    fake(devicesLot, 'findById', async () => {
      touched.findById += 1
      return { _id: oid(), paymentStatus: 'PAYMENT_REQUESTED' }
    })
    return touched
  }

  for (const role of ['Accounts User', 'Company Admin', 'Store Admin', 'Manager']) {
    it(`${role} with no company is refused before any data is read (403)`, async () => {
      const actor = noCompany(role)
      const touched = wire(actor)
      const id = String(actor._id)
      const lotId = String(oid())
      await expectRefused(listStorePayments({ actorId: id, query: {} }), 403, /not linked to a company/)
      await expectRefused(getStorePayment({ actorId: id, paymentId: lotId }), 403, /not linked to a company/)
      await expectRefused(flagStorePayment({ actorId: id, paymentId: lotId, reason: 'x' }), 403, /not linked to a company/)
      await expectRefused(unflagStorePayment({ actorId: id, paymentId: lotId }), 403, /not linked to a company/)
      await expectRefused(markStorePaymentPaid({ actorId: id, paymentId: lotId }), 403, /not linked to a company/)
      expect(touched.find).to.equal(0)
      expect(touched.findById).to.equal(0)
    })
  }

  it('a user with no company cannot raise a payment request (403)', async () => {
    const actor = noCompany('Store Admin')
    fake(UsersModel, 'findById', () => chain(actor))
    const leadsModel = (await import('../models/leadsModel.js')).default
    fake(leadsModel, 'find', () => chain([]))
    await expectRefused(
      createStorePaymentRequest({ actorId: String(actor._id), leadIds: [String(oid())] }),
      403,
      /not linked to a company/,
    )
  })

  it('Super Admin without a company still sees all companies', async () => {
    const actor = { _id: oid(), role: 'Super Admin', status: true }
    let filter
    fake(UsersModel, 'findById', () => chain(actor))
    fake(devicesLot, 'find', (f) => {
      filter = f
      return chain([])
    })
    fake(devicesLot, 'countDocuments', async () => 0)
    await listStorePayments({ actorId: String(actor._id), query: {} })
    expect(filter).to.not.have.property('companyId')
  })

  it('a company user is limited to their own company', async () => {
    const actor = { _id: oid(), role: 'Accounts User', companyId, status: true }
    let filter
    fake(UsersModel, 'findById', () => chain(actor))
    fake(devicesLot, 'find', (f) => {
      filter = f
      return chain([])
    })
    fake(devicesLot, 'countDocuments', async () => 0)
    await listStorePayments({ actorId: String(actor._id), query: {} })
    expect(String(filter.companyId)).to.equal(String(companyId))
  })

  it('a company user cannot open an old lot that has no company (403)', async () => {
    const actor = { _id: oid(), role: 'Accounts User', companyId, status: true }
    fake(UsersModel, 'findById', () => chain(actor))
    fake(devicesLot, 'findById', async () => ({ _id: oid(), storeId: oid() }))
    await expectRefused(
      getStorePayment({ actorId: String(actor._id), paymentId: String(oid()) }),
      403,
      /another company/,
    )
  })
})

describe('Accounts User: every store of their company (Store Payments)', () => {
  afterEach(restoreAll)

  const listAs = async (actor, query = {}) => {
    let filter
    fake(UsersModel, 'findById', () => chain({ status: true, ...actor }))
    fake(devicesLot, 'find', (f) => {
      filter = f
      return chain([])
    })
    fake(devicesLot, 'countDocuments', async () => 0)
    await listStorePayments({ actorId: String(actor._id), query })
    return filter
  }

  it('lists requests of all stores of the company (no store limit)', async () => {
    const filter = await listAs({ _id: oid(), role: 'Accounts User', companyId })
    expect(String(filter.companyId)).to.equal(String(companyId))
    expect(filter).to.not.have.property('storeId')
  })

  it('a store set on the Accounts User profile does not narrow the list', async () => {
    const filter = await listAs({ _id: oid(), role: 'Accounts User', companyId, storeId: oid(), assignedStores: [oid()] })
    expect(filter).to.not.have.property('storeId')
  })

  it('can filter to any one store of the company', async () => {
    const anyStore = oid()
    const filter = await listAs({ _id: oid(), role: 'Accounts User', companyId }, { storeId: String(anyStore) })
    expect(String(filter.storeId)).to.equal(String(anyStore))
    expect(String(filter.companyId)).to.equal(String(companyId))
  })

  it('compared with a Store Admin, who is limited to their own store', async () => {
    const own = oid()
    const filter = await listAs({ _id: oid(), role: 'Store Admin', companyId, storeId: own })
    expect(filter.storeId.$in.map(String)).to.deep.equal([String(own)])
  })

  it('can open and pay a request from any store of the company', async () => {
    const actor = { _id: oid(), role: 'Accounts User', companyId, status: true }
    for (const storeId of [oid(), oid()]) {
      fake(UsersModel, 'findById', () => chain(actor))
      const lot = {
        _id: oid(),
        companyId,
        storeId,
        paymentMode: 'COMPANY_ACCOUNTS',
        paymentStatus: 'PAYMENT_REQUESTED',
        history: [],
        viewLog: [],
        save: async () => lot,
      }
      fake(devicesLot, 'findById', () => {
        const query = chain(lot)
        return Object.assign(Promise.resolve(lot), query)
      })
      // View: passes scope and records the view.
      await getStorePayment({ actorId: String(actor._id), paymentId: String(lot._id) }).catch((error) => {
        if (error instanceof StorePaymentError) {
          throw error
        }
      })
      expect(lot.viewLog).to.have.length(1)
      // Pay: passes scope and payer checks (stops at the fake claim).
      fake(devicesLot, 'updateOne', async () => ({ modifiedCount: 0 }))
      await expectRefused(
        markStorePaymentPaid({ actorId: String(actor._id), paymentId: String(lot._id) }),
        409,
        /already being processed/,
      )
      restoreAll()
    }
  })

  it('cannot open a request of another company', async () => {
    const actor = { _id: oid(), role: 'Accounts User', companyId, status: true }
    fake(UsersModel, 'findById', () => chain(actor))
    fake(devicesLot, 'findById', async () => ({ _id: oid(), companyId: oid(), storeId: oid() }))
    await expectRefused(
      getStorePayment({ actorId: String(actor._id), paymentId: String(oid()) }),
      403,
      /another company/,
    )
  })
})
