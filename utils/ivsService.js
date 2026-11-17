import axios from 'axios'
import { safeLog } from '../utils/piiMasking.js'
import crypto from 'crypto'

const IVS_STATUS = Object.freeze({
  CLEAN: 'CLEAN',
  BLOCKED: 'BLOCKED',
  STOLEN: 'STOLEN',
  UNKNOWN: 'UNKNOWN',
  ERROR: 'ERROR',
})

const IVS_STATUS_LABELS = Object.freeze({
  [IVS_STATUS.CLEAN]: 'Clean / Valid',
  [IVS_STATUS.BLOCKED]: 'Blocked',
  [IVS_STATUS.STOLEN]: 'Stolen',
  [IVS_STATUS.UNKNOWN]: 'Unknown / No Record',
  [IVS_STATUS.ERROR]: 'IVS Unavailable',
})

const MAX_RETRIES = 2
const REQUEST_TIMEOUT = 10000
const CONTENT_TYPE_JSON = 'application/json'

let cachedAccessToken = null
let cachedRefreshToken = null
let tokenExpiresAt = null

function buildConfig() {
  const baseUrl = process.env.CDOT_IVS_BASE_URL
  if (!baseUrl) {
    throw new Error('CDOT_IVS_BASE_URL environment variable is required')
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    username: process.env.CDOT_IVS_USERNAME || '',
    password: process.env.CDOT_IVS_PASSWORD || '',
  }
}

