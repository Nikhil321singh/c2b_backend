import Joi from 'joi'
import mongoose from 'mongoose'
import { safeLog } from '../utils/piiMasking.js'
import logisticModel from '../models/logisticModel.js'
import {
  getShippingLabelSignedUrl,
  uploadShippingLabelToS3,
} from '../utils/invoiceHelpers.js'
import {
  BlueDartConfigurationError,
  BlueDartError,
  BlueDartMappingError,
  blueDartConfigurationStatus,
  buildWaybillRequest,
  cancelPickup,
  cancelWaybill,
  formatBlueDartDate,
  formatBlueDartTime,
  generateWaybill,
  parseTrackingResponse,
  registerPickup,
  toCreditReference,
  trackShipment,
} from '../services/blueDartService.js'

const env = (key, fallback = '') => (process.env[key] || fallback).trim()

// Company warehouse from configuration: the default drop and return address.
const warehouseAddress = () => ({
  name: env('BLUEDART_WAREHOUSE_NAME', 'GREST Warehouse'),
  address1: env('BLUEDART_WAREHOUSE_ADDR1'),
  address2: env('BLUEDART_WAREHOUSE_ADDR2'),
  pincode: env('BLUEDART_WAREHOUSE_PIN'),
  mobile: env('BLUEDART_WAREHOUSE_MOBILE'),
  email: env('BLUEDART_WAREHOUSE_EMAIL'),
  gstNumber: env('BLUEDART_WAREHOUSE_GST'),
  addressType: env('BLUEDART_WAREHOUSE_ADDRESS_TYPE', 'C'),
})

// Blue Dart returns dates as "/Date(1793212200000+0530)/".
const parseBlueDartDate = (value) => {
  const match = /\/Date\((-?\d+)/.exec(String(value || ''))
  return match ? new Date(Number(match[1])) : null
}

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/).messages({
  'string.pattern.base': '{{#label}} must be a valid id',
})

const sendError = (res, error) => {
  if (error instanceof BlueDartConfigurationError) {
    return res.status(503).json({ success: false, message: error.message })
  }
  if (error instanceof BlueDartMappingError) {
    return res.status(400).json({ success: false, message: error.message })
  }
  if (error instanceof BlueDartError) {
    return res.status(502).json({ success: false, message: error.message })
  }
  // Log the message only: an axios error's config carries the Blue Dart
  // token and licence key.
  safeLog.error(`Blue Dart request failed: ${error.message}`)
  return res
    .status(500)
    .json({ success: false, message: 'Unable to process Blue Dart request' })
}

const validate = (schema, body) => {
  const { error, value } = schema.validate(body || {}, { abortEarly: false })
  if (error) {
    throw new BlueDartMappingError(error.details.map((d) => d.message).join(', '))
  }
  return value
}

const addressSchema = Joi.object({
  name: Joi.string().required(),
  address1: Joi.string().required(),
  address2: Joi.string().allow(''),
  address3: Joi.string().allow(''),
  pincode: Joi.string().pattern(/^\d{6}$/).required(),
  mobile: Joi.string().allow(''),
  email: Joi.string().allow(''),
  gstNumber: Joi.string().allow(''),
  addressType: Joi.string().valid('C', 'R'),
})

const createShipmentSchema = Joi.object({
  leadId: objectId.allow(null, ''),
  referenceId: Joi.string().required(),
  pickup: addressSchema.required(),
  drop: addressSchema,
  declaredValue: Joi.number().min(0).default(0),
  weight: Joi.number().positive(),
  pieceCount: Joi.number().integer().min(1).default(1),
  pickupDate: Joi.date(),
  pickupTime: Joi.string().pattern(/^\d{4}$/),
  registerPickup: Joi.boolean().default(true),
})

const trackSchema = Joi.object({
  awbNumbers: Joi.array().items(Joi.string().pattern(/^\d+$/)).min(1).max(25).required(),
  scan: Joi.number().valid(0, 1).default(1),
})

const cancelWaybillSchema = Joi.object({
  awbNo: Joi.string().pattern(/^\d+$/).required(),
})

