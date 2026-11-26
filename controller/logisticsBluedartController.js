import Joi from 'joi'
import moment from 'moment'
import mongoose from 'mongoose'
import leads from '../models/leadsModel.js'
import warehouseItemModel, { BOOKING_MODE, LOGISTICS_STATUS } from '../models/warehouseItemModel.js'
import { safeLog } from '../utils/piiMasking.js'
import { uploadShippingLabelToS3 } from '../utils/invoiceHelpers.js'
import {
  BlueDartError,
  blueDartConfigurationStatus,
  buildWaybillRequest,
  generateWaybill,
  getServicesForPincode,
  parseTrackingResponse,
  toCreditReference,
  trackShipment,
} from '../services/blueDartService.js'
import {
  PAID_LOT_MATCH,
  MAX_AMOUNT,
  BOOKABLE_STATUSES,
  STATUS_ORDER,
  WarehouseError,
  validate,
  sendError,
  twoDecimals,
  lookupOne,
  loadActor,
  historyEntry,
  loadItem,
  itemResponse,
  bluedartServices,
  applyPackageChanges,
  INVALID_LEAD_ID,
} from './logisticsHelpers.js'

/* ---------------------------- BLUEDART BOOKING ---------------------------- */

const envValue = (key, fallback = '') => (process.env[key] || fallback).trim()

// Blue Dart only authorizes bookings from the contract area. ToPay shipments
// use BLUEDART_ORIGIN_AREA / BLUEDART_CUSTOMER_CODE and send the real pickup
// pincode separately.

const warehouseAddress = () => ({
  name: envValue('BLUEDART_WAREHOUSE_NAME', 'GREST Warehouse'),
  address1: envValue('BLUEDART_WAREHOUSE_ADDR1'),
  address2: envValue('BLUEDART_WAREHOUSE_ADDR2'),
  address3: envValue('BLUEDART_WAREHOUSE_ADDR3'),
  pincode: envValue('BLUEDART_WAREHOUSE_PIN'),
  mobile: envValue('BLUEDART_WAREHOUSE_MOBILE'),
  email: envValue('BLUEDART_WAREHOUSE_EMAIL'),
  gstNumber: envValue('BLUEDART_WAREHOUSE_GST'),
  addressType: envValue('BLUEDART_WAREHOUSE_ADDRESS_TYPE', 'C'),
})

// Stores keep the pincode inside the free-text address; take the last 6-digit
// number in it. The booking form lets the user fill it in when missing.
const pincodeFromAddress = (address) => {
  const matches = String(address || '').match(/\b[1-9]\d{5}\b/g)
  return matches ? matches[matches.length - 1] : ''
}

// Bluedart address lines are short; split a long address over three lines at
// word boundaries.
const splitAddress = (address, size = 30) => {
  const lines = ['', '', '']
  let index = 0
  for (const word of String(address || '').replace(/\s+/g, ' ').trim().split(' ')) {
    const candidate = lines[index] ? `${lines[index]} ${word}` : word
    if (candidate.length > size && lines[index] && index < 2) {
      index += 1
      lines[index] = word
    } else {
      lines[index] = candidate
    }
  }
  return lines
}

// Next working day (Monday-Saturday) as the default pickup date.
const nextWorkingDay = () => {
  const date = moment().add(1, 'day').startOf('day')
  if (date.day() === 0) {
    date.add(1, 'day')
  }
  return date.format(DATE_FORMAT)
}

const DATE_FORMAT = 'YYYY-MM-DD'
const MAX_PICKUP_DAYS_AHEAD = 7
const BOOKING_LOCK_MS = 2 * 60 * 1000

// Bluedart answers in codes; show the warehouse something it can act on.
const plainBluedartError = (message) => {
  const text = String(message || '')
  // Blue Dart reports a bad LoginID / LicenceKey or an API the account is not
  // subscribed to as "UserDoesNotExists" / "Access to the method is not
  // allowed". Check this before the pincode branch: our own error prefix
  // ("Blue Dart pincode check rejected") otherwise makes it look like a
  // serviceability problem.
  if (/UserDoesNotExists|Access to the method is not allowed|Unauthorized|License Mismatch|Invalid Client/i.test(text)) {
    return `Bluedart rejected our account credentials or API access. Check BLUEDART_LOGIN_ID, BLUEDART_LICENSE_KEY and the account's API entitlement. (${text})`
  }
  if (/InvalidPinCode|Invalid.*Area|not serviceable|is not served/i.test(text)) {
    return `Pickup or delivery pincode is not serviceable for this service. (${text})`
  }
  if (/weight/i.test(text)) {
    return `The weight is not accepted for this service. (${text})`
  }
  if (/mobile|phone|contact/i.test(text)) {
    return `The pickup contact number was rejected. (${text})`
  }
  if (/address/i.test(text)) {
    return `The pickup or delivery address was rejected. (${text})`
  }
  return text || 'Bluedart rejected the booking.'
}

