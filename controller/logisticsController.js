import Joi from 'joi'
import moment from 'moment'
import mongoose from 'mongoose'
import devicesLot from '../models/devicesLotModel.js'
import warehouseItemModel, { BOOKING_MODE, LOGISTICS_STATUS, PACKAGE_DEFAULTS } from '../models/warehouseItemModel.js'
import { decryptPII } from '../utils/kmsEncryption.js'
import { getShippingLabelSignedUrl } from '../utils/invoiceHelpers.js'
import {
  blueDartConfigurationStatus,
  cancelPickup,
  cancelWaybill,
  formatBlueDartDate,
} from '../services/blueDartService.js'
import {
  PAID_LOT_MATCH,
  MAX_AMOUNT,
  EDITABLE_STATUSES,
  BOOKABLE_STATUSES,
  CANCELLABLE_STATUSES,
  STATUS_ORDER,
  WarehouseError,
  validate,
  sendError,
  twoDecimals,
  lookupOne,
  loadActor,
  historyEntry,
  loadItem,
  leadFinalPrice,
  assertAwbUnused,
  itemResponse,
  bluedartServices,
  applyPackageChanges,
  INVALID_LEAD_ID,
  CONCURRENT_UPDATE_MESSAGE,
} from './logisticsHelpers.js'

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const idList = Joi.string()
  .trim()
  .pattern(/^[0-9a-fA-F]{24}(,[0-9a-fA-F]{24})*$/)
  .messages({ 'string.pattern.base': '{{#label}} must be comma-separated ids' })

const listSchema = Joi.object({
  page: Joi.number().integer().min(0).default(0),
  limit: Joi.number().integer().min(1).max(100).default(20),
  search: Joi.string().trim().max(100).allow(''),
  companyIds: idList.allow(''),
  storeIds: idList.allow(''),
  lotNo: Joi.string().trim().max(50).allow(''),
  status: Joi.string().valid(...Object.values(LOGISTICS_STATUS)).allow(''),
  fromDate: Joi.date(),
  toDate: Joi.date().min(Joi.ref('fromDate')),
})

const editSchema = Joi.object({
  amount: Joi.number()
    .greater(0)
    .max(MAX_AMOUNT)
    .custom(twoDecimals)
    .messages({ 'number.precision': 'Amount can have at most 2 decimals' }),
  quantity: Joi.number().integer().min(1).max(100),
  weight: Joi.number().greater(0).max(100).custom(twoDecimals)
    .messages({ 'number.precision': 'Weight can have at most 2 decimals' }),
  length: Joi.number().greater(0).max(300),
  width: Joi.number().greater(0).max(300),
  height: Joi.number().greater(0).max(300),
}).min(1)

// AWB format is still to be confirmed with the business; accept 6-30
// alphanumeric characters (Bluedart AWBs are 11 digits).
const manualBookingSchema = Joi.object({
  awbNo: Joi.string().trim().uppercase().pattern(/^[A-Z0-9]{6,30}$/).required().messages({
    'string.pattern.base': 'AWB No. must be 6-30 letters or digits',
  }),
  courierName: Joi.string().trim().min(2).max(60).required(),
  pickupDate: Joi.date().allow(null, ''),
})

const statusSchema = Joi.object({
  status: Joi.string()
    .valid(...STATUS_ORDER.slice(1))
    .required(),
  date: Joi.date().allow(null, ''),
})

const cancelSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(500).required(),
})

/* ------------------------------- LISTING -------------------------------- */

// Final price shown on the Pickup screen: base price plus bonus, negotiated
// amount and coupon discount.
const FINAL_PRICE = {
  $add: [
    { $ifNull: ['$lead.price', 0] },
    { $ifNull: ['$lead.bonusPrice', 0] },
    { $ifNull: ['$lead.negotiatedAmount', 0] },
    { $ifNull: ['$lead.couponDiscount', 0] },
  ],
}

// Plain localField/foreignField joins: MongoDB runs these on its fast join
// path. Only the lead join drops fields - leads carry the whole questionnaire,
// device report and history - which measured fastest in an interleaved A/B.

const LEAD_JOIN = [
  {
    $lookup: {
      from: 'leads',
      localField: 'deviceList',
      foreignField: '_id',
      pipeline: [{ $project: { QNA: 0, history: 0, deviceReport: 0 } }],
      as: 'lead',
    },
  },
  { $unwind: { path: '$lead', preserveNullAndEmptyArrays: true } },
]