function generateReferenceId() {
  return `IVS-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
}

function isTokenExpired() {
  if (!tokenExpiresAt) {
    return true
  }
  return Date.now() >= tokenExpiresAt - 60000
}

function decodeJwtPayload(token) {
  try {
    const base64url = token.split('.')[1]
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
    const padded =
      base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'))
  } catch {
    return {}
  }
}

async function login(config) {
  safeLog.info('[IVS] Authenticating with C-DOT API')

  const response = await axios.post(
    `${config.baseUrl}/login`,
    { username: config.username, password: config.password },
    {
      timeout: REQUEST_TIMEOUT,
      headers: { 'Content-Type': CONTENT_TYPE_JSON },
    },
  )

  const { accessToken, refreshToken } = response.data
  if (!accessToken) {
    throw new Error('Login response missing accessToken')
  }

  cachedAccessToken = accessToken
  cachedRefreshToken = refreshToken || null

  const payload = decodeJwtPayload(accessToken)
  tokenExpiresAt = (payload.exp || 0) * 1000

  safeLog.info('[IVS] Authentication successful', {
    expiresAt: new Date(tokenExpiresAt).toISOString(),
    hasRefreshToken: !!cachedRefreshToken,
  })

  return accessToken
}

async function refreshAccessToken(config) {
  if (!cachedRefreshToken) {
    safeLog.warn('[IVS] No refresh token available, re-logging in')
    return login(config)
  }

  safeLog.info('[IVS] Refreshing access token')
  const response = await axios.post(
    `${config.baseUrl}/refresh`,
    { refreshToken: cachedRefreshToken },
    { timeout: REQUEST_TIMEOUT, headers: { 'Content-Type': CONTENT_TYPE_JSON } },
  )

  const { accessToken } = response.data
  if (!accessToken) {
    throw new Error('Refresh response missing accessToken')
  }

  cachedAccessToken = accessToken
  const payload = decodeJwtPayload(accessToken)
  tokenExpiresAt = (payload.exp || 0) * 1000

  safeLog.info('[IVS] Token refreshed', { expiresAt: new Date(tokenExpiresAt).toISOString() })
  return accessToken
}

async function getValidAccessToken(config) {
  if (cachedAccessToken && !isTokenExpired()) {
    return cachedAccessToken
  }

  if (cachedRefreshToken) {
    try {
      return await refreshAccessToken(config)
    } catch (error) {
      safeLog.warn('[IVS] Token refresh failed, re-logging in', { error: error.message })
    }
  }

  return login(config)
}

function mapCdotStatus(cdotStatus) {
  if (!cdotStatus) {
    return IVS_STATUS.UNKNOWN
  }
  const normalized = cdotStatus.toLowerCase().trim()
  if (normalized === 'non-blocked') {
    return IVS_STATUS.CLEAN
  }
  if (normalized === 'blocked') {
    return IVS_STATUS.BLOCKED
  }
  if (normalized === 'stolen') {
    return IVS_STATUS.STOLEN
  }
  if (normalized === 'invalid') {
    return IVS_STATUS.UNKNOWN
  }
  return IVS_STATUS.UNKNOWN
}

async function checkSingleImei(imei, accessToken, config) {
  const requestPayload = { imeis: [imei] }
  console.log('[IVS_DEBUG] Sending to C-DOT API:', JSON.stringify(requestPayload, null, 2))

  const response = await axios.post(
    `${config.baseUrl}/imei-status`,
    requestPayload,
    {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'Content-Type': CONTENT_TYPE_JSON,
        Authorization: `Bearer ${accessToken}`,
      },
    },
  )

  const result = response.data
  console.log('[IVS_DEBUG] C-DOT API response:', JSON.stringify(result, null, 2))
  if (!result || typeof result !== 'object') {
    return { status: IVS_STATUS.ERROR, rawResponse: result, details: null }
  }

  const imeiData = result[imei]
  if (!imeiData) {
    return { status: IVS_STATUS.UNKNOWN, rawResponse: result, details: null }
  }

  return {
    status: mapCdotStatus(imeiData.status),
    rawCdotStatus: imeiData.status || null,
    rawResponse: result,
    details: imeiData,
  }
}

function isRetryableError(error) {
  if (!error.response) {
    return true
  }
  const status = error.response.status
  return status >= 500 || status === 429
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function checkImeiWithRetry(imei, accessToken, config, referenceId) {
  let currentToken = accessToken
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        await delay(Math.min(1000 * Math.pow(2, attempt), 5000))
        if (attempt === 1 && isTokenExpired()) {
          currentToken = await getValidAccessToken(config)
        }
      }
      return await checkSingleImei(imei, currentToken, config)
    } catch (error) {
      safeLog.warn(`[IVS] IMEI check attempt ${attempt + 1} failed`, {
        referenceId, imei, error: error.message, status: error.response?.status,
      })
      if (error.response?.status === 401) {
        currentToken = await getValidAccessToken(config)
        continue
      }
      if (!isRetryableError(error)) {
        break
      }
    }
  }
  return null
}

function buildErrorResponse(imei1Status, imei2, imei2Result, message, referenceId) {
  return {
    imei1Status,
    imei2Status: imei2 ? (imei2Result?.status || imei1Status) : null,
    allowTransaction: false,
    verifiedAt: new Date().toISOString(),
    referenceId,
    message,
    rawResponse: null,
  }
}

function buildMessage(imei1Result, imei2Result, imei2) {
  const isClean =
    imei1Result.status === IVS_STATUS.CLEAN &&
    (!imei2 || imei2Result?.status === IVS_STATUS.CLEAN)

  if (isClean) {
    return 'Device IMEI is clean. Transaction can proceed.'
  }
  if (imei1Result.status === IVS_STATUS.BLOCKED) {
    return 'Device IMEI 1 is blocked by CEIR. This device cannot be purchased.'
  }
  if (imei1Result.status === IVS_STATUS.STOLEN) {
    return 'Device IMEI 1 is reported as stolen. This device cannot be purchased.'
  }
  if (imei1Result.status === IVS_STATUS.UNKNOWN) {
    return 'IMEI not found in CEIR database. Supervisor approval required.'
  }
  return 'Unable to verify IMEI status. Please try again or use supervisor override.'
}

export async function verifyImeiWithIvs({ imei1, imei2, deviceModel }) {
  const referenceId = generateReferenceId()
  const config = buildConfig()

  safeLog.info('[IVS] Starting verification', { referenceId })

  if (!config.username || !config.password) {
    safeLog.warn('[IVS] C-DOT credentials not configured')
    return buildErrorResponse(IVS_STATUS.UNKNOWN, imei2, null, 'IVS not configured. Contact system administrator.', referenceId)
  }

  let accessToken
  try {
    accessToken = await getValidAccessToken(config)
  } catch (authError) {
    safeLog.error('[IVS] Authentication failed', { referenceId, error: authError.message })
    return buildErrorResponse(IVS_STATUS.ERROR, imei2, null, 'IMEI verification service authentication failed. Use supervisor override to proceed.', referenceId)
  }

  const [imei1Result, imei2Result] = await Promise.all([
    checkImeiWithRetry(imei1, accessToken, config, referenceId),
    imei2 ? checkImeiWithRetry(imei2, accessToken, config, referenceId) : Promise.resolve(null),
  ])

  if (!imei1Result) {
    return buildErrorResponse(IVS_STATUS.ERROR, imei2, imei2Result, 'IMEI verification service unavailable. Please try again later or use supervisor override.', referenceId)
  }

  return {
    imei1Status: imei1Result.status,
    imei1CdotStatus: imei1Result.rawCdotStatus,
    imei2Status: imei2Result ? imei2Result.status : null,
    imei2CdotStatus: imei2Result ? imei2Result.rawCdotStatus : null,
    allowTransaction:
      imei1Result.status === IVS_STATUS.CLEAN &&
      (!imei2 || imei2Result?.status === IVS_STATUS.CLEAN),
    verifiedAt: new Date().toISOString(),
    referenceId,
    message: buildMessage(imei1Result, imei2Result, imei2),
    rawResponse: {
      imei1: imei1Result.rawResponse,
      imei2: imei2Result?.rawResponse || null,
    },
  }
}

export { IVS_STATUS, IVS_STATUS_LABELS, MAX_RETRIES, REQUEST_TIMEOUT }