const parseBlueDartDate = (value) => {
  const match = /\/Date\((-?\d+)/.exec(String(value || ''))
  return match ? new Date(Number(match[1])) : null
}

// Pincode-finder fields per product code: pickup (Outbound), delivery
// (Inbound) and the declared-value limit.
const SERVICE_FLAGS = {
  D: { pickup: 'DomesticPriorityOutbound', delivery: 'DomesticPriorityInbound', limit: 'DPDutsValueLimit' },
  A: { pickup: 'ApexOutbound', delivery: 'ApexInbound', limit: 'AirValueLimit' },
  E: { pickup: 'GroundOutbound', delivery: 'GroundInbound', limit: 'GroundValueLimit' },
}

// Bluedart authorises pickups per origin area: a customer code only books
// from the areas it is registered for. BLUEDART_CUSTOMER_CODES maps areas to
// codes ("GGN:940111,DPG:123456"); without it, only BLUEDART_ORIGIN_AREA works.
const customerCodeForArea = (areaCode) => {
  const map = new Map()
  for (const pair of (process.env.BLUEDART_CUSTOMER_CODES || '').split(',')) {
    const [area, code] = pair.split(':').map((s) => s.trim().toUpperCase())
    if (area && code) {
      map.set(area, code)
    }
  }
  if (!map.size && envValue('BLUEDART_ORIGIN_AREA')) {
    map.set(envValue('BLUEDART_ORIGIN_AREA').toUpperCase(), envValue('BLUEDART_CUSTOMER_CODE'))
  }
  return map.get(String(areaCode || '').toUpperCase()) || ''
}

const PINCODE_CACHE_MS = 60 * 60 * 1000
const pincodeCache = new Map()

// Pincode-finder call with Bluedart errors turned into warehouse messages.
const fetchPincodeDetails = async (pincode) => {
  try {
    return await getServicesForPincode(pincode)
  } catch (error) {
    if (!(error instanceof BlueDartError)) {
      throw error
    }
    throw new WarehouseError(
      /InvalidPinCode/i.test(error.message)
        ? `Pincode ${pincode} is not served by Bluedart`
        : plainBluedartError(error.message),
      422,
    )
  }
}

// Pickup, delivery and value limit per service code.
const servicesFromPincode = (raw) => {
  const services = {}
  for (const [code, flags] of Object.entries(SERVICE_FLAGS)) {
    services[code] = {
      pickup: raw[flags.pickup] === 'Yes',
      delivery: raw[flags.delivery] === 'Yes',
      valueLimit: Number(raw[flags.limit]) || null,
    }
  }
  return services
}

/**
 * Bluedart serviceability for a pincode, summarised per service and cached
 * for an hour (area codes and service lists change rarely).
 */
const checkPincode = async (pincode) => {
  const cached = pincodeCache.get(pincode)
  if (cached && cached.expires > Date.now()) {
    return cached.value
  }
  const raw = await fetchPincodeDetails(pincode)
  // Some unknown pincodes come back "successful" but without an area code.
  if (!String(raw?.AreaCode || '').trim()) {
    throw new WarehouseError(`Pincode ${pincode} is not served by Bluedart`, 422)
  }
  const services = servicesFromPincode(raw)
  const value = {
    pincode,
    areaCode: String(raw.AreaCode || '').trim(),
    city: String(raw.CityDescription || '').trim(),
    state: String(raw.State || '').trim(),
    description: String(raw.PincodeDescription || '').trim(),
    embargo: raw.Embargo === 'Yes',
    holidays: (raw.BlueDartHolidays || [])
      .map((h) => parseBlueDartDate(h.HolidayDate))
      .filter(Boolean)
      .map((d) => moment(d).format(DATE_FORMAT)),
    services,
  }
  pincodeCache.set(pincode, { value, expires: Date.now() + PINCODE_CACHE_MS })
  return value
}

/**
 * Which configured services can carry this item: pickup at the store pincode
 * and delivery at the warehouse pincode, within the value limit.
 */
const serviceOptions = (pickupInfo, dropInfo, declaredValue) =>
  bluedartServices().map((service) => {
    const pickup = pickupInfo?.services[service.code]
    const drop = dropInfo?.services[service.code]
    let reason = ''
    if (pickupInfo && pickup && !pickup.pickup) {
      reason = `No pickup from ${pickupInfo.pincode}`
    } else if (dropInfo && drop && !drop.delivery) {
      reason = `No delivery to ${dropInfo.pincode}`
    } else if (pickup?.valueLimit && declaredValue > pickup.valueLimit) {
      reason = `Value above ₹${pickup.valueLimit.toLocaleString('en-IN')} limit`
    }
    return { ...service, available: !reason, reason }
  })

const pincodeServiceability = async (req, res) => {
  try {
    const pincode = String(req.params.pincode || '')
    if (!/^[1-9]\d{5}$/.test(pincode)) {
      throw new WarehouseError('Enter a valid 6-digit pincode')
    }
    const [pickupInfo, dropInfo] = await Promise.all([
      checkPincode(pincode),
      checkPincode(envValue('BLUEDART_WAREHOUSE_PIN')),
    ])
    return res.status(200).json({
      success: true,
      data: {
        ...pickupInfo,
        options: serviceOptions(pickupInfo, dropInfo, Number(req.query.value) || 0),
      },
    })
  } catch (error) {
    return sendError(res, error, 'Unable to check pincode')
  }
}

const bookingSchema = Joi.object({
  serviceCode: Joi.string().trim().required(),
  pickupDate: Joi.date().required(),
  pickupPincode: Joi.string().trim().pattern(/^[1-9]\d{5}$/).allow(''),
  amount: Joi.number().greater(0).max(MAX_AMOUNT).custom(twoDecimals)
    .messages({ 'number.precision': 'Amount can have at most 2 decimals' }),
  quantity: Joi.number().integer().min(1).max(100),
  weight: Joi.number().greater(0).max(100).custom(twoDecimals)
    .messages({ 'number.precision': 'Weight can have at most 2 decimals' }),
  length: Joi.number().greater(0).max(300),
  width: Joi.number().greater(0).max(300),
  height: Joi.number().greater(0).max(300),
})

const bulkBookingSchema = Joi.object({
  leadIds: Joi.array().items(Joi.string().hex().length(24)).min(1).max(50).required(),
  serviceCode: Joi.string().trim().required(),
  pickupDate: Joi.date().required(),
})

/**
 * Everything the booking form needs: store pickup details, warehouse drop,
 * package values and the services on offer.
 */
const loadBookingContext = async (leadId) => {
  if (!mongoose.Types.ObjectId.isValid(leadId)) {
    throw new WarehouseError(INVALID_LEAD_ID)
  }
  // Lead, its paid lot and the pickup store in one round trip, in parallel
  // with the warehouse record.
  const [item, [joined]] = await Promise.all([
    loadItem(leadId),
    leads.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(leadId) } },
      {
        $project: {
          uniqueCode: 1, price: 1, bonusPrice: 1, negotiatedAmount: 1,
          couponDiscount: 1, storeId: 1, modelId: 1, ram: 1, storage: 1,
        },
      },
      ...lookupOne('models', 'modelId', 'model'),
      {
        $lookup: {
          from: 'deviceslots',
          localField: '_id',
          foreignField: 'deviceList',
          pipeline: [
            { $match: PAID_LOT_MATCH },
            { $sort: { updatedAt: -1 } },
            { $limit: 1 },
            { $project: { storeId: 1, uniqueCode: 1 } },
          ],
          as: 'lot',
        },
      },
      { $unwind: { path: '$lot', preserveNullAndEmptyArrays: true } },
      { $addFields: { storeRef: { $ifNull: ['$lot.storeId', '$storeId'] } } },
      ...lookupOne('stores', 'storeRef', 'store'),
    ]),
  ])
  const { lot = null, store = null, model = null, ...lead } = joined || {}
  lead.modelName = model?.name || ''
  const finalPrice =
    (lead?.price || 0) +
    (lead?.bonusPrice || 0) +
    (lead?.negotiatedAmount || 0) +
    (lead?.couponDiscount || 0)
  return { item, lead, lot, store, finalPrice }
}