const STORE_JOIN = [
  // The Pickup screen takes the store from the lot; many leads have none.
  { $addFields: { storeRef: { $ifNull: ['$storeId', '$lead.storeId'] } } },
  ...lookupOne('stores', 'storeRef', 'store'),
]

const COMPANY_JOIN = [
  // Older leads carry no companyId; fall back to the store's company.
  {
    $addFields: {
      companyRef: { $ifNull: ['$lead.companyId', '$store.companyId'] },
    },
  },
  ...lookupOne('companies', 'companyRef', 'company'),
]

const MODEL_JOIN = lookupOne('models', 'lead.modelId', 'model')
const WAREHOUSE_JOIN = lookupOne('warehouseitems', 'deviceList', 'wh', 'leadId')

const toObjectIds = (csv) =>
  csv ? csv.split(',').map((id) => new mongoose.Types.ObjectId(id)) : []

const buildLotMatch = (query) => {
  const lotMatch = { ...PAID_LOT_MATCH }
  if (query.fromDate && query.toDate) {
    lotMatch.updatedAt = {
      $gte: moment(query.fromDate).startOf('day').toDate(),
      $lte: moment(query.toDate).endOf('day').toDate(),
    }
  }
  if (query.lotNo) {
    lotMatch.uniqueCode = { $regex: escapeRegex(query.lotNo), $options: 'i' }
  }
  return lotMatch
}

// Each paid lot holds its lead ids in deviceList.
const DEVICE_LIST = '$deviceList'

/**
 * IMEIs are encrypted at rest, so a digit search is resolved by decrypting
 * the IMEIs of paid leads only and returning the matching lead ids.
 */
const findLeadIdsByImei = async (digits, lotMatch) => {
  // One round trip: paid lead ids with their (encrypted) IMEI.
  const rows = await devicesLot.aggregate([
    { $match: lotMatch },
    { $unwind: DEVICE_LIST },
    ...LEAD_JOIN,
    ...lookupOne('documents', 'lead.documentId', 'doc'),
    { $match: { 'doc.IMEI': { $nin: [null, ''] } } },
    { $project: { _id: 0, leadId: DEVICE_LIST, imei: '$doc.IMEI' } },
  ])

  const matches = []
  for (const row of rows) {
    let imei = row.imei
    try {
      imei = (await decryptPII(row.imei)) || row.imei
    } catch {
      // Older records may hold a plaintext IMEI; compare it as stored.
    }
    if (String(imei).includes(digits)) {
      matches.push(row.leadId)
    }
  }
  return matches
}

const statusExpr = { $ifNull: ['$wh.logisticsStatus', LOGISTICS_STATUS.NOT_BOOKED] }

// Text search over codes, AWB, model, store and company, plus IMEI matches.
const searchCondition = (search, imeiLeadIds) => {
  const pattern = { $regex: escapeRegex(search), $options: 'i' }
  const or = [
    { 'lead.uniqueCode': pattern },
    { uniqueCode: pattern },
    { 'wh.shipment.awbNo': pattern },
    { 'model.name': pattern },
    { 'store.storeName': pattern },
    { 'company.name': pattern },
  ]
  if (imeiLeadIds?.length) {
    or.push({ deviceList: { $in: imeiLeadIds } })
  }
  return { $or: or }
}

// Conditions for the active filters, applied after the filter joins.
const filterConditions = (query, companyIds, storeIds, imeiLeadIds) => {
  const and = []
  if (query.search) {
    and.push(searchCondition(query.search, imeiLeadIds))
  }
  if (companyIds.length) {
    and.push({ companyRef: { $in: companyIds } })
  }
  if (storeIds.length) {
    and.push({ storeRef: { $in: storeIds } })
  }
  if (query.status) {
    and.push({ $expr: { $eq: [statusExpr, query.status] } })
  }
  return and
}

/**
 * One aggregation: filter paid lots, split them into leads, join only what the
 * filters need for every row, then sort and paginate. Display-only joins run
 * for the rows on the requested page.
 */