const registerPickupSchema = Joi.object({
  pickup: addressSchema.required(),
  awbNumbers: Joi.array().items(Joi.string().pattern(/^\d+$/)).default([]),
  referenceId: Joi.string().allow('').default(''),
  pickupDate: Joi.date(),
  pickupTime: Joi.string().pattern(/^\d{4}$/).default('1400'),
  officeCloseTime: Joi.string().pattern(/^\d{4}$/).default('1800'),
  pieceCount: Joi.number().integer().min(1).default(1),
  weight: Joi.number().positive(),
  remarks: Joi.string().allow('').default(''),
})

const cancelPickupSchema = Joi.object({
  // Blue Dart pickup tokens are alphanumeric (e.g. "34165512DEMO" on sandbox).
  tokenNumber: Joi.string().required(),
  pickupRegistrationDate: Joi.date().required(),
  remarks: Joi.string().allow('').default('Cancelled by GREST'),
})

const listShipmentsSchema = Joi.object({
  page: Joi.number().integer().min(0).default(0),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().valid('CREATED', 'PICKUP_FAILED', 'CANCELLED'),
  leadId: objectId,
  awbNo: Joi.string(),
  referenceId: Joi.string(),
})

const defaultWeight = () => Number(env('BLUEDART_DEFAULT_WEIGHT', '0.5'))

const actorId = (req) =>
  mongoose.Types.ObjectId.isValid(req.userId) ? req.userId : null

const status = (req, res) => res.json({ success: true, data: blueDartConfigurationStatus() })

const buildShipmentRequest = (body, drop) =>
  buildWaybillRequest({
    pickup: {
      ...body.pickup,
      originArea: env('BLUEDART_ORIGIN_AREA'),
      customerCode: env('BLUEDART_CUSTOMER_CODE'),
      gstNumber: body.pickup.gstNumber || env('BLUEDART_SHIPPER_GST'),
    },
    drop,
    // Undelivered shipments return to the drop address.
    returnAddress: drop,
    service: {
      productCode: env('BLUEDART_PRODUCT_CODE', 'A'),
      productType: env('BLUEDART_PRODUCT_TYPE'),
      subProductCode: env('BLUEDART_SUB_PRODUCT_CODE'),
      declaredValue: body.declaredValue,
      actualWeight: body.weight || defaultWeight(),
      pieceCount: body.pieceCount,
      pickupDate: body.pickupDate,
      pickupTime: body.pickupTime,
      creditReferenceNo: toCreditReference(body.referenceId),
      registerPickup: body.registerPickup,
      isReversePickup: ['true', '1', 'yes'].includes(
        env('BLUEDART_IS_REVERSE_PICKUP').toLowerCase(),
      ),
    },
  })

// A failed label upload must not fail the booking; the label is still
// returned in the response and the error is logged.
const uploadLabelSafely = async (result) => {
  if (!result.labelContent) {
    return { key: '', url: '' }
  }
  try {
    return await uploadShippingLabelToS3(result.labelContent, result.awbNo)
  } catch (error) {
    safeLog.error(
      `Shipping label upload failed for ${result.awbNo}: ${error.message}`,
    )
    return { key: '', url: '' }
  }
}

const pickupStatusFor = (body, result) => {
  if (!body.registerPickup) {
    return ''
  }
  return result.pickupRegistrationFailed ? 'FAILED' : 'REGISTERED'
}

// The AWB already exists at Blue Dart, so a failed save must not hide it
// from the caller: report it and still return the booking.
const saveShipmentSafely = async ({ req, body, drop, result, label }) => {
  try {
    return await logisticModel.create({
      leadId: body.leadId || null,
      referenceId: toCreditReference(body.referenceId),
      awbNo: String(result.awbNo),
      pickupTokenNumber: result.tokenNumber || '',
      pickupDate: parseBlueDartDate(result.shipmentPickupDate),
      pickupRegistrationFailed: result.pickupRegistrationFailed,
      pickupRegistrationError: result.pickupRegistrationError,
      labelKey: label.key,
      labelUrl: label.url,
      destinationArea: result.destinationArea || '',
      destinationLocation: result.destinationLocation || '',
      status: result.pickupRegistrationFailed ? 'PICKUP_FAILED' : 'CREATED',
      pickupStatus: pickupStatusFor(body, result),
      pickup: body.pickup,
      drop,
      declaredValue: body.declaredValue,
      weight: body.weight || defaultWeight(),
      pieceCount: body.pieceCount,
      createdBy: actorId(req),
    })
  } catch (error) {
    safeLog.error(
      `Blue Dart shipment ${result.awbNo} created but not saved: ${error.message}`,
    )
    return null
  }
}