// Serviceability is best-effort here; the booking re-checks it.
const contextServiceability = (pickupPincode, dropPincode) =>
  Promise.all([
    pickupPincode ? checkPincode(pickupPincode).catch((e) => ({ error: e.message })) : null,
    dropPincode ? checkPincode(dropPincode).catch(() => null) : null,
  ])

// Pickup block of the booking form: the store plus what Bluedart says about
// its pincode and area.
const pickupDetails = (store, pincode, pickupInfo) => {
  const areaCode = pickupInfo?.areaCode || ''
  const areaEnabled = areaCode ? Boolean(customerCodeForArea(areaCode)) : null
  return {
    name: store?.storeName || '',
    address: store?.address || '',
    pincode,
    contact: store?.contactNumber || '',
    email: store?.email || '',
    region: store?.region || '',
    city: pickupInfo?.city || '',
    state: pickupInfo?.state || '',
    pincodeError: pickupInfo?.error || '',
    areaCode,
    areaEnabled,
    areaMessage: '',
    holidays: pickupInfo?.holidays || [],
  }
}

const bookingContext = async (req, res) => {
  try {
    const { item, lead, lot, store, finalPrice } = await loadBookingContext(
      req.params.leadId,
    )
    const configured = blueDartConfigurationStatus().configured
    const pincode = pincodeFromAddress(store?.address)
    const drop = warehouseAddress()
    const [pickupInfo, dropInfo] = configured
      ? await contextServiceability(pincode, drop.pincode)
      : [null, null]
    const declaredValue = item.amount ?? finalPrice
    return res.status(200).json({
      success: true,
      data: {
        configured,
        bookable: BOOKABLE_STATUSES.includes(item.logisticsStatus),
        logisticsStatus: item.logisticsStatus,
        leadCode: lead?.uniqueCode || '',
        lotCode: lot?.uniqueCode || '',
        services: serviceOptions(
          pickupInfo?.error ? null : pickupInfo,
          dropInfo,
          declaredValue,
        ),
        pickup: pickupDetails(store, pincode, pickupInfo),
        drop: { ...drop, city: dropInfo?.city || '', state: dropInfo?.state || '' },
        package: {
          amount: declaredValue,
          quantity: item.quantity,
          weight: item.weight,
          length: item.dimensions.length,
          width: item.dimensions.width,
          height: item.dimensions.height,
        },
        pickupDate: {
          default: nextWorkingDay(),
          min: moment().format(DATE_FORMAT),
          max: moment().add(MAX_PICKUP_DAYS_AHEAD, 'days').format(DATE_FORMAT),
        },
      },
    })
  } catch (error) {
    return sendError(res, error, 'Unable to load booking details')
  }
}

