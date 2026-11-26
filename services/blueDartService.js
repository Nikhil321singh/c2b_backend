// Blue Dart courier integration, combined into a single module.
//
// Copied from origin/backup/uat-payment-logistics-2026-08-07
// (integrations/bluedart/*.js). Sections:
//   1. Mapper   - GREST data -> Blue Dart GenerateWayBill request (pure)
//   2. Client   - Blue Dart APIs: token, GenerateWayBill, CancelWaybill,
//                 RegisterPickup, CancelPickup, tracking
//   3. Tracking - parse the tracking XML response
//   4. Adapter  - generic courier payload -> Blue Dart shipment
//
// Required .env keys: BLUEDART_BASE_URL, BLUEDART_CLIENT_ID,
// BLUEDART_CLIENT_SECRET (or BLUEDART_JWT_TOKEN), BLUEDART_LOGIN_ID,
// BLUEDART_LICENSE_KEY, BLUEDART_CUSTOMER_CODE, BLUEDART_ORIGIN_AREA,
// BLUEDART_WAREHOUSE_* (see the backup branch's .env.uat.example).

import axios from 'axios'
import { safeLog } from '../utils/piiMasking.js'

const JSON_CONTENT_TYPE = 'application/json'

/* ========================================================================== */
/* 1. MAPPER */
/* ========================================================================== */

// Pure mapping from GREST shipment data to a Blue Dart GenerateWayBill request.
//
// Field names, nesting and value types follow the Blue Dart Apigee
// "Waybill Generation Process" sample request verbatim (Request.Shipper /
// Request.Consignee / Request.Returnadds / Request.Services). Notably Blue Dart
// sends pincodes, mobiles and CustomerCode as JSON numbers rather than strings.
//
// Kept pure (no I/O) so it can be unit tested.

export class BlueDartMappingError extends Error {}

const str = (value) => String(value ?? '').trim()

const requireField = (value, name) => {
  const out = str(value)
  if (!out) {
    throw new BlueDartMappingError(`Blue Dart waybill: "${name}" is required`)
  }
  return out
}

// Pincodes and customer codes are sent as JSON strings, per the Blue Dart API
// reference. This matters: the reference's own sample uses CustomerCode
// "099960", and coercing that to a number would silently drop the leading zero
// and address a different account.
const digitString = (value, name) => {
  const digits = str(value).replace(/\D/g, '')
  if (!digits) {
    throw new BlueDartMappingError(`Blue Dart waybill: "${name}" is required`)
  }
  return digits
}

// Indian mobile numbers arrive with assorted +91 / 0 prefixes and spacing; Blue
// Dart wants the bare 10-digit subscriber number as a string.
const mobile = (value) => {
  const digits = str(value).replace(/\D/g, '')
  if (!digits) {
    return ''
  }
  return digits.slice(-10)
}

// Blue Dart rejects a CreditReferenceNo longer than 20 characters
// ("InvalidCreditReferenceNo"). Enforced here so an over-long reference fails
// in the mapper rather than as an opaque HTTP 400 mid-booking.
export const CREDIT_REFERENCE_MAX_LENGTH = 20

/**
 * Fit a GREST reference into Blue Dart's 20-character limit by keeping the
 * tail, which carries the timestamp/random portion of both a lead uniqueCode
 * and a Mongo ObjectId (24 chars) and so stays unique.
 */
export const toCreditReference = (value) =>
  str(value).slice(-CREDIT_REFERENCE_MAX_LENGTH)

const creditReference = (value) => {
  const out = requireField(value, 'service.creditReferenceNo')
  if (out.length > CREDIT_REFERENCE_MAX_LENGTH) {
    throw new BlueDartMappingError(
      `Blue Dart waybill: "service.creditReferenceNo" must be at most ${CREDIT_REFERENCE_MAX_LENGTH} characters (got ${out.length})`,
    )
  }
  return out
}

// ProductType: 0 = documents (label "Dox/NonDox: 1"), 1 = non-documents
// (label "2"), verified on the sandbox. We ship devices, never documents, so
// the default is 1. Named values are passed through unchanged so the
// configured value can be corrected without a code change. Always returned as
// a string so the mapper's request body is type-consistent.
const productType = (value) => {
  const raw = str(value)
  if (raw === '') {
    return '1'
  }
  return /^\d+$/.test(raw) ? String(Number(raw)) : raw
}