const buildListPipeline = (query, lotMatch, imeiLeadIds) => {
  const companyIds = toObjectIds(query.companyIds)
  const storeIds = toObjectIds(query.storeIds)

  // Join for every row only what the active filters read; the rest is joined
  // for the rows on the requested page.
  const search = Boolean(query.search)
  const needs = {
    store: search || companyIds.length > 0 || storeIds.length > 0,
    company: search || companyIds.length > 0,
    model: search,
    warehouse: search || Boolean(query.status),
  }

  const pipeline = [
    { $match: lotMatch },
    { $unwind: DEVICE_LIST },
    ...LEAD_JOIN,
    // Some lots still reference deleted leads; drop them so totals stay exact.
    { $match: { lead: { $ne: null } } },
  ]

  const filterJoins = []
  const pageJoins = []
  ;(needs.store ? filterJoins : pageJoins).push(...STORE_JOIN)
  ;(needs.company ? filterJoins : pageJoins).push(...COMPANY_JOIN)
  ;(needs.model ? filterJoins : pageJoins).push(...MODEL_JOIN)
  ;(needs.warehouse ? filterJoins : pageJoins).push(...WAREHOUSE_JOIN)

  if (filterJoins.length || query.status) {
    pipeline.push(...filterJoins, {
      $match: { $and: filterConditions(query, companyIds, storeIds, imeiLeadIds) },
    })
  }

  pipeline.push(
    { $sort: { updatedAt: -1, 'lead.createdAt': -1 } },
    {
      $facet: {
        total: [{ $count: 'count' }],
        items: [
          { $skip: query.page * query.limit },
          { $limit: query.limit },
          ...pageJoins,
          ...lookupOne('documents', 'lead.documentId', 'doc'),
          ...lookupOne('users', 'lead.userId', 'salesUser'),
          ...lookupOne('condtioncodes', 'lead.gradeId', 'grade'),
          { $project: LIST_PROJECTION },
        ],
      },
    },
  )
  return pipeline
}

const LIST_PROJECTION = {
  _id: '$lead._id',
  leadCode: '$lead.uniqueCode',
  uniqueCode: '$lead.uniqueCode',
  lotId: '$_id',
  lotCode: '$uniqueCode',
  lotStatus: '$status',
  lotUpdatedAt: '$updatedAt',
  paymentReceipt: { $ifNull: ['$paymentReceipt', ''] },
  paymentRemarks: { $ifNull: ['$remarks', ''] },
  deviceName: { $ifNull: ['$model.name', ''] },
  ram: { $ifNull: ['$lead.ram', ''] },
  storage: { $ifNull: ['$lead.storage', ''] },
  grade: { $ifNull: ['$grade.grade', ''] },
  price: FINAL_PRICE,
  finalPrice: FINAL_PRICE,
  basePrice: { $ifNull: ['$lead.price', 0] },
  bonusPrice: { $ifNull: ['$lead.bonusPrice', 0] },
  // Declared value: the warehouse's edited amount, else the final price.
  amount: { $ifNull: ['$wh.amount', FINAL_PRICE] },
  amountEdited: { $ne: [{ $ifNull: ['$wh.amount', null] }, null] },
  quantity: { $ifNull: ['$wh.quantity', PACKAGE_DEFAULTS.quantity] },
  weight: { $ifNull: ['$wh.weight', PACKAGE_DEFAULTS.weight] },
  dimensions: {
    length: { $ifNull: ['$wh.dimensions.length', PACKAGE_DEFAULTS.length] },
    width: { $ifNull: ['$wh.dimensions.width', PACKAGE_DEFAULTS.width] },
    height: { $ifNull: ['$wh.dimensions.height', PACKAGE_DEFAULTS.height] },
  },
  logisticsStatus: statusExpr,
  reTransitCount: { $ifNull: ['$wh.reTransitCount', 0] },
  bookingMode: { $ifNull: ['$wh.shipment.bookingMode', ''] },
  awbNo: { $ifNull: ['$wh.shipment.awbNo', ''] },
  courierName: { $ifNull: ['$wh.shipment.courierName', ''] },
  serviceType: { $ifNull: ['$wh.shipment.serviceType', ''] },
  labelUrl: { $ifNull: ['$wh.shipment.labelUrl', ''] },
  pickupDate: { $ifNull: ['$wh.shipment.pickupDate', null] },
  edd: { $ifNull: ['$wh.shipment.edd', null] },
  deliveryDate: { $ifNull: ['$wh.shipment.deliveryDate', null] },
  trackingStatus: { $ifNull: ['$wh.shipment.trackingStatus', ''] },
  trackingStatusAt: { $ifNull: ['$wh.shipment.trackingStatusAt', ''] },
  trackingError: { $ifNull: ['$wh.shipment.trackingError', ''] },
  trackedAt: { $ifNull: ['$wh.shipment.trackedAt', null] },
  companyId: { $ifNull: ['$company._id', null] },
  companyName: { $ifNull: ['$company.name', ''] },
  companyCode: { $ifNull: ['$company.companyCode', ''] },
  // Encrypted at rest; decryptResponsePII decrypts these keys.
  imei: { $ifNull: ['$doc.IMEI', ''] },
  storeId: { $ifNull: ['$store._id', null] },
  storeName: { $ifNull: ['$store.storeName', ''] },
  storeCode: { $ifNull: ['$store.storeId', ''] },
  storeRegion: { $ifNull: ['$store.region', ''] },
  storeAddress: { $ifNull: ['$store.address', ''] },
  storeContact: { $ifNull: ['$store.contactNumber', ''] },
  customerName: { $ifNull: ['$lead.name', ''] },
  aadharNumber: { $ifNull: ['$lead.aadharNumber', ''] },
  phoneNumber: { $ifNull: ['$lead.phoneNumber', ''] },
  emailId: { $ifNull: ['$lead.emailId', ''] },
  salesUserName: { $ifNull: ['$salesUser.name', ''] },
  leadCreatedAt: '$lead.createdAt',
}

