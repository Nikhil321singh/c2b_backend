import axios from 'axios'
import { safeLog } from '../../utils/piiMasking.js'

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
        accept: 'application/json',
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

const postTransaction = async (pathEnvKey, defaultPath, request, label) => {
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
      { Request: request, Profile: blueDartProfile() },
      {
        timeout: timeoutMs(),
        headers: {
          'Content-Type': 'application/json',
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
  return statusMessage(first) || String(first.ErrorMessage || '')
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
    safeLog.error(`Blue Dart tracking request failed: ${error.message}`)
    throw new BlueDartError(`Blue Dart tracking failed: ${error.message}`)
  }
}
