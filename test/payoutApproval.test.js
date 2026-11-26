// Customer payout approval flow. Database calls are replaced with in-memory
// fakes; no MongoDB, HSBC or email traffic.
import { expect } from 'chai'
import mongoose from 'mongoose'
import BuybackPayout, { PAYOUT_STATUS } from '../models/buybackPayoutModel.js'
import leads from '../models/leadsModel.js'
import UsersModel from '../models/UsersModel.js'
import notificationModel from '../models/notificationModel.js'
import {
  approvePayout,
  makePayout,
  PayoutBusinessError,
} from '../services/buybackPayoutService.js'
import { requiresApproval } from '../services/buybackPayout/settings.js'

const oid = () => new mongoose.Types.ObjectId()

const chain = (value) => {
  const query = {
    select: () => query,
    populate: () => query,
    lean: () => query,
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
const storeId = oid()

const pendingPayout = (overrides = {}) => ({
  _id: oid(),
  leadId: oid(),
  companyId,
  storeId,
  initiatedBy: oid(),
  amount: 2915,
  status: PAYOUT_STATUS.PENDING_APPROVAL,
  approval: { required: true, threshold: 0, status: 'PENDING' },
  ...overrides,
})

const user = (role, overrides = {}) => ({
  _id: oid(),
  role,
  companyId,
  storeId: undefined,
  assignedStores: [],
  ...overrides,
})

const setup = ({ payout = pendingPayout(), actor = user('Company Admin'), raceLost = false } = {}) => {
  const calls = { decided: [], leadUpdates: [], notifications: [] }
  fake(BuybackPayout, 'findById', () => chain(payout))
  fake(UsersModel, 'findById', () => chain(actor))
  fake(BuybackPayout, 'findOneAndUpdate', (filter, update) => {
    calls.decided.push({ filter, update })
    if (raceLost) {
      return chain(null)
    }
    return chain({ ...payout, ...flatten(update.$set) })
  })
  fake(leads, 'findByIdAndUpdate', async (id, update) => {
    calls.leadUpdates.push({ id, update })
    return {}
  })
  // Rejection emails look the lead up first; failing here keeps the test
  // offline (the service catches notification errors by design).
  fake(leads, 'findById', () => {
    throw new Error('offline test: no customer email')
  })
  fake(notificationModel, 'create', async (doc) => {
    calls.notifications.push(doc)
    return doc
  })
  return { payout, actor, calls }
}

// Turn {'approval.status': x, status: y} into a nested object.
const flatten = (set) => {
  const out = {}
  for (const [path, value] of Object.entries(set)) {
    const keys = path.split('.')
    let node = out
    keys.slice(0, -1).forEach((key) => {
      node[key] = node[key] || {}
      node = node[key]
    })
    node[keys.at(-1)] = value
  }
  return out
}

const expectRefused = async (promise, statusCode, pattern) => {
  try {
    await promise
  } catch (error) {
    expect(error).to.be.instanceOf(PayoutBusinessError)
    expect(error.statusCode).to.equal(statusCode)
    if (pattern) {
      expect(error.message).to.match(pattern)
    }
    return
  }
  throw new Error('Expected the request to be refused')
}

describe('Payout approval: when is approval required', () => {
  const settings = (approvalEnabled, approvalThreshold) => ({ approvalEnabled, approvalThreshold })

  it('approval off: never required', () => {
    expect(requiresApproval(settings(false, 0), 100000)).to.equal(false)
  })

  it('approval on, amount 0: every payout needs approval', () => {
    expect(requiresApproval(settings(true, 0), 1)).to.equal(true)
    expect(requiresApproval(settings(true, 0), 2915)).to.equal(true)
  })

  it('approval on, amount 2000: only payouts of 2000 or more', () => {
    expect(requiresApproval(settings(true, 2000), 1999.99)).to.equal(false)
    expect(requiresApproval(settings(true, 2000), 2000)).to.equal(true)
    expect(requiresApproval(settings(true, 2000), 2915)).to.equal(true)
  })

  it('approval on, amount 5000: a 2915 payout goes straight through', () => {
    expect(requiresApproval(settings(true, 5000), 2915)).to.equal(false)
  })
})

describe('Payout approval: approve', () => {
  afterEach(restoreAll)

  it('Company Admin approves: payout becomes Ready for payment', async () => {
    const { payout, actor, calls } = setup()
    const result = await approvePayout({ payoutId: String(payout._id), actorId: String(actor._id), approved: true })

    expect(result.status).to.equal(PAYOUT_STATUS.READY_FOR_PAYMENT)
    expect(result.approval.status).to.equal('APPROVED')
    expect(String(result.approval.decidedBy)).to.equal(String(actor._id))
    expect(result.approval.decidedAt).to.be.instanceOf(Date)
    // Only a still-pending payout can be decided.
    expect(calls.decided[0].filter).to.deep.include({
      status: PAYOUT_STATUS.PENDING_APPROVAL,
      'approval.status': 'PENDING',
    })
    // Lead status sync + lead history.
    expect(calls.leadUpdates.some((u) => u.update.payoutStatus === PAYOUT_STATUS.READY_FOR_PAYMENT)).to.equal(true)
    expect(calls.leadUpdates.some((u) => u.update.$push?.history?.action === 'HSBC UPI payout approved')).to.equal(true)
    // Sales person is notified in-app.
    expect(calls.notifications).to.have.length(1)
    expect(String(calls.notifications[0].userId)).to.equal(String(payout.initiatedBy))
    expect(calls.notifications[0].title).to.equal('Customer payout approved')
  })

  it('Super Admin can approve', async () => {
    const { payout, actor } = setup({ actor: user('Super Admin', { companyId: oid() }) })
    const result = await approvePayout({ payoutId: String(payout._id), actorId: String(actor._id), approved: true })
    expect(result.status).to.equal(PAYOUT_STATUS.READY_FOR_PAYMENT)
  })

  // Admin Managers approve only for their assigned stores (same rule as the
  // approval e-mail recipients in customer.js).
  it('an Admin Manager assigned to the store can approve', async () => {
    const { payout, actor } = setup({ actor: user('Admin Manager', { assignedStores: [storeId] }) })
    const result = await approvePayout({ payoutId: String(payout._id), actorId: String(actor._id), approved: true })
    expect(result.status).to.equal(PAYOUT_STATUS.READY_FOR_PAYMENT)
  })

  it('the store Manager can approve', async () => {
    const { payout, actor } = setup({ actor: user('Manager', { storeId }) })
    const result = await approvePayout({ payoutId: String(payout._id), actorId: String(actor._id), approved: true })
    expect(result.status).to.equal(PAYOUT_STATUS.READY_FOR_PAYMENT)
  })

  it('a Manager with the store in assignedStores can approve', async () => {
    const { payout, actor } = setup({ actor: user('Manager', { storeId: oid(), assignedStores: [storeId] }) })
    const result = await approvePayout({ payoutId: String(payout._id), actorId: String(actor._id), approved: true })
    expect(result.status).to.equal(PAYOUT_STATUS.READY_FOR_PAYMENT)
  })

  it('an Admin Manager of another store of the same company is refused', async () => {
    const { payout, actor } = setup({ actor: user('Admin Manager', { storeId: oid() }) })
    await expectRefused(
      approvePayout({ payoutId: String(payout._id), actorId: String(actor._id), approved: true }),
      403,
      /assigned stores/,
    )
  })
})

describe('Payout approval: reject', () => {
  afterEach(restoreAll)

  it('rejecting needs a remark', async () => {
    const { payout, actor, calls } = setup()
    await expectRefused(
      approvePayout({ payoutId: String(payout._id), actorId: String(actor._id), approved: false, remarks: '   ' }),
      400,
      /remark is required/,
    )
    expect(calls.decided).to.have.length(0)
  })

  it('rejecting with a remark: payout becomes Rejected and the sales person is told why', async () => {
    const { payout, actor, calls } = setup()
    const result = await approvePayout({
      payoutId: String(payout._id),
      actorId: String(actor._id),
      approved: false,
      remarks: '  IMEI mismatch  ',
    })
    expect(result.status).to.equal(PAYOUT_STATUS.REJECTED)
    expect(result.approval.status).to.equal('REJECTED')
    expect(result.approval.remarks).to.equal('IMEI mismatch')
    expect(calls.notifications[0].title).to.equal('Customer payout rejected')
    expect(calls.notifications[0].body).to.match(/IMEI mismatch/)
  })
})

describe('Payout approval: refused cases', () => {
  afterEach(restoreAll)

  it('before the customer enters details (Awaiting details) it cannot be approved yet', async () => {
    const { payout, actor, calls } = setup({ payout: pendingPayout({ status: PAYOUT_STATUS.AWAITING_VPA }) })
    await expectRefused(
      approvePayout({ payoutId: String(payout._id), actorId: String(actor._id), approved: true }),
      400,
      /not awaiting approval/,
    )
    expect(calls.decided).to.have.length(0)
  })

  for (const status of [PAYOUT_STATUS.READY_FOR_PAYMENT, PAYOUT_STATUS.SUCCESS, PAYOUT_STATUS.REJECTED]) {
    it(`a payout already ${status} cannot be approved again`, async () => {
      const { payout, actor } = setup({ payout: pendingPayout({ status }) })
      await expectRefused(
        approvePayout({ payoutId: String(payout._id), actorId: String(actor._id), approved: true }),
        400,
      )
    })
  }

  for (const role of ['Sale User', 'Accounts User', 'Technician', 'Store Admin']) {
    it(`${role} cannot approve`, async () => {
      const { payout, actor, calls } = setup({ actor: user(role, { storeId }) })
      await expectRefused(
        approvePayout({ payoutId: String(payout._id), actorId: String(actor._id), approved: true }),
        403,
        /approval permission/,
      )
      expect(calls.decided).to.have.length(0)
    })
  }

  it('a Manager of a different store cannot approve', async () => {
    const { payout, actor } = setup({ actor: user('Manager', { storeId: oid() }) })
    await expectRefused(
      approvePayout({ payoutId: String(payout._id), actorId: String(actor._id), approved: true }),
      403,
      /assigned stores/,
    )
  })

  it('an admin of another company cannot approve', async () => {
    const { payout, actor } = setup({ actor: user('Company Admin', { companyId: oid() }) })
    await expectRefused(
      approvePayout({ payoutId: String(payout._id), actorId: String(actor._id), approved: true }),
      403,
      /Access denied/,
    )
  })

  it('two approvers at once: the second gets "already decided"', async () => {
    const { payout, actor } = setup({ raceLost: true })
    await expectRefused(
      approvePayout({ payoutId: String(payout._id), actorId: String(actor._id), approved: true }),
      409,
      /already been decided/,
    )
  })

  it('Make Payment is blocked while the payout waits for approval', async () => {
    const payout = pendingPayout()
    const sales = user('Sale User', { _id: payout.initiatedBy })
    setup({ payout, actor: sales })
    await expectRefused(
      makePayout({ payoutId: String(payout._id), actorId: String(sales._id) }),
      409,
      /not ready for payment/,
    )
  })
})