/**
 * List every lead inside a payment-confirmed lot with its warehouse details,
 * newest lot first.
 */
const paidLeads = async (req, res) => {
  try {
    const query = validate(listSchema, req.query)
    const lotMatch = buildLotMatch(query)
    const digits = query.search?.replace(/\s/g, '')
    const imeiLeadIds =
      digits && /^\d{4,}$/.test(digits)
        ? await findLeadIdsByImei(digits, lotMatch)
        : null

    const [result] = await devicesLot
      .aggregate(buildListPipeline(query, lotMatch, imeiLeadIds))
      .allowDiskUse(true)
    const total = result?.total?.[0]?.count || 0
    return res.status(200).json({
      success: true,
      data: result?.items || [],
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    })
  } catch (error) {
    return sendError(res, error, 'Unable to fetch paid leads')
  }
}

/**
 * Companies and stores that have paid lots, for the filter dropdowns. Each
 * store carries its companyId so the store list can narrow by company.
 */
// Store / company lists change rarely; serve them from memory for a minute.
const FILTER_CACHE_MS = 60 * 1000
let filterCache = { value: null, expires: 0 }

const loadFilterLists = async () => {
  if (filterCache.value && filterCache.expires > Date.now()) {
    return filterCache.value
  }
  // Stores of paid lots, and every company (the Company filter lists all of
  // them, active and inactive). Both queries run in parallel.
  const [stores, companies] = await Promise.all([
    devicesLot.aggregate([
      { $match: PAID_LOT_MATCH },
      { $group: { _id: '$storeId' } },
      ...lookupOne('stores', '_id', 'store'),
      { $match: { store: { $ne: null } } },
      {
        $project: {
          _id: '$store._id',
          storeName: '$store.storeName',
          region: '$store.region',
          companyId: '$store.companyId',
        },
      },
      { $sort: { storeName: 1 } },
    ]),
    // Only what the dropdown needs; company documents also hold price sheets
    // and settings that must not reach the browser.
    mongoose.connection
      .collection('companies')
      // Case-insensitive A-Z, as a user would expect.
      .find({}, { projection: { name: 1, companyCode: 1, status: 1 }, collation: { locale: 'en', strength: 2 } })
      .sort({ name: 1 })
      .toArray(),
  ])
  const value = { stores, companies }
  filterCache = { value, expires: Date.now() + FILTER_CACHE_MS }
  return value
}

const filterOptions = async (req, res) => {
  try {
    const { companies, stores } = await loadFilterLists()
    return res.status(200).json({
      success: true,
      data: {
        companies,
        stores,
        statuses: Object.values(LOGISTICS_STATUS),
        services: bluedartServices(),
        bluedartConfigured: blueDartConfigurationStatus().configured,
      },
    })
  } catch (error) {
    return sendError(res, error, 'Unable to fetch filter options')
  }
}

/**
 * Edit declared amount, quantity, weight or dimensions before booking. Each
 * changed value is logged with old value, new value, user and time.
 */
const updateItem = async (req, res) => {
  try {
    const body = validate(editSchema, req.body)
    // The lead's price is only needed for an amount edit; fetch it alongside.
    const [item, actor, finalPrice] = await Promise.all([
      loadItem(req.params.leadId),
      loadActor(req.userId),
      body.amount === undefined ? null : leadFinalPrice(req.params.leadId),
    ])
    if (!EDITABLE_STATUSES.includes(item.logisticsStatus)) {
      throw new WarehouseError(
        `Details cannot be edited while the shipment is ${item.logisticsStatus}`,
        409,
      )
    }

    const changed = applyPackageChanges(item, body, finalPrice, actor)
    if (changed) {
      await item.save()
    }
    return res.status(200).json({
      success: true,
      message: changed ? 'Details updated' : 'No changes',
      data: itemResponse(item),
    })
  } catch (error) {
    return sendError(res, error, 'Unable to update item')
  }
}