const validatePickupDate = (pickupDate) => {
  const day = moment(pickupDate).startOf('day')
  if (day.isBefore(moment().startOf('day'))) {
    throw new WarehouseError('Pickup date cannot be in the past')
  }
  if (day.isAfter(moment().add(MAX_PICKUP_DAYS_AHEAD, 'days').endOf('day'))) {
    throw new WarehouseError(
      `Pickup date must be within ${MAX_PICKUP_DAYS_AHEAD} days`,
    )
  }
  if (day.day() === 0) {
    throw new WarehouseError('Bluedart does not pick up on Sundays')
  }
}

/**
 * Book one item with Bluedart. Shared by the single and bulk actions.
 * Idempotency: a lock blocks parallel attempts, and the CreditReferenceNo of
 * an attempt with an unknown outcome is reused on retry — Bluedart refuses a
 * second waybill for the same reference and names the existing one, which is
 * then recovered instead of booking twice.
 */
// What is inside the parcel, printed on the label's Commodity line: a used
// phone, its model and configuration. No IMEI or customer data - the label is
// visible to anyone handling the parcel.
const bluedartCommodity = (lead) => {
  const clip = (value, size = 30) => String(value || '').trim().toUpperCase().slice(0, size)
  return {
    CommodityDetail1: 'USED MOBILE PHONE',
    CommodityDetail2: clip(lead.modelName),
    CommodityDetail3: clip([lead.ram, lead.storage].filter(Boolean).join(' ')),
  }
}

// Checks that need no Bluedart call: bookable status, a known service, a
// valid pickup date and complete pickup/warehouse details.
const resolveBookingInputs = ({ item, store, values }) => {
  if (!BOOKABLE_STATUSES.includes(item.logisticsStatus)) {
    throw new WarehouseError(`Item is already ${item.logisticsStatus}`, 409)
  }
  const service = bluedartServices().find((s) => s.code === values.serviceCode)
  if (!service) {
    throw new WarehouseError('Choose a valid Bluedart service')
  }
  validatePickupDate(values.pickupDate)

  const pincode = values.pickupPincode || pincodeFromAddress(store?.address)
  const mobile = String(store?.contactNumber || '').replace(/\D/g, '').slice(-10)
  const drop = warehouseAddress()
  const missing = []
  if (!store?.address) {
    missing.push('store address')
  }
  if (!pincode) {
    missing.push('pickup pincode')
  }
  if (mobile.length !== 10) {
    missing.push('store contact number')
  }
  if (!drop.address1 || !drop.pincode) {
    missing.push('warehouse address (configuration)')
  }
  if (missing.length) {
    throw new WarehouseError(`Cannot book: missing ${missing.join(', ')}`)
  }
  return { service, pincode, mobile, drop }
}

// Serviceability before calling Bluedart: both ends must support the chosen
// service. The origin area and customer code are fixed in buildBookingRequest.
const assertServiceable = async ({ service, pincode, drop, declaredValue, pickupDate }) => {
  const [pickupInfo, dropInfo] = await Promise.all([
    checkPincode(pincode),
    checkPincode(drop.pincode),
  ])
  const flags = pickupInfo.services[service.code]
  if (flags && !flags.pickup) {
    throw new WarehouseError(
      `${service.label} cannot pick up from ${pincode} (${pickupInfo.city}). Choose another service.`,
      422,
    )
  }
  if (dropInfo.services[service.code] && !dropInfo.services[service.code].delivery) {
    throw new WarehouseError(
      `${service.label} cannot deliver to the warehouse pincode ${drop.pincode}.`,
      422,
    )
  }
  if (pickupInfo.embargo) {
    throw new WarehouseError(`Bluedart has an embargo on pincode ${pincode}`, 422)
  }
  if (flags?.valueLimit && declaredValue > flags.valueLimit) {
    throw new WarehouseError(
      `Declared value is above the ${service.label} limit of ₹${flags.valueLimit.toLocaleString('en-IN')}`,
      422,
    )
  }
  const pickupDay = moment(pickupDate).format(DATE_FORMAT)
  if (pickupInfo.holidays.includes(pickupDay)) {
    throw new WarehouseError(
      `${pickupDay} is a Bluedart holiday at ${pickupInfo.city}. Pick another date.`,
    )
  }
  return { pickupInfo }
}

