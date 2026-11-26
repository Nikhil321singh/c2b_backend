import mongoose from 'mongoose'
import devicesLot from '../models/devicesLotModel.js'
import leads from '../models/leadsModel.js'
import usersModel from '../models/UsersModel.js'
import logisticModel from '../models/logisticModel.js'
import warehouseItemModel, { LOGISTICS_STATUS } from '../models/warehouseItemModel.js'
import { safeLog } from '../utils/piiMasking.js'

// A lot is "paid" once its payment is confirmed on the Pickup & Cancel screen:
// Confirm Payment stores the receipt on the lot and then moves it from
// "Pending Payment Confirmation" to "Out For Pickup". Every status after that
// point counts as paid, and so does a pending lot that already has a receipt
// (receipt saved but the status update failed). Statuses from other flows
// (e.g. "Payment Requested") are deliberately not listed.
export const PENDING_PAYMENT = 'Pending Payment Confirmation'
export const PAID_STATUSES = [
  'Out For Pickup',
  'Pending Pickup Confirmation',
  'Pickup Complete',
  'Pickup Cancelled',
  'Pending Delivery At Warehouse',
  'Pickup Delivered At Warehouse',
  'Delivered At Warehouse',
  'Approved Delivery At Warehouse',
  'Payment Confirmed',
]
export const PAID_LOT_MATCH = {
  $or: [
    { status: { $in: PAID_STATUSES } },
    {
      status: PENDING_PAYMENT,
      paymentReceipt: { $exists: true, $nin: [null, ''] },
    },
    // Store payment requests go to logistics once the store is paid (Mark
    // Paid), or straight away under the pre-paid / deferred mode.
    { paymentStatus: 'PAYMENT_DONE' },
  ],
}

// Upper limit for an edited declared value until the business defines one.
export const MAX_AMOUNT = Number(process.env.WAREHOUSE_MAX_AMOUNT || 1000000)

// Item details (amount, package) may change only while nothing is booked.
export const EDITABLE_STATUSES = [LOGISTICS_STATUS.NOT_BOOKED, LOGISTICS_STATUS.CANCELLED]
export const BOOKABLE_STATUSES = EDITABLE_STATUSES
export const CANCELLABLE_STATUSES = [
  LOGISTICS_STATUS.BOOKED,
  LOGISTICS_STATUS.PICKUP_REGISTERED,
  LOGISTICS_STATUS.OUT_FOR_PICKUP,
]
// Forward-only progress for manual shipments; tracking will drive Bluedart ones.
export const STATUS_ORDER = [
  LOGISTICS_STATUS.BOOKED,
  LOGISTICS_STATUS.PICKUP_REGISTERED,
  LOGISTICS_STATUS.OUT_FOR_PICKUP,
  LOGISTICS_STATUS.PICKUP_COMPLETE,
  LOGISTICS_STATUS.IN_TRANSIT,
  LOGISTICS_STATUS.DELIVERED,
]

export const INVALID_LEAD_ID = 'Invalid lead id'
export const CONCURRENT_UPDATE_MESSAGE = 'Item was updated by someone else. Please refresh.'

export class WarehouseError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

export const validate = (schema, body) => {
  const { error, value } = schema.validate(body || {}, { abortEarly: false })
  if (error) {
    throw new WarehouseError(error.details.map((d) => d.message).join(', '))
  }
  return value
}

export const sendError = (res, error, fallback) => {
  if (error instanceof WarehouseError) {
    return res.status(error.statusCode).json({ success: false, message: error.message })
  }
  safeLog.error(`${fallback}:`, error)
  return res.status(500).json({ success: false, message: fallback })
}

export const twoDecimals = (value, helpers) =>
  Math.round(value * 100) === value * 100 ? value : helpers.error('number.precision')

// Plain localField/foreignField join with an optional single result.
export const lookupOne = (from, localField, as, foreignField = '_id') => [
  { $lookup: { from, localField, foreignField, as } },
  { $unwind: { path: `$${as}`, preserveNullAndEmptyArrays: true } },
]

/* ----------------------------- ITEM ACTIONS ------------------------------ */