const createShipment = async (req, res) => {
  try {
    const body = validate(createShipmentSchema, req.body)
    const drop = body.drop || warehouseAddress()
    const result = await generateWaybill(buildShipmentRequest(body, drop))
    const label = await uploadLabelSafely(result)
    const shipment = await saveShipmentSafely({ req, body, drop, result, label })

    return res.json({
      success: true,
      ...(shipment
        ? {}
        : { warning: 'Shipment created at Blue Dart but could not be saved' }),
      data: {
        shipmentId: shipment?._id || null,
        awbNo: result.awbNo,
        labelUrl: label.key ? getShippingLabelSignedUrl(label.key) : '',
        tokenNumber: result.tokenNumber,
        shipmentPickupDate: result.shipmentPickupDate,
        destinationArea: result.destinationArea,
        destinationLocation: result.destinationLocation,
        pickupRegistrationFailed: result.pickupRegistrationFailed,
        pickupRegistrationError: result.pickupRegistrationError,
        // Shipping label PDF (base64 / byte array) as returned by Blue Dart.
        labelContent: result.labelContent,
      },
    })
  } catch (error) {
    return sendError(res, error)
  }
}

const track = async (req, res) => {
  try {
    const body = validate(trackSchema, req.body)
    const xml = await trackShipment(body.awbNumbers, { scan: body.scan })
    const entries = parseTrackingResponse(xml)
    const now = new Date()
    await Promise.all(
      entries
        .filter((entry) => entry.awbNo && entry.status)
        .map((entry) =>
          logisticModel.updateOne(
            { awbNo: String(entry.awbNo) },
            {
              $set: {
                trackingStatus: entry.status,
                trackingStatusDate: [entry.statusDate, entry.statusTime]
                  .filter(Boolean)
                  .join(' '),
                expectedDeliveryDate: entry.expectedDeliveryDate || '',
                trackedAt: now,
              },
            },
          ),
        ),
    )
    return res.json({ success: true, data: entries })
  } catch (error) {
    return sendError(res, error)
  }
}

const cancelWaybillHandler = async (req, res) => {
  try {
    const body = validate(cancelWaybillSchema, req.body)
    const result = await cancelWaybill({ AWBNo: body.awbNo })
    await logisticModel.updateOne(
      { awbNo: body.awbNo },
      {
        $set: {
          status: 'CANCELLED',
          cancelledBy: actorId(req),
          cancelledAt: new Date(),
        },
      },
    )
    return res.json({ success: true, message: 'Waybill cancelled', data: result })
  } catch (error) {
    return sendError(res, error)
  }
}