/**
 * Save a manually arranged shipment. On a cancelled item this is a re-transit:
 * the old AWB stays in pastShipments and history.
 */
const manualBooking = async (req, res) => {
  try {
    const body = validate(manualBookingSchema, req.body)
    // The AWB check does not depend on the item, so all three run together.
    const [item, actor] = await Promise.all([
      loadItem(req.params.leadId),
      loadActor(req.userId),
      assertAwbUnused(body.awbNo),
    ])
    if (!BOOKABLE_STATUSES.includes(item.logisticsStatus)) {
      throw new WarehouseError(`Item is already ${item.logisticsStatus}`, 409)
    }

    const isReTransit = item.logisticsStatus === LOGISTICS_STATUS.CANCELLED
    const shipment = {
      awbNo: body.awbNo,
      courierName: body.courierName,
      bookingMode: BOOKING_MODE.MANUAL,
      pickupDate: body.pickupDate || null,
      bookedBy: actor.id,
      bookedAt: new Date(),
    }
    const entry = historyEntry(actor, isReTransit ? 'RE_TRANSIT' : 'BOOKED', {
      field: 'awbNo',
      newValue: body.awbNo,
      note: `Manual booking with ${body.courierName}`,
    })

    // Conditional update so a double click cannot book twice.
    const updated = await warehouseItemModel.findOneAndUpdate(
      { _id: item._id, logisticsStatus: item.logisticsStatus },
      {
        $set: { shipment, logisticsStatus: LOGISTICS_STATUS.BOOKED },
        $inc: { reTransitCount: isReTransit ? 1 : 0 },
        $push: { history: entry },
      },
      { new: true },
    )
    if (!updated) {
      throw new WarehouseError(CONCURRENT_UPDATE_MESSAGE, 409)
    }
    return res.status(200).json({
      success: true,
      message: isReTransit ? 'Re-transit booked' : 'Manual booking saved',
      data: itemResponse(updated),
    })
  } catch (error) {
    return sendError(res, error, 'Unable to save booking')
  }
}

/**
 * Move a manual shipment forward (Out For Pickup → … → Delivered).
 */
const updateStatus = async (req, res) => {
  try {
    const body = validate(statusSchema, req.body)
    const [item, actor] = await Promise.all([
      loadItem(req.params.leadId),
      loadActor(req.userId),
    ])
    // Bluedart shipments move only from Bluedart tracking, never by hand.
    if (item.shipment?.bookingMode === BOOKING_MODE.BLUEDART) {
      throw new WarehouseError(
        'Status of a Bluedart shipment is updated from Bluedart tracking. Use Track.',
        409,
      )
    }
    const from = STATUS_ORDER.indexOf(item.logisticsStatus)
    const to = STATUS_ORDER.indexOf(body.status)
    if (from === -1 || to <= from) {
      throw new WarehouseError(
        `Cannot move from ${item.logisticsStatus} to ${body.status}`,
        409,
      )
    }

    const set = { logisticsStatus: body.status }
    if (body.status === LOGISTICS_STATUS.DELIVERED) {
      set['shipment.deliveryDate'] = body.date || new Date()
    }
    if (body.status === LOGISTICS_STATUS.PICKUP_COMPLETE && body.date) {
      set['shipment.pickupDate'] = body.date
    }
    const updated = await warehouseItemModel.findOneAndUpdate(
      { _id: item._id, logisticsStatus: item.logisticsStatus },
      {
        $set: set,
        $push: {
          history: historyEntry(actor, 'STATUS_CHANGE', {
            field: 'logisticsStatus',
            oldValue: item.logisticsStatus,
            newValue: body.status,
          }),
        },
      },
      { new: true },
    )
    if (!updated) {
      throw new WarehouseError(CONCURRENT_UPDATE_MESSAGE, 409)
    }
    return res.status(200).json({
      success: true,
      message: `Status updated to ${body.status}`,
      data: itemResponse(updated),
    })
  } catch (error) {
    return sendError(res, error, 'Unable to update status')
  }
}

/**
 * Cancel a booked shipment. The AWB moves to pastShipments (label disabled)
 * and the item can be re-transited.
 */