// Take the lock (or an expired one) for this attempt. A pending reference
// from an attempt with an unknown outcome is reused.
const acquireBookingLock = async (item, lead) => {
  const reference =
    item.pendingReference ||
    toCreditReference(`${lead.uniqueCode}${item.bookingAttempts + 1}`)
  const locked = await warehouseItemModel.findOneAndUpdate(
    {
      _id: item._id,
      logisticsStatus: item.logisticsStatus,
      $or: [
        { 'bookingLock.at': null },
        { 'bookingLock.at': { $lt: new Date(Date.now() - BOOKING_LOCK_MS) } },
      ],
    },
    {
      $set: { bookingLock: { reference, at: new Date() } },
      $inc: { bookingAttempts: item.pendingReference ? 0 : 1 },
    },
    { new: true },
  )
  if (!locked) {
    throw new WarehouseError('A booking for this item is already in progress', 409)
  }
  return { reference, locked }
}

const buildBookingRequest = ({
  store, lead, locked, finalPrice, values, service, pincode, mobile, drop,
  reference,
}) => {
  const [address1, address2, address3] = splitAddress(store.address)
  return buildWaybillRequest({
    pickup: {
      originArea: envValue('BLUEDART_ORIGIN_AREA'),
      customerCode: envValue('BLUEDART_CUSTOMER_CODE'),
      name: store.storeName,
      address1,
      address2,
      address3,
      pincode,
      mobile,
      email: store.email || '',
      gstNumber: envValue('BLUEDART_SHIPPER_GST'),
      isToPayCustomer: true,
    },
    drop,
    returnAddress: drop,
    service: {
      productCode: service.code,
      // Non-document (1) unless configured otherwise; see productType().
      productType: envValue('BLUEDART_PRODUCT_TYPE'),
      subProductCode: envValue('BLUEDART_SUB_PRODUCT_CODE'),
      commodity: bluedartCommodity(lead),
      specialInstruction: envValue('BLUEDART_SPECIAL_INSTRUCTION', 'FRAGILE ELECTRONICS'),
      declaredValue: locked.amount ?? finalPrice,
      actualWeight: locked.weight,
      pieceCount: locked.quantity,
      dimensions: [
        {
          Length: locked.dimensions.length,
          Breadth: locked.dimensions.width,
          Height: locked.dimensions.height,
          Count: locked.quantity,
        },
      ],
      pickupDate: moment(values.pickupDate).startOf('day').toDate(),
      pickupTime: '1400',
      creditReferenceNo: reference,
      registerPickup: true,
    },
  })
}

// Release the lock after a failed waybill call and tell the user why.
const recordBookingFailure = async ({ error, item, reference, actor, lead }) => {
  const known = error instanceof BlueDartError
  await warehouseItemModel.updateOne(
    { _id: item._id },
    {
      $set: {
        bookingLock: { reference: '', at: null },
        // Unknown outcome (timeout, network): keep the reference so a retry
        // cannot create a second waybill.
        pendingReference: known ? '' : reference,
      },
      $push: {
        history: historyEntry(actor, 'BOOKING_FAILED', {
          note: known ? error.message : `No response from Bluedart (${error.message})`,
        }),
      },
    },
  )
  safeLog.error(`Bluedart booking failed for ${lead.uniqueCode}: ${error.message}`)
  throw new WarehouseError(
    known
      ? plainBluedartError(error.message.replace(/^Blue Dart waybill rejected: /, ''))
      : 'Bluedart did not respond. Please try again — the retry cannot create a duplicate booking.',
    known ? 422 : 504,
  )
}

// Generate the waybill. If a previous attempt with this reference already
// booked, Bluedart names that AWB and it is adopted instead.
const requestWaybill = async ({ request, item, reference, actor, lead }) => {
  try {
    return { result: await generateWaybill(request), recovered: false }
  } catch (error) {
    const existing = /already gener\w*.*?Waybill No\s*:\s*(\d+)/i.exec(error.message)
    if (existing) {
      return { result: { awbNo: existing[1] }, recovered: true }
    }
    return recordBookingFailure({ error, item, reference, actor, lead })
  }
}

