import mongoose from 'mongoose'
import BuybackPayout, { PAYOUT_STATUS } from '../../models/buybackPayoutModel.js'
import devicesLot from '../../models/devicesLotModel.js'
import leads from '../../models/leadsModel.js'
import { safeLog } from '../../utils/piiMasking.js'
import {
  PayoutBusinessError,
  ADMIN_ROLES,
  ROLE_MANAGER,
} from './validation.js'
import { assertPayoutAccess } from './access.js'

// Lot status the logistics screen treats as "paid, ready to dispatch". It is
// the same status the manual Pickup & Cancel flow sets on Confirm Payment.
export const PAYOUT_LOT_STATUS = 'Out For Pickup'
export const LOT_SOURCE = Object.freeze({ MANUAL: 'MANUAL', PAYOUT: 'PAYOUT' })

const PROVIDER_LABELS = {
  HSBC_UPI: 'HSBC UPI',
  HSBC_IMPS: 'HSBC IMPS',
  HSBC_NEFT: 'HSBC NEFT',
}

const REMARKS_MAX_LENGTH = 250

const payoutLotCode = () => `LOT-PO-${Date.now()}`

const actorStoreIds = (actor) =>
  [actor.storeId, ...(actor.assignedStores || [])].filter(Boolean).map(String)

// Admins for the company, Managers for their stores, and the sales person who
// raised the payout may hand the device to logistics.
const assertCanAssign = (actor, payout) => {
  if (ADMIN_ROLES.has(actor.role)) {
    return
  }
  if (actor.role === ROLE_MANAGER) {
    if (actorStoreIds(actor).includes(String(payout.storeId))) {
      return
    }
    throw new PayoutBusinessError(
      'Managers can send to logistics only for their assigned stores',
      403,
    )
  }
  if (String(payout.initiatedBy) === String(actor._id)) {
    return
  }
  throw new PayoutBusinessError(
    'Only the sales person or an administrator can send this device to logistics',
    403,
  )
}

const paymentReference = (payout) =>
  [
    PROVIDER_LABELS[payout.provider] || payout.provider,
    payout.providerTransactionRrn
      ? `RRN ${payout.providerTransactionRrn}`
      : `Order ${payout.merchantOrderNo}`,
  ]
    .filter(Boolean)
    .join(' · ')

const assertNotAlreadyInLot = async (payout) => {
  if (payout.logistics?.lotId) {
    throw new PayoutBusinessError(
      `Already sent to logistics in ${payout.logistics.lotCode || 'a lot'}`,
      409,
    )
  }
  const existing = await devicesLot
    .findOne({ deviceList: payout.leadId })
    .select('uniqueCode status')
    .lean()
  if (existing) {
    throw new PayoutBusinessError(
      `This device is already in lot ${existing.uniqueCode} (${existing.status})`,
      409,
    )
  }
}

/**
 * Hand a paid customer payout's device to the logistics team. Creates a
 * single-device lot marked as coming from Customer Payouts, so it appears on
 * the Logistics screen next to the manually raised lots. Idempotent: a payout
 * can be sent once; the database enforces one lot per payout.
 */
export const assignPayoutToLogistics = async ({ payoutId, actorId, remarks }) => {
  if (!mongoose.isValidObjectId(payoutId)) {
    throw new PayoutBusinessError('Invalid payout ID')
  }
  const payout = await BuybackPayout.findById(payoutId)
  if (!payout) {
    throw new PayoutBusinessError('Payout not found', 404)
  }
  const actor = await assertPayoutAccess(payout, actorId)
  assertCanAssign(actor, payout)
  if (payout.status !== PAYOUT_STATUS.SUCCESS) {
    throw new PayoutBusinessError(
      'Only a successful payout can be sent to logistics',
      409,
    )
  }
  await assertNotAlreadyInLot(payout)

  const note = String(remarks || '').trim().slice(0, REMARKS_MAX_LENGTH)
  const now = new Date()
  const reference = paymentReference(payout)
  let lot
  try {
    lot = await devicesLot.create({
      source: LOT_SOURCE.PAYOUT,
      buybackPayoutId: payout._id,
      status: PAYOUT_LOT_STATUS,
      totalDevice: 1,
      totalAmount: payout.amount,
      deviceList: [payout.leadId],
      userId: actor._id,
      storeId: payout.storeId,
      companyId: payout.companyId,
      uniqueCode: payoutLotCode(),
      paidAt: payout.paidAt,
      paymentReference: reference,
      remarks: note || `Customer paid via ${reference}`,
      history: [
        {
          action: 'SENT_FROM_CUSTOMER_PAYOUT',
          fromStatus: '',
          toStatus: PAYOUT_LOT_STATUS,
          performedBy: actor._id,
          remarks: note,
          timestamp: now,
        },
      ],
    })
  } catch (error) {
    if (error.code === 11000) {
      throw new PayoutBusinessError('This payout was already sent to logistics', 409)
    }
    throw error
  }

  const claimed = await BuybackPayout.findOneAndUpdate(
    { _id: payout._id, 'logistics.lotId': { $exists: false } },
    {
      $set: {
        logistics: {
          lotId: lot._id,
          lotCode: lot.uniqueCode,
          assignedAt: now,
          assignedBy: actor._id,
          remarks: note,
        },
      },
    },
    { new: true },
  )
  if (!claimed) {
    // Another request won the race; drop the duplicate lot.
    await devicesLot.deleteOne({ _id: lot._id })
    throw new PayoutBusinessError('This payout was already sent to logistics', 409)
  }

  try {
    await leads.updateOne(
      { _id: payout.leadId },
      {
        $push: {
          history: {
            action: 'SENT_TO_LOGISTICS',
            performedBy: actor._id,
            timestamp: now,
            changes: {
              source: LOT_SOURCE.PAYOUT,
              lotId: lot._id,
              lotCode: lot.uniqueCode,
              payoutId: payout._id,
            },
          },
        },
      },
    )
  } catch (error) {
    // History is informational; the hand-off itself already succeeded.
    safeLog.error('Unable to record logistics hand-off on lead', error)
  }

  return BuybackPayout.findById(payout._id)
    .populate('logistics.assignedBy', 'name email')
    .lean()
}