const registerPickupHandler = async (req, res) => {
  try {
    const body = validate(registerPickupSchema, req.body)
    const weight = body.weight || defaultWeight()
    const result = await registerPickup({
      AreaCode: env('BLUEDART_ORIGIN_AREA'),
      // Blue Dart fails with "Index was outside the bounds of the array" on an
      // empty AWBNo or SubProducts list, so both always carry one entry.
      AWBNo: body.awbNumbers.length ? body.awbNumbers : [''],
      CISDDN: false,
      ContactPersonName: body.pickup.name,
      CustomerAddress1: body.pickup.address1,
      CustomerAddress2: body.pickup.address2 || '',
      CustomerAddress3: body.pickup.address3 || '',
      CustomerCode: env('BLUEDART_CUSTOMER_CODE'),
      CustomerName: body.pickup.name,
      CustomerPincode: body.pickup.pincode,
      CustomerTelephoneNumber: '',
      DoxNDox: '2',
      EmailID: body.pickup.email || '',
      IsForcePickup: false,
      IsReversePickup: false,
      MobileTelNo: String(body.pickup.mobile || '').replace(/\D/g, '').slice(-10),
      NumberofPieces: body.pieceCount,
      OfficeCloseTime: body.officeCloseTime,
      ProductCode: env('BLUEDART_PRODUCT_CODE', 'A'),
      ReferenceNo: toCreditReference(body.referenceId),
      Remarks: body.remarks,
      RouteCode: '',
      ShipmentPickupDate: formatBlueDartDate(body.pickupDate || new Date()),
      ShipmentPickupTime: formatBlueDartTime(body.pickupTime),
      SubProducts: [''],
      VolumeWeight: weight,
      WeightofShipment: weight,
      isToPayShipper: false,
    })
    // Attach the new pickup to the shipments it covers.
    const awbNumbers = body.awbNumbers.filter(Boolean)
    if (awbNumbers.length && result.TokenNumber) {
      await logisticModel.updateMany(
        { awbNo: { $in: awbNumbers } },
        {
          $set: {
            pickupTokenNumber: String(result.TokenNumber),
            pickupDate: parseBlueDartDate(result.ShipmentPickupDate),
            pickupStatus: 'REGISTERED',
            pickupRegistrationFailed: false,
            pickupRegistrationError: '',
          },
        },
      )
    }
    return res.json({ success: true, message: 'Pickup registered', data: result })
  } catch (error) {
    return sendError(res, error)
  }
}

const cancelPickupHandler = async (req, res) => {
  try {
    const body = validate(cancelPickupSchema, req.body)
    const result = await cancelPickup({
      TokenNumber: body.tokenNumber,
      PickupRegistrationDate: formatBlueDartDate(body.pickupRegistrationDate),
      Remarks: body.remarks,
    })
    await logisticModel.updateMany(
      { pickupTokenNumber: body.tokenNumber },
      { $set: { pickupStatus: 'CANCELLED' } },
    )
    return res.json({ success: true, message: 'Pickup cancelled', data: result })
  } catch (error) {
    return sendError(res, error)
  }
}

const listShipments = async (req, res) => {
  try {
    const query = validate(listShipmentsSchema, req.query)
    const filter = {}
    for (const key of ['status', 'leadId', 'awbNo', 'referenceId']) {
      if (query[key]) {
        filter[key] = query[key]
      }
    }
    const [items, total] = await Promise.all([
      logisticModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(query.page * query.limit)
        .limit(query.limit)
        .lean(),
      logisticModel.countDocuments(filter),
    ])
    return res.json({
      success: true,
      data: { items, total, page: query.page, limit: query.limit },
    })
  } catch (error) {
    return sendError(res, error)
  }
}

// Fresh signed link to re-print a stored label (valid for 5 minutes).
const getShipmentLabel = async (req, res) => {
  try {
    const shipment = await logisticModel
      .findOne({ awbNo: String(req.params.awbNo) })
      .select('awbNo labelKey')
      .lean()
    if (!shipment) {
      return res
        .status(404)
        .json({ success: false, message: 'Shipment not found' })
    }
    if (!shipment.labelKey) {
      return res
        .status(404)
        .json({ success: false, message: 'No label stored for this shipment' })
    }
    return res.json({
      success: true,
      data: {
        awbNo: shipment.awbNo,
        labelUrl: getShippingLabelSignedUrl(shipment.labelKey),
        expiresInSeconds: 300,
      },
    })
  } catch (error) {
    return sendError(res, error)
  }
}

const getShipment = async (req, res) => {
  try {
    const shipment = await logisticModel
      .findOne({ awbNo: String(req.params.awbNo) })
      .lean()
    if (!shipment) {
      return res
        .status(404)
        .json({ success: false, message: 'Shipment not found' })
    }
    return res.json({ success: true, data: shipment })
  } catch (error) {
    return sendError(res, error)
  }
}

export default {
  status,
  createShipment,
  track,
  cancelWaybill: cancelWaybillHandler,
  registerPickup: registerPickupHandler,
  cancelPickup: cancelPickupHandler,
  listShipments,
  getShipment,
  getShipmentLabel,
}