// A failed label upload must not fail the booking.
const uploadLabelSafely = async (result) => {
  if (!result.labelContent) {
    return { key: '', url: '' }
  }
  try {
    return await uploadShippingLabelToS3(result.labelContent, result.awbNo)
  } catch (error) {
    safeLog.error(`Label upload failed for AWB ${result.awbNo}: ${error.message}`)
    return { key: '', url: '' }
  }
}

const bookingNotes = (service, recovered, pickupFailed, result) => {
  const notes = [`Bluedart ${service.label}`]
  if (recovered) {
    notes.push('recovered from an earlier attempt; label not available')
  }
  if (pickupFailed) {
    notes.push(`pickup not registered: ${result.pickupRegistrationError}`)
  }
  return notes.join('; ')
}

// Store the new shipment, mark the item Booked and release the lock.
const saveBookedShipment = async ({
  item, locked, reference, result, recovered, label, service, values, actor,
}) => {
  const isReTransit = locked.logisticsStatus === LOGISTICS_STATUS.CANCELLED
  const pickupFailed = result.pickupRegistrationFailed &&
    !/already ?regist/i.test(result.pickupRegistrationError || '')
  const shipment = {
    awbNo: String(result.awbNo),
    courierName: 'Bluedart',
    bookingMode: BOOKING_MODE.BLUEDART,
    serviceType: service.label,
    serviceCode: service.code,
    labelKey: label.key,
    labelUrl: label.url,
    pickupDate:
      parseBlueDartDate(result.shipmentPickupDate) ||
      moment(values.pickupDate).startOf('day').toDate(),
    pickupTokenNumber: result.tokenNumber || '',
    reference,
    bookedBy: actor.id,
    bookedAt: new Date(),
  }
  const updated = await warehouseItemModel.findOneAndUpdate(
    { _id: item._id, 'bookingLock.reference': reference },
    {
      $set: {
        shipment,
        logisticsStatus: LOGISTICS_STATUS.BOOKED,
        bookingLock: { reference: '', at: null },
        pendingReference: '',
      },
      $inc: { reTransitCount: isReTransit ? 1 : 0 },
      $push: {
        history: historyEntry(actor, isReTransit ? 'RE_TRANSIT' : 'BOOKED', {
          field: 'awbNo',
          newValue: shipment.awbNo,
          note: bookingNotes(service, recovered, pickupFailed, result),
        }),
      },
    },
    { new: true },
  )
  return { item: updated, pickupFailed, pickupError: result.pickupRegistrationError, recovered }
}

const bookWithBluedart = async ({ leadId, values, actor }) => {
  const { item, lead, store, finalPrice } = await loadBookingContext(leadId)
  const { service, pincode, mobile, drop } = resolveBookingInputs({ item, store, values })
  await assertServiceable({
    service,
    pincode,
    drop,
    declaredValue: values.amount ?? item.amount ?? finalPrice,
    pickupDate: values.pickupDate,
  })

  applyPackageChanges(item, values, finalPrice, actor)
  await item.save()

  const { reference, locked } = await acquireBookingLock(item, lead)
  const request = buildBookingRequest({
    store, lead, locked, finalPrice, values, service, pincode, mobile, drop,
    reference,
  })
  const { result, recovered } = await requestWaybill({ request, item, reference, actor, lead })
  const label = await uploadLabelSafely(result)
  return saveBookedShipment({
    item, locked, reference, result, recovered, label, service, values, actor,
  })
}

const bluedartBooking = async (req, res) => {
  try {
    if (!blueDartConfigurationStatus().configured) {
      throw new WarehouseError('Bluedart is not configured on the server', 503)
    }
    const values = validate(bookingSchema, req.body)
    const actor = await loadActor(req.userId)
    const outcome = await bookWithBluedart({ leadId: req.params.leadId, values, actor })
    let message = `Booked with Bluedart — AWB ${outcome.item.shipment.awbNo}`
    if (outcome.pickupFailed) {
      message += '. Pickup was not registered; please arrange it with Bluedart.'
    }
    return res.status(200).json({ success: true, message, data: itemResponse(outcome.item) })
  } catch (error) {
    return sendError(res, error, 'Unable to book with Bluedart')
  }
}

/**
 * Book several items with one service and pickup date. Each item uses its own
 * saved package values; results are reported per item (partial success).
 */
const bluedartBulkBooking = async (req, res) => {
  try {
    if (!blueDartConfigurationStatus().configured) {
      throw new WarehouseError('Bluedart is not configured on the server', 503)
    }
    const body = validate(bulkBookingSchema, req.body)
    validatePickupDate(body.pickupDate)
    const actor = await loadActor(req.userId)
    const results = []
    // One at a time: Bluedart registers one pickup per address per day.
    for (const leadId of [...new Set(body.leadIds)]) {
      try {
        const outcome = await bookWithBluedart({
          leadId,
          values: { serviceCode: body.serviceCode, pickupDate: body.pickupDate },
          actor,
        })
        results.push({
          leadId,
          success: true,
          awbNo: outcome.item.shipment.awbNo,
          pickupFailed: outcome.pickupFailed,
        })
      } catch (error) {
        results.push({
          leadId,
          success: false,
          message: error instanceof WarehouseError ? error.message : 'Unexpected error',
        })
      }
    }
    const booked = results.filter((r) => r.success).length
    return res.status(200).json({
      success: true,
      message: `${booked} of ${results.length} items booked`,
      data: results,
    })
  } catch (error) {
    return sendError(res, error, 'Unable to book with Bluedart')
  }
}