// Blue Dart classic APIs expect dates as "/Date(<epochMs>)/". The sample
// request carries no timezone offset (responses do include "+0530").
export const formatBlueDartDate = (input) => {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) {
    throw new BlueDartMappingError('Blue Dart waybill: invalid pickup date')
  }
  return `/Date(${date.getTime()})/`
}

// Blue Dart pickup time is "HHMM" (e.g. "1430").
export const formatBlueDartTime = (input) => {
  const value = str(input)
  if (/^\d{4}$/.test(value)) {
    return value
  }
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) {
    return '1400'
  }
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}${mm}`
}

const buildShipper = (pickup) => ({
  OriginArea: requireField(pickup.originArea, 'pickup.originArea'),
  CustomerCode: digitString(pickup.customerCode, 'pickup.customerCode'),
  CustomerName: requireField(pickup.name, 'pickup.name'),
  CustomerAddress1: requireField(pickup.address1, 'pickup.address1'),
  CustomerAddress2: str(pickup.address2),
  CustomerAddress3: str(pickup.address3),
  CustomerPincode: digitString(pickup.pincode, 'pickup.pincode'),
  CustomerMobile: mobile(pickup.mobile),
  CustomerTelephone: str(pickup.telephone),
  CustomerEmailID: str(pickup.email),
  CustomerGSTNumber: str(pickup.gstNumber),
  CustomerLatitude: str(pickup.latitude),
  CustomerLongitude: str(pickup.longitude),
  CustomerMaskedContactNumber: str(pickup.maskedContactNumber),
  IsToPayCustomer: Boolean(pickup.isToPayCustomer),
  Sender: str(pickup.sender || pickup.name),
  VendorCode: str(pickup.vendorCode),
})

const buildConsignee = (drop) => ({
  ConsigneeName: requireField(drop.name, 'drop.name'),
  ConsigneeAddress1: requireField(drop.address1, 'drop.address1'),
  ConsigneeAddress2: str(drop.address2),
  ConsigneeAddress3: str(drop.address3),
  ConsigneePincode: digitString(drop.pincode, 'drop.pincode'),
  ConsigneeMobile: mobile(drop.mobile),
  ConsigneeTelephone: str(drop.telephone),
  ConsigneeEmailID: str(drop.email),
  // "R" (residential) / "C" (commercial); Blue Dart uses it for routing.
  ConsigneeAddressType: str(drop.addressType),
  ConsigneeAttention: str(drop.attention || drop.name),
  ConsigneeGSTNumber: str(drop.gstNumber),
  ConsigneeLatitude: str(drop.latitude),
  ConsigneeLongitude: str(drop.longitude),
  ConsigneeMaskedContactNumber: str(drop.maskedContactNumber),
})

// Return (RTO) address block. Blue Dart requires it on the waybill request; it
// defaults to the consignee so an undelivered shipment comes back to us.
const buildReturnAddress = (returnAddress, drop) => {
  const source = returnAddress || drop
  return {
    ManifestNumber: str(source.manifestNumber),
    ReturnAddress1: requireField(source.address1, 'return.address1'),
    ReturnAddress2: str(source.address2),
    ReturnAddress3: str(source.address3),
    ReturnContact: str(source.contact || source.name),
    ReturnEmailID: str(source.email),
    ReturnLatitude: str(source.latitude),
    ReturnLongitude: str(source.longitude),
    ReturnMaskedContactNumber: str(source.maskedContactNumber),
    ReturnMobile: mobile(source.mobile),
    ReturnPincode: digitString(source.pincode, 'return.pincode'),
    ReturnTelephone: str(source.telephone),
  }
}

const buildServices = (service) => {
  const out = {
    AWBNo: str(service.awbNo),
    // Weight and piece count are strings in the API reference ("0.50", "1").
    ActualWeight: Number(service.actualWeight || 0.5).toFixed(2),
    CollectableAmount: Number(service.collectableAmount || 0),
    Commodity: service.commodity || {},
    CreditReferenceNo: creditReference(service.creditReferenceNo),
    DeclaredValue: Number(service.declaredValue || 0),
    Dimensions: Array.isArray(service.dimensions) ? service.dimensions : [],
    ECCN: str(service.eccn),
    // false keeps AWBPrintContent populated, which is the shipping label.
    PDFOutputNotRequired: Boolean(service.pdfOutputNotRequired),
    PackType: str(service.packType),
    PickupDate: formatBlueDartDate(service.pickupDate || new Date()),
    PickupTime: formatBlueDartTime(service.pickupTime || '1400'),
    PieceCount: String(Number(service.pieceCount || 1)),
    ProductCode: requireField(service.productCode, 'service.productCode'),
    ProductType: productType(service.productType),
    RegisterPickup: service.registerPickup !== false,
    SpecialInstruction: str(service.specialInstruction),
    SubProductCode: str(service.subProductCode),
    OTPBasedDelivery: Number(service.otpBasedDelivery || 0),
    OTPCode: str(service.otpCode),
    itemdtl: Array.isArray(service.itemDetails) ? service.itemDetails : [],
    noOfDCGiven: Number(service.noOfDCGiven || 0),
  }
  // Only sent when explicitly requested: the GREST Blue Dart account is
  // provisioned without RVP, so the flag stays off unless configured otherwise.
  if (service.isReversePickup) {
    out.IsReversePickup = true
  }
  return out
}

/**
 * Assemble a Blue Dart WayBillGenerationRequest from explicit pickup (Shipper),
 * drop (Consignee), return-address and service inputs.
 */
export const buildWaybillRequest = ({
  pickup,
  drop,
  service,
  returnAddress,
} = {}) => {
  if (!pickup || !drop || !service) {
    throw new BlueDartMappingError(
      'Blue Dart waybill requires pickup, drop and service',
    )
  }
  return {
    Consignee: buildConsignee(drop),
    Returnadds: buildReturnAddress(returnAddress, drop),
    Services: buildServices(service),
    Shipper: buildShipper(pickup),
  }
}

/**
 * Derive waybill inputs from a GREST lead: pickup from the store, delivery to
 * the company warehouse. Addresses are provided by the caller/config because
 * the store pincode is not modelled on the store document.
 */
export const mapLeadToWaybillRequest = (
  lead,
  { pickupOverride, warehouse, service, returnAddress } = {},
) => {
  if (!lead) {
    throw new BlueDartMappingError('Blue Dart waybill: lead is required')
  }
  const store = lead.storeId && typeof lead.storeId === 'object' ? lead.storeId : {}

  const pickup = pickupOverride || {
    originArea: store.region || service?.originArea,
    customerCode: service?.customerCode,
    name: store.storeName || 'GREST Store',
    address1: store.address || '',
    pincode: store.pincode,
    mobile: store.contactNumber || '',
    email: store.email || '',
  }

  const drop = warehouse || {
    name: 'GREST Warehouse',
    address1: '',
    pincode: '',
  }

  return buildWaybillRequest({
    pickup,
    drop,
    returnAddress,
    service: {
      ...service,
      creditReferenceNo: toCreditReference(
        service?.creditReferenceNo || lead.uniqueCode || String(lead._id),
      ),
      declaredValue: service?.declaredValue ?? lead.payoutAmount ?? lead.price ?? 0,
    },
  })
}

/* ========================================================================== */
/* 2. CLIENT */
/* ========================================================================== */


// Blue Dart courier client (Apigee gateway).
//
// Auth is a two-step flow, per the Blue Dart "JWT Token Generation Process"
// guide:
//   1. GET  {BASE}/token/v1/login  with headers ClientID + clientSecret
//      (the App's API Key / API Secret from developer.dhl.com) -> { JWTToken }
//   2. Send that token as the `JWTToken` header on every subsequent API call,
//      alongside the account Profile (LoginID + LicenceKey + Api_type) in the
//      request body.
//
// Base URLs (from the Blue Dart developer portal):
//   Sandbox: https://apigateway-sandbox.bluedart.com/in/transportation
//   Prod:    https://apigateway.bluedart.com/in/transportation
//
// Tracking still uses the documented public routing servlet, which is a
// separate, non-Apigee endpoint and needs no JWT.

export class BlueDartError extends Error {}
export class BlueDartConfigurationError extends BlueDartError {}

const DEFAULT_TRACKING_PATH = 'tracking/v1/shipment'
const DEFAULT_TOKEN_PATH = 'token/v1/login'
const DEFAULT_WAYBILL_PATH = 'waybill/v1/GenerateWayBill'
const DEFAULT_CANCEL_WAYBILL_PATH = 'waybill/v1/CancelWaybill'
const DEFAULT_REGISTER_PICKUP_PATH = 'pickup/v1/RegisterPickup'
const DEFAULT_CANCEL_PICKUP_PATH = 'pickup/v1/CancelPickup'
const DEFAULT_PINCODE_FINDER_PATH = 'finder/v1/GetServicesforPincode'

// Refresh slightly before the token actually expires so an in-flight request
// never races the expiry.
const TOKEN_EXPIRY_SKEW_MS = 60_000

const env = (key) => {
  const value = process.env[key]
  return value === undefined ? '' : String(value).trim()
}

const timeoutMs = () => Number(process.env.BLUEDART_TIMEOUT_MS || 30000)

const joinUrl = (base, path) =>
  `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`

// The account Profile sent in every transaction body. Field names follow the
// Blue Dart sample exactly: "LicenceKey" (British spelling) and "Api_type".
// OriginArea and CustomerCode belong to the Shipper block, not here.
export const blueDartProfile = () => ({
  LoginID: env('BLUEDART_LOGIN_ID'),
  LicenceKey: env('BLUEDART_LICENSE_KEY'),
  Api_type: env('BLUEDART_API_TYPE') || 'S',
})

export const blueDartConfigurationStatus = () => {
  const hasProfile = Boolean(env('BLUEDART_LOGIN_ID') && env('BLUEDART_LICENSE_KEY'))
  const hasAuth = Boolean(
    env('BLUEDART_JWT_TOKEN') ||
      (env('BLUEDART_CLIENT_ID') && env('BLUEDART_CLIENT_SECRET')),
  )
  return {
    provider: 'BLUEDART',
    // Ready to create shipments only once the gateway, the App credentials and
    // the account profile are all present.
    configured: Boolean(env('BLUEDART_BASE_URL') && hasProfile && hasAuth),
    trackingConfigured: hasProfile,
  }
}

/* --------------------------------- AUTH --------------------------------- */

let cachedToken = ''
let cachedTokenExpiresAt = 0

// Read `exp` out of the JWT payload so the cache follows the token's real
// lifetime instead of a guessed TTL. Falls back to BLUEDART_TOKEN_TTL_SECONDS
// when the token is opaque or malformed.
const tokenExpiryMs = (token) => {
  const fallback =
    Date.now() + Number(process.env.BLUEDART_TOKEN_TTL_SECONDS || 1800) * 1000
  const payload = String(token).split('.')[1]
  if (!payload) {
    return fallback
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(
        payload.replace(/-/g, '+').replace(/_/g, '/'),
        'base64',
      ).toString('utf8'),
    )
    if (!decoded?.exp) {
      return fallback
    }
    return Number(decoded.exp) * 1000
  } catch {
    return fallback
  }
}

export const resetBlueDartTokenCache = () => {
  cachedToken = ''
  cachedTokenExpiresAt = 0
}

/**
 * Return a usable JWT, fetching a new one from the Blue Dart token API when the
 * cached one is missing or close to expiry. A statically supplied
 * BLUEDART_JWT_TOKEN always wins, which is what the manual portal-generated
 * token is for.
 */
export const getJwtToken = async () => {
  const staticToken = env('BLUEDART_JWT_TOKEN')
  if (staticToken) {
    return staticToken
  }

  if (cachedToken && Date.now() < cachedTokenExpiresAt - TOKEN_EXPIRY_SKEW_MS) {
    return cachedToken
  }

  const base = env('BLUEDART_BASE_URL')
  const clientId = env('BLUEDART_CLIENT_ID')
  const clientSecret = env('BLUEDART_CLIENT_SECRET')
  if (!base || !clientId || !clientSecret) {
    throw new BlueDartConfigurationError(
      'Blue Dart authentication is not configured (set BLUEDART_BASE_URL, BLUEDART_CLIENT_ID and BLUEDART_CLIENT_SECRET, or supply BLUEDART_JWT_TOKEN)',
    )
  }

  const url = joinUrl(base, env('BLUEDART_TOKEN_PATH') || DEFAULT_TOKEN_PATH)
  let response
  try {
    response = await axios.get(url, {
      timeout: timeoutMs(),
      headers: {
        accept: JSON_CONTENT_TYPE,
        ClientID: clientId,
        clientSecret,
      },
    })
  } catch (error) {
    // The axios error carries config.headers, which holds the client secret,
    // and safeLog only masks PII keys - so log the status alone, never the
    // error object or the response body.
    safeLog.error(
      `Blue Dart token request failed with status ${error.response?.status || 'unknown'}`,
    )
    throw new BlueDartError(
      `Blue Dart token request failed with status ${error.response?.status || 'unknown'}`,
    )
  }

  const token = response.data?.JWTToken || response.data?.jwtToken
  if (!token) {
    throw new BlueDartError('Blue Dart token response did not contain a JWTToken')
  }
  cachedToken = String(token)
  cachedTokenExpiresAt = tokenExpiryMs(cachedToken)
  return cachedToken
}

/* ------------------------------ TRANSACTIONS ------------------------------ */

// The waybill APIs take { Request, Profile }; the pickup APIs only accept the
// lowercase { request, profile } envelope and answer HTTP 500 otherwise.
const postTransaction = async (
  pathEnvKey,
  defaultPath,
  request,
  label,
  { lowercaseEnvelope = false } = {},
) => {
  const base = env('BLUEDART_BASE_URL')
  if (!base) {
    throw new BlueDartConfigurationError(
      `Blue Dart ${label} endpoint is not configured (set BLUEDART_BASE_URL)`,
    )
  }
  const url = joinUrl(base, env(pathEnvKey) || defaultPath)
  const token = await getJwtToken()
  try {
    const response = await axios.post(
      url,
      lowercaseEnvelope
        ? { request, profile: blueDartProfile() }
        : { Request: request, Profile: blueDartProfile() },
      {
        timeout: timeoutMs(),
        headers: {
          'Content-Type': JSON_CONTENT_TYPE,
          JWTToken: token,
        },
      },
    )
    return response.data
  } catch (error) {
    // Validation failures come back as HTTP 400 with an "error-response" array
    // rather than a 200 + <Operation>Result, so the useful StatusInformation is
    // only reachable from the thrown error.
    const detail = errorResponseMessage(error.response?.data)
    if (detail) {
      throw new BlueDartError(`Blue Dart ${label} rejected: ${detail}`)
    }
    throw error
  }
}

// Pull "StatusCode: StatusInformation" out of the HTTP-error envelope
// { status, title, "error-response": [ { IsError, Status: [...] } ] }.
const errorResponseMessage = (data) => {
  const entries = data?.['error-response'] || data?.errorResponse
  const first = Array.isArray(entries) ? entries[0] : entries
  if (!first) {
    return ''
  }
  // Gateway errors arrive as a bare string ("License Mismatch"), as { msg }, or
  // as a flat { StatusCode, StatusInformation } entry.
  if (typeof first === 'string') {
    return first
  }
  const flat = [first.StatusCode, first.StatusInformation].filter(Boolean).join(': ')
  return statusMessage(first) || flat || String(first.ErrorMessage || first.msg || '')
}

const readField = (data, ...names) => {
  for (const name of names) {
    if (data && data[name] !== undefined && data[name] !== null) {
      return data[name]
    }
  }
  return undefined
}

// Blue Dart wraps each operation's payload in a "<Operation>Result" object and
// reports failures inside the body with HTTP 200, so the result has to be
// unwrapped and inspected rather than relying on the HTTP status.
const unwrapResult = (data, ...resultKeys) => {
  for (const key of resultKeys) {
    if (data && typeof data[key] === 'object' && data[key] !== null) {
      return data[key]
    }
  }
  return data || {}
}

// Status is an array of { StatusCode, StatusInformation } entries. Blue Dart
// uses it for both hard errors and advisory notes, so it is only read for the
// message once IsError has already flagged a failure.
const statusMessage = (result) => {
  const status = result?.Status
  if (!Array.isArray(status)) {
    return ''
  }
  return status
    .map((entry) =>
      [
        readField(entry, 'StatusCode', 'statusCode'),
        readField(entry, 'StatusInformation', 'statusInformation'),
      ]
        .filter((part) => part !== undefined && part !== '')
        .join(': '),
    )
    .filter(Boolean)
    .join('; ')
}

const assertNoError = (result, label) => {
  const isError = Boolean(readField(result, 'IsError', 'isError'))
  if (!isError) {
    return
  }
  const message =
    statusMessage(result) ||
    readField(result, 'ErrorMessage', 'errorMessage') ||
    `Blue Dart returned an error for ${label}`
  throw new BlueDartError(String(message))
}

/**
 * Generate a waybill (AWB) and, unless suppressed via PDFOutputNotRequired, the
 * shipping label. Returns the AWB number and the label content
 * (AWBPrintContent) from the GenerateWayBillResult payload.
 */
export const generateWaybill = async (request) => {
  const data = await postTransaction(
    'BLUEDART_WAYBILL_PATH',
    DEFAULT_WAYBILL_PATH,
    request,
    'waybill',
  )
  const result = unwrapResult(data, 'GenerateWayBillResult', 'generateWayBillResult')
  assertNoError(result, 'waybill generation')
  // A waybill can succeed while its pickup registration fails; surface that
  // instead of silently reporting a fully booked shipment.
  const pickupFailed = Boolean(readField(result, 'IsErrorInPU', 'isErrorInPU'))
  return {
    awbNo: readField(result, 'AWBNo', 'awbNo', 'WaybillNo'),
    labelContent: readField(result, 'AWBPrintContent', 'awbPrintContent'),
    tokenNumber: readField(result, 'TokenNumber', 'tokenNumber'),
    destinationArea: readField(result, 'DestinationArea', 'destinationArea'),
    destinationLocation: readField(result, 'DestinationLocation', 'destinationLocation'),
    shipmentPickupDate: readField(result, 'ShipmentPickupDate', 'shipmentPickupDate'),
    pickupRegistrationFailed: pickupFailed,
    pickupRegistrationError: pickupFailed ? statusMessage(result) : '',
    raw: data,
  }
}

export const cancelWaybill = async (request) => {
  const data = await postTransaction(
    'BLUEDART_CANCEL_WAYBILL_PATH',
    DEFAULT_CANCEL_WAYBILL_PATH,
    request,
    'cancel-waybill',
  )
  const result = unwrapResult(data, 'CancelWaybillResult', 'cancelWaybillResult')
  assertNoError(result, 'waybill cancellation')
  return result
}

export const registerPickup = async (request) => {
  const data = await postTransaction(
    'BLUEDART_REGISTER_PICKUP_PATH',
    DEFAULT_REGISTER_PICKUP_PATH,
    request,
    'register-pickup',
    { lowercaseEnvelope: true },
  )
  const result = unwrapResult(data, 'RegisterPickupResult', 'registerPickupResult')
  assertNoError(result, 'pickup registration')
  return result
}

export const cancelPickup = async (request) => {
  const data = await postTransaction(
    'BLUEDART_CANCEL_PICKUP_PATH',
    DEFAULT_CANCEL_PICKUP_PATH,
    request,
    'cancel-pickup',
    { lowercaseEnvelope: true },
  )
  const result = unwrapResult(data, 'CancelPickupResult', 'cancelPickupResult')
  assertNoError(result, 'pickup cancellation')
  return result
}

/**
 * Track one or more shipments through the Apigee tracking service. Unlike the
 * other operations this is a GET carrying the legacy servlet query string, but
 * it is still gated by the JWT. Returns the raw XML response.
 *
 * `scan` selects the level of detail: 1 returns the full scan history, 0 the
 * current status only.
 */
/**
 * Serviceability of a pincode: its Bluedart area code, city/state, which
 * products pick up (Outbound) or deliver (Inbound) there, value limits and
 * holidays. The body is { pinCode, profile } (no Request wrapper); an unknown
 * pincode comes back as HTTP 400 with ErrorMessage "InvalidPinCode".
 */
export const getServicesForPincode = async (pinCode) => {
  const base = env('BLUEDART_BASE_URL')
  if (!base) {
    throw new BlueDartConfigurationError(
      'Blue Dart pincode finder is not configured (set BLUEDART_BASE_URL)',
    )
  }
  const url = joinUrl(
    base,
    env('BLUEDART_PINCODE_FINDER_PATH') || DEFAULT_PINCODE_FINDER_PATH,
  )
  const token = await getJwtToken()
  let data
  try {
    const response = await axios.post(
      url,
      { pinCode: String(pinCode), profile: blueDartProfile() },
      {
        timeout: timeoutMs(),
        headers: { 'Content-Type': JSON_CONTENT_TYPE, JWTToken: token },
      },
    )
    data = response.data
  } catch (error) {
    const detail = errorResponseMessage(error.response?.data)
    if (detail) {
      throw new BlueDartError(`Blue Dart pincode check rejected: ${detail}`)
    }
    throw error
  }
  const result = unwrapResult(data, 'GetServicesforPincodeResult')
  assertNoError(result, 'pincode check')
  return result
}

export const trackShipment = async (awbNumbers, { scan = 1 } = {}) => {
  const base = env('BLUEDART_BASE_URL')
  const login = env('BLUEDART_LOGIN_ID')
  // Blue Dart rejects the shipping licence key here with "License Mismatch";
  // tracking is issued its own key, so prefer it when configured.
  const licenseKey =
    env('BLUEDART_TRACKING_LICENSE_KEY') || env('BLUEDART_LICENSE_KEY')
  if (!base || !login || !licenseKey) {
    throw new BlueDartConfigurationError(
      'Blue Dart tracking needs BLUEDART_BASE_URL, BLUEDART_LOGIN_ID and BLUEDART_LICENSE_KEY',
    )
  }
  const numbers = Array.isArray(awbNumbers) ? awbNumbers.join(',') : String(awbNumbers)
  const url = joinUrl(base, env('BLUEDART_TRACKING_PATH') || DEFAULT_TRACKING_PATH)
  const token = await getJwtToken()
  try {
    const response = await axios.get(url, {
      timeout: timeoutMs(),
      headers: { JWTToken: token },
      params: {
        handler: 'tnt',
        action: 'custawbquery',
        loginid: login,
        // Declares that `numbers` holds waybill numbers.
        awb: 'awb',
        lickey: licenseKey,
        numbers,
        format: 'xml',
        verno: '1',
        scan,
      },
    })
    return response.data
  } catch (error) {
    // The request params carry lickey, so log the message only - not the error
    // object, whose config would expose the licence key.
    const detail = errorResponseMessage(error.response?.data) || error.message
    safeLog.error(`Blue Dart tracking request failed: ${detail}`)
    throw new BlueDartError(`Blue Dart tracking failed: ${detail}`)
  }
}

/* ========================================================================== */
/* 3. TRACKING */
/* ========================================================================== */

// Minimal reader for the Blue Dart tracking servlet's XML response.
//
// The project has no XML parser dependency and adding one needs approval, so
// this extracts only the handful of fields the warehouse view needs, tolerating
// both the attribute form (<Shipment WaybillNo="..">) and the element form
// (<WaybillNo>..</WaybillNo>) that the servlet uses across versions.
//
// The raw status text is stored verbatim. Blue Dart's scan/status code
// vocabulary has not been supplied, so no mapping onto GREST delivery statuses
// is attempted here.

const decodeEntities = (value) =>
  String(value)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .trim()

const readTag = (xml, tag) => {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
  return match ? decodeEntities(match[1]) : ''
}

const readAttribute = (xml, name) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(xml)
  return match ? decodeEntities(match[1]) : ''
}

const readValue = (xml, name) => readTag(xml, name) || readAttribute(xml, name)

/**
 * Parse a tracking response into one entry per shipment.
 * @param {string} xml - Raw servlet response
 * @returns {Array<{awbNo: string, status: string, statusType: string,
 *   statusDate: string, statusTime: string, expectedDeliveryDate: string,
 *   error: string}>}
 */
export const parseTrackingResponse = (xml) => {
  const body = String(xml || '')
  const blocks = body.match(/<Shipment\b[\s\S]*?<\/Shipment>/gi)
  if (!blocks) {
    // The servlet reports lookup failures as a bare <Error> document.
    const error = readTag(body, 'Error') || readTag(body, 'error')
    return error ? [{ awbNo: '', status: '', error }] : []
  }
  return blocks.map((block) => ({
    awbNo: readValue(block, 'WaybillNo') || readValue(block, 'AWBNo'),
    status: readValue(block, 'Status'),
    statusType: readValue(block, 'StatusType'),
    statusDate: readValue(block, 'StatusDate'),
    statusTime: readValue(block, 'StatusTime'),
    expectedDeliveryDate: readValue(block, 'ExpectedDeliveryDate'),
    error: readValue(block, 'StatusCode') === 'NF' ? 'Waybill not found' : '',
  }))
}

/* ========================================================================== */
/* 4. COURIER ADAPTER */
/* ========================================================================== */


// Adapts the generic courier payload (produced by warehouseService) into a Blue
// Dart waybill: Shipper = the pickup store, Consignee = the company warehouse.
// The store's pincode is not modelled, so the origin pincode and the warehouse
// address come from configuration (single-warehouse default; revisit when
// multi-warehouse addresses are modelled).
//
// The GREST Blue Dart account is provisioned B2B/B2C without RVP, so this books
// a forward shipment with a registered pickup rather than a reverse pickup.
// BLUEDART_IS_REVERSE_PICKUP can flip that once RVP is enabled on the account.

const envOr = (key, fallback = '') => (process.env[key] || fallback).trim()

const flag = (key) => ['true', '1', 'yes'].includes(envOr(key).toLowerCase())

export const buildOrderRequestFromCourierPayload = (payload = {}) => {
  const pickup = payload.pickup || {}
  const device = payload.device || {}

  const warehouse = {
    name: envOr('BLUEDART_WAREHOUSE_NAME', 'GREST Warehouse'),
    address1: envOr('BLUEDART_WAREHOUSE_ADDR1'),
    address2: envOr('BLUEDART_WAREHOUSE_ADDR2'),
    address3: envOr('BLUEDART_WAREHOUSE_ADDR3'),
    pincode: envOr('BLUEDART_WAREHOUSE_PIN'),
    mobile: envOr('BLUEDART_WAREHOUSE_MOBILE'),
    email: envOr('BLUEDART_WAREHOUSE_EMAIL'),
    gstNumber: envOr('BLUEDART_WAREHOUSE_GST'),
    addressType: envOr('BLUEDART_WAREHOUSE_ADDRESS_TYPE', 'C'),
  }

  return buildWaybillRequest({
    pickup: {
      originArea: envOr('BLUEDART_ORIGIN_AREA'),
      customerCode: envOr('BLUEDART_CUSTOMER_CODE'),
      name: pickup.name || 'GREST Store',
      address1: pickup.address || '',
      pincode: envOr('BLUEDART_ORIGIN_PINCODE', '122003'),
      mobile: pickup.phone || '',
      gstNumber: envOr('BLUEDART_SHIPPER_GST'),
    },
    drop: warehouse,
    // Undelivered shipments return to the same warehouse they were bound for.
    returnAddress: warehouse,
    service: {
      productCode: envOr('BLUEDART_PRODUCT_CODE', 'A'),
      productType: envOr('BLUEDART_PRODUCT_TYPE'),
      subProductCode: envOr('BLUEDART_SUB_PRODUCT_CODE'),
      declaredValue: Number(device.amount || 0),
      actualWeight: Number(envOr('BLUEDART_DEFAULT_WEIGHT', '0.5')),
      // Blue Dart caps this at 20 chars; a lead uniqueCode or ObjectId is longer.
      creditReferenceNo: toCreditReference(
        payload.referenceId || `GREST${Date.now()}`,
      ),
      isReversePickup: flag('BLUEDART_IS_REVERSE_PICKUP'),
      registerPickup: true,
    },
  })
}

/**
 * Create a Blue Dart shipment for a warehouse lead. Returns the same shape as
 * the generic courier adapter (orderId + providerStatus) plus the label content
 * and pickup-registration outcome, so it can slot into the existing courier seam.
 */
export const createBlueDartOrder = async (payload) => {
  const request = buildOrderRequestFromCourierPayload(payload)
  const result = await generateWaybill(request)
  return {
    orderId: result.awbNo,
    // A waybill can be issued while its pickup registration fails; the caller
    // records that so Operations can chase the pickup separately.
    providerStatus: result.pickupRegistrationFailed ? 'PICKUP_FAILED' : 'CREATED',
    providerError: result.pickupRegistrationError || '',
    labelContent: result.labelContent,
    shipmentPickupDate: result.shipmentPickupDate,
  }
}