export const loadActor = async (userId) => {
  const user = await usersModel.findById(userId).select('name firstName lastName').lean()
  const name =
    user?.name || [user?.firstName, user?.lastName].filter(Boolean).join(' ')
  return { id: user?._id || null, name: name || '' }
}

export const historyEntry = (actor, action, extra = {}) => ({
  action,
  by: actor.id,
  byName: actor.name,
  at: new Date(),
  ...extra,
})

/**
 * Return the warehouse record for a paid lead, creating it with defaults on
 * the first action. Leads outside a paid lot are rejected.
 */
export const loadItem = async (leadId) => {
  if (!mongoose.Types.ObjectId.isValid(leadId)) {
    throw new WarehouseError(INVALID_LEAD_ID)
  }
  const existing = await warehouseItemModel.findOne({ leadId })
  if (existing) {
    return existing
  }
  const lot = await devicesLot
    .findOne({ deviceList: leadId, ...PAID_LOT_MATCH })
    .select('_id')
    .lean()
  if (!lot) {
    throw new WarehouseError('Lead is not in a payment-confirmed lot', 404)
  }
  try {
    return await warehouseItemModel.create({ leadId, lotId: lot._id })
  } catch (error) {
    // Another request created it first.
    if (error.code === 11000) {
      return warehouseItemModel.findOne({ leadId })
    }
    throw error
  }
}

/**
 * Apply edited amount/package values to the item, logging each real change
 * (old value, new value, user, time). Returns the number of changes.
 */
export const applyPackageChanges = (item, values, finalPrice, actor) => {
  const changes = []
  if (values.amount !== undefined) {
    const oldAmount = item.amount ?? finalPrice
    if (oldAmount !== values.amount) {
      changes.push(['amount', 'AMOUNT_EDIT', oldAmount, values.amount])
      item.amount = values.amount
    }
  }
  for (const field of ['quantity', 'weight']) {
    if (values[field] !== undefined && item[field] !== values[field]) {
      changes.push([field, 'PACKAGE_EDIT', item[field], values[field]])
      item[field] = values[field]
    }
  }
  for (const field of ['length', 'width', 'height']) {
    if (values[field] !== undefined && item.dimensions[field] !== values[field]) {
      changes.push([field, 'PACKAGE_EDIT', item.dimensions[field], values[field]])
      item.dimensions[field] = values[field]
    }
  }
  for (const [field, action, oldValue, newValue] of changes) {
    item.history.push(historyEntry(actor, action, { field, oldValue, newValue }))
  }
  return changes.length
}

export const leadFinalPrice = async (leadId) => {
  const lead = await leads
    .findById(leadId)
    .select('price bonusPrice negotiatedAmount couponDiscount')
    .lean()
  return (
    (lead?.price || 0) +
    (lead?.bonusPrice || 0) +
    (lead?.negotiatedAmount || 0) +
    (lead?.couponDiscount || 0)
  )
}

// AWBs are stored upper-case, so this is an exact, index-backed match.
export const assertAwbUnused = async (awbNo) => {
  const [inWarehouse, inBluedart] = await Promise.all([
    warehouseItemModel.exists({
      $or: [{ 'shipment.awbNo': awbNo }, { 'pastShipments.awbNo': awbNo }],
    }),
    logisticModel.exists({ awbNo }),
  ])
  if (inWarehouse || inBluedart) {
    throw new WarehouseError('This AWB No. is already used in the system', 409)
  }
}

export const itemResponse = (item) => ({
  leadId: item.leadId,
  logisticsStatus: item.logisticsStatus,
  amount: item.amount,
  quantity: item.quantity,
  weight: item.weight,
  dimensions: item.dimensions,
  reTransitCount: item.reTransitCount,
  shipment: item.shipment,
  pastShipments: item.pastShipments,
  history: [...(item.history || [])].reverse(),
})

// Services enabled on the Bluedart account, as "Label:ProductCode" pairs.
// Verified on the sandbox: A (Apex/air), D (Domestic Priority), E (Surface).
export const bluedartServices = () =>
  (process.env.BLUEDART_SERVICES || 'Domestic Priority:D,Apex (Air):A,Surface:E')
    .split(',')
    .map((pair) => {
      const [label, code] = pair.split(':').map((s) => s.trim())
      return { label, code }
    })