/* ---------------------------- BLUEDART TRACKING --------------------------- */

const TRACKABLE_STATUSES = [
  LOGISTICS_STATUS.BOOKED,
  LOGISTICS_STATUS.PICKUP_REGISTERED,
  LOGISTICS_STATUS.OUT_FOR_PICKUP,
  LOGISTICS_STATUS.PICKUP_COMPLETE,
  LOGISTICS_STATUS.IN_TRANSIT,
]

const PICKUP_PENDING_STATUSES = [
  LOGISTICS_STATUS.PICKUP_REGISTERED,
  LOGISTICS_STATUS.OUT_FOR_PICKUP,
]

const PICKUP_DATE = 'shipment.pickupDate'

/**
 * Map a Bluedart scan to our logistics status. Cancellation text wins over the
 * StatusType code (PU also covers cancellations). PU means pickup pending, so
 * only an explicit "picked up" scan completes the pickup.
 */
export const mapTrackingStatus = ({ status, statusType }) => {
  const type = String(statusType || '').toUpperCase()
  const text = String(status || '').toLowerCase()
  if (/cancel/.test(text)) {
    return LOGISTICS_STATUS.CANCELLED
  }
  if (type === 'DL' || (/deliver/.test(text) && !/undeliver|out for deliver|not deliver/.test(text))) {
    return LOGISTICS_STATUS.DELIVERED
  }
  if (type === 'IT' || type === 'OD' || /transit|out for deliver|arrived|departed|connected|reached|forwarded/.test(text)) {
    return LOGISTICS_STATUS.IN_TRANSIT
  }
  if (/picked up|pickup (done|completed?)|shipment pick(?:ed)? up|handed over/.test(text)) {
    return LOGISTICS_STATUS.PICKUP_COMPLETE
  }
  if (/pickup (has been )?registered|online shipment booked|pickup registration/.test(text)) {
    return LOGISTICS_STATUS.PICKUP_REGISTERED
  }
  if (type === 'PU' || /pickup (scheduled|assigned|initiated|employee|executive)|out for pickup/.test(text)) {
    return LOGISTICS_STATUS.OUT_FOR_PICKUP
  }
  return null
}

export const canApplyTrackingStatus = (currentStatus, mappedStatus, rawStatus = '') => {
  if (mappedStatus === LOGISTICS_STATUS.CANCELLED) {
    return TRACKABLE_STATUSES.includes(currentStatus)
  }
  if (
    currentStatus === LOGISTICS_STATUS.PICKUP_COMPLETE &&
    PICKUP_PENDING_STATUSES.includes(mappedStatus) &&
    /registered|registration|scheduled|assigned|initiated|online shipment booked|out for pickup|pickup employee/i.test(
      rawStatus,
    )
  ) {
    return true
  }
  const from = STATUS_ORDER.indexOf(currentStatus)
  return from >= 0 && STATUS_ORDER.indexOf(mappedStatus) > from
}

// "30 October 2026" + "14:05" (or other formats) to a Date, else null.
const parseTrackingDate = (date, time) => {
  if (!date) {
    return null
  }
  const parsed = moment(`${date} ${time || ''}`.trim(), [
    'DD MMMM YYYY HH:mm', 'DD-MMM-YYYY HH:mm', 'DD/MM/YYYY HH:mm', 'DD MMMM YYYY', 'DD-MMM-YYYY', 'DD/MM/YYYY',
  ])
  return parsed.isValid() ? parsed.toDate() : null
}

const TRACKING_DISABLED_MESSAGE =
  'Bluedart tracking is not enabled on our account yet (tracking licence key missing). Status cannot be fetched.'

const trackingErrorMessage = (error) =>
  /License Mismatch/i.test(error.message) ? TRACKING_DISABLED_MESSAGE : `Bluedart tracking failed: ${error.message}`

const buildTrackingSet = (entry, now) => {
  const set = {
    'shipment.trackedAt': now,
    'shipment.trackingError': entry.error || '',
  }
  if (entry.status) {
    set['shipment.trackingStatus'] = entry.status
    set['shipment.trackingStatusType'] = entry.statusType || ''
    set['shipment.trackingStatusAt'] = [entry.statusDate, entry.statusTime].filter(Boolean).join(' ')
  }
  const edd = parseTrackingDate(entry.expectedDeliveryDate)
  if (edd) {
    set['shipment.edd'] = edd
  }
  return set
}