const cancelShipment = async (req, res) => {
  try {
    const body = validate(cancelSchema, req.body)
    const [item, actor] = await Promise.all([
      loadItem(req.params.leadId),
      loadActor(req.userId),
    ])
    if (!CANCELLABLE_STATUSES.includes(item.logisticsStatus) || !item.shipment) {
      throw new WarehouseError(
        `Only a ${CANCELLABLE_STATUSES.join(' or ')} shipment can be cancelled (now ${item.logisticsStatus})`,
        409,
      )
    }
    // Cancellation window from booking (open question 1 in the requirements;
    // 2 days unless configured otherwise).
    const windowDays = Number(process.env.WAREHOUSE_CANCEL_WINDOW_DAYS || 2)
    if (moment().diff(moment(item.shipment.bookedAt), 'days', true) > windowDays) {
      throw new WarehouseError(
        `Shipments can be cancelled only within ${windowDays} days of booking`,
        409,
      )
    }

    const notes = [body.reason]
    if (item.shipment.bookingMode === BOOKING_MODE.BLUEDART) {
      try {
        await cancelWaybill({ AWBNo: item.shipment.awbNo })
      } catch (error) {
        throw new WarehouseError(
          `Bluedart could not cancel AWB ${item.shipment.awbNo}: ${error.message}`,
          422,
        )
      }
      // Stop the pickup as well; not every account has this API enabled, so a
      // failure is recorded rather than blocking the cancellation.
      if (item.shipment.pickupTokenNumber) {
        try {
          await cancelPickup({
            TokenNumber: item.shipment.pickupTokenNumber,
            PickupRegistrationDate: formatBlueDartDate(item.shipment.bookedAt),
            Remarks: body.reason.slice(0, 60),
          })
          notes.push('Bluedart pickup cancelled')
        } catch (error) {
          notes.push(`Bluedart pickup not cancelled: ${error.message}`)
        }
      }
    }

    const cancelled = {
      ...item.shipment.toObject(),
      cancelledBy: actor.id,
      cancelledAt: new Date(),
      cancelReason: body.reason,
    }
    const updated = await warehouseItemModel.findOneAndUpdate(
      { _id: item._id, logisticsStatus: item.logisticsStatus },
      {
        $set: { shipment: null, logisticsStatus: LOGISTICS_STATUS.CANCELLED },
        $push: {
          pastShipments: cancelled,
          history: historyEntry(actor, 'CANCELLED', {
            field: 'awbNo',
            oldValue: item.shipment.awbNo,
            note: notes.join('; '),
          }),
        },
      },
      { new: true },
    )
    if (!updated) {
      throw new WarehouseError(CONCURRENT_UPDATE_MESSAGE, 409)
    }
    return res.status(200).json({
      success: true,
      message: 'Shipment cancelled',
      data: itemResponse(updated),
    })
  } catch (error) {
    return sendError(res, error, 'Unable to cancel shipment')
  }
}

/**
 * Fresh link to view or print the active shipment's label. Cancelled
 * shipments' labels are not served.
 */
const shipmentLabel = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.leadId)) {
      throw new WarehouseError(INVALID_LEAD_ID)
    }
    const item = await warehouseItemModel
      .findOne({ leadId: req.params.leadId })
      .select('shipment')
      .lean()
    if (!item?.shipment?.labelKey) {
      throw new WarehouseError('No label is available for this shipment', 404)
    }
    return res.status(200).json({
      success: true,
      data: { url: getShippingLabelSignedUrl(item.shipment.labelKey), expiresInSeconds: 300 },
    })
  } catch (error) {
    return sendError(res, error, 'Unable to fetch label')
  }
}

/**
 * Full warehouse record for the View screen: shipment, past shipments and the
 * audit history (newest first).
 */
const getItem = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.leadId)) {
      throw new WarehouseError(INVALID_LEAD_ID)
    }
    const item = await warehouseItemModel.findOne({ leadId: req.params.leadId }).lean()
    return res.status(200).json({
      success: true,
      data: item
        ? itemResponse(item)
        : {
            leadId: req.params.leadId,
            logisticsStatus: LOGISTICS_STATUS.NOT_BOOKED,
            shipment: null,
            pastShipments: [],
            history: [],
          },
    })
  } catch (error) {
    return sendError(res, error, 'Unable to fetch item')
  }
}

export default {
  paidLeads,
  filterOptions,
  getItem,
  updateItem,
  manualBooking,
  updateStatus,
  cancelShipment,
  shipmentLabel,
}
