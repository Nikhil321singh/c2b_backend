import axios from 'axios'
import {
  blueDartConfigurationStatus,
  trackShipment,
} from '../bluedart/blueDartClient.js'
import { parseTrackingResponse } from '../bluedart/blueDartTracking.js'
import { createBlueDartOrder } from '../bluedart/blueDartCourierAdapter.js'

export class CourierConfigurationError extends Error {}

const isBlueDartProvider = () =>
  (process.env.COURIER_PROVIDER || '').toUpperCase() === 'BLUEDART'

let cachedBearerToken = ''
let cachedBearerTokenExpiresAt = 0

const getBearerToken = async () => {
  if (process.env.COURIER_API_TOKEN) {
    return process.env.COURIER_API_TOKEN
  }
  if (
    !process.env.COURIER_AUTH_URL ||
    !process.env.COURIER_CLIENT_ID ||
    !process.env.COURIER_CLIENT_SECRET
  ) {
    throw new CourierConfigurationError(
      'Courier authentication is not configured',
    )
  }
  if (cachedBearerToken && Date.now() < cachedBearerTokenExpiresAt) {
    return cachedBearerToken
  }
  const response = await axios.post(
    process.env.COURIER_AUTH_URL,
    {
      clientId: process.env.COURIER_CLIENT_ID,
      clientSecret: process.env.COURIER_CLIENT_SECRET,
    },
    { timeout: Number(process.env.COURIER_TIMEOUT_MS || 15000) },
  )
  const token = response.data?.access_token || response.data?.token
  if (!token) {
    throw new CourierConfigurationError(
      'Courier authentication response did not contain a token',
    )
  }
  cachedBearerToken = token
  cachedBearerTokenExpiresAt =
    Date.now() + Number(process.env.COURIER_TOKEN_TTL_SECONDS || 300) * 1000
  return cachedBearerToken
}

export const courierConfigurationStatus = () => {
  if (isBlueDartProvider()) {
    const status = blueDartConfigurationStatus()
    return {
      configured: status.configured,
      trackingConfigured: status.trackingConfigured,
      provider: 'BLUEDART',
    }
  }
  return {
    trackingConfigured: false,
    configured: Boolean(
      process.env.COURIER_CREATE_ORDER_URL &&
        (process.env.COURIER_API_TOKEN ||
          (process.env.COURIER_AUTH_URL &&
            process.env.COURIER_CLIENT_ID &&
            process.env.COURIER_CLIENT_SECRET)),
    ),
    provider: process.env.COURIER_PROVIDER || 'COURIER_ADAPTER',
  }
}

export const createCourierOrder = async (payload) => {
  // Provider switch: route to Blue Dart when selected.
  if (isBlueDartProvider()) {
    return createBlueDartOrder(payload)
  }
  if (!process.env.COURIER_CREATE_ORDER_URL) {
    throw new CourierConfigurationError(
      'Courier create-order endpoint is not configured',
    )
  }
  const token = await getBearerToken()
  const response = await axios.post(
    process.env.COURIER_CREATE_ORDER_URL,
    payload,
    {
      timeout: Number(process.env.COURIER_TIMEOUT_MS || 15000),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    },
  )
  const orderId =
    response.data?.orderId ||
    response.data?.order_id ||
    response.data?.data?.orderId ||
    response.data?.data?.order_id
  if (!orderId) {
    throw new Error('Courier response did not contain an order ID')
  }
  return {
    orderId: String(orderId),
    providerStatus:
      response.data?.status || response.data?.data?.status || 'CREATED',
  }
}

/**
 * Fetch the latest tracking scan for the given courier order IDs.
 * @param {string[]} orderIds - Courier order/AWB numbers
 * @returns {Promise<Array<{awbNo: string, status: string, error: string}>>}
 */
export const trackCourierShipments = async (orderIds) => {
  if (!isBlueDartProvider()) {
    throw new CourierConfigurationError(
      'Tracking is not available for the configured courier provider',
    )
  }
  return parseTrackingResponse(await trackShipment(orderIds))
}