const getMappedTrackingStatus = (entry) => (entry.status ? mapTrackingStatus(entry) : null)

const isCorrectedPickup = (item, mapped, moved) =>
  moved &&
  item.logisticsStatus === LOGISTICS_STATUS.PICKUP_COMPLETE &&
  PICKUP_PENDING_STATUSES.includes(mapped)

const applyMappedStatus = (set, entry, mapped, correctedPickup, now) => {
  set.logisticsStatus = mapped
  const scanDate = parseTrackingDate(entry.statusDate, entry.statusTime) || now
  if (mapped === LOGISTICS_STATUS.DELIVERED) {
    set['shipment.deliveryDate'] = scanDate
  }
  if (mapped === LOGISTICS_STATUS.PICKUP_COMPLETE) {
    set[PICKUP_DATE] = scanDate
  }
  if (correctedPickup || mapped === LOGISTICS_STATUS.CANCELLED) {
    set[PICKUP_DATE] = null
  }
  if (mapped === LOGISTICS_STATUS.CANCELLED) {
    set['shipment.cancelledAt'] = scanDate
    set['shipment.cancelReason'] = entry.status
  }
}

const trackingHistoryEntry = (actor, item, mapped, status) =>
  historyEntry(actor, 'STATUS_CHANGE', {
    field: 'logisticsStatus',
    oldValue: item.logisticsStatus,
    newValue: mapped,
    note: `Bluedart tracking: ${status}`,
  })

/**
 * Apply one tracking scan to an item: store Bluedart's status text, EDD and
 * delivery date, and move our status forward when the scan maps to a later
 * step. Returns what changed for the caller to report.
 */
const applyTrackingEntry = async (item, entry, actor) => {
  const now = new Date()
  const set = buildTrackingSet(entry, now)
  const mapped = getMappedTrackingStatus(entry)
  const moved = Boolean(mapped && canApplyTrackingStatus(item.logisticsStatus, mapped, entry.status))
  const correctedPickup = isCorrectedPickup(item, mapped, moved)
  const update = { $set: set }
  if (moved) {
    applyMappedStatus(set, entry, mapped, correctedPickup, now)
    update.$push = {
      history: trackingHistoryEntry(actor, item, mapped, entry.status),
    }
  }
  const updated = await warehouseItemModel.findOneAndUpdate(
    { _id: item._id, logisticsStatus: item.logisticsStatus },
    update,
    { new: true },
  )
  return {
    item: updated || item,
    moved: Boolean(moved && updated),
    from: item.logisticsStatus,
    to: moved ? mapped : item.logisticsStatus,
  }
}

/**
 * Track one Bluedart shipment on demand and update its status from the scan.
 */
const trackShipmentStatus = async (req, res) => {
  try {
    const item = await loadItem(req.params.leadId)
    if (item.shipment?.bookingMode !== BOOKING_MODE.BLUEDART) {
      throw new WarehouseError('Only Bluedart shipments can be tracked', 409)
    }
    if (!TRACKABLE_STATUSES.includes(item.logisticsStatus)) {
      throw new WarehouseError(`Shipment is already ${item.logisticsStatus}`, 409)
    }
    let entries
    try {
      entries = parseTrackingResponse(await trackShipment([item.shipment.awbNo]))
    } catch (error) {
      await warehouseItemModel.updateOne(
        { _id: item._id },
        { $set: { 'shipment.trackingError': trackingErrorMessage(error), 'shipment.trackedAt': new Date() } },
      )
      throw new WarehouseError(trackingErrorMessage(error), 502)
    }
    const entry =
      entries.find((e) => String(e.awbNo) === String(item.shipment.awbNo)) || entries[0]
    if (!entry || (!entry.status && !entry.error)) {
      throw new WarehouseError('Bluedart returned no tracking details for this AWB yet', 404)
    }
    const actor = await loadActor(req.userId)
    const result = await applyTrackingEntry(item, entry, { ...actor, name: `${actor.name} (Track)` })
    let message
    if (entry.error) {
      message = `Bluedart: ${entry.error}`
    } else if (result.moved) {
      message = `Status updated from ${result.from} to ${result.to}`
    } else {
      message = `No status change — Bluedart says: ${entry.status}`
    }
    return res.status(200).json({
      success: true,
      message,
      data: {
        ...itemResponse(result.item),
        tracking: {
          bluedartStatus: entry.status || '',
          bluedartStatusType: entry.statusType || '',
          statusAt: [entry.statusDate, entry.statusTime].filter(Boolean).join(' '),
          expectedDeliveryDate: entry.expectedDeliveryDate || '',
          error: entry.error || '',
          moved: result.moved,
          from: result.from,
          to: result.to,
        },
      },
    })
  } catch (error) {
    return sendError(res, error, 'Unable to track shipment')
  }
}

export default {
  bookingContext,
  bluedartBooking,
  bluedartBulkBooking,
  pincodeServiceability,
  trackShipmentStatus,
}
