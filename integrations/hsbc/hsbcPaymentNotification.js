import crypto from 'crypto'

// HSBC "Payment Status Notification" webhook helpers (pure — no I/O).
//
// HSBC POSTs a notification whose `event` is a PGP-encrypted, Base64-encoded
// PAIN002 status message. Full decryption needs the HSBC-provided PGP private
// key plus an OpenPGP library (not yet a dependency), so it is deferred; the
// plain envelope fields are parsed and acknowledged now.

export const parseStatusNotification = (body = {}) => ({
  srcSysId: body.srcSysId || '',
  subscriptionId: body.subscriptionId || '',
  custRelId: body.custRelId || '',
  trackId: body.trackId || '',
  eventCat: body.eventCat || '',
  eventId: body.eventId || '',
  eventFrmt: body.eventFrmt || '',
  event: body.event || '',
})

/**
 * Inspect the encrypted event envelope. Returns whether it is a PGP message and
 * that decryption is pending (until the HSBC private key is provisioned).
 */
export const inspectNotificationEvent = (event) => {
  if (!event) {
    return { isPgp: false, pending: false, reason: 'No event payload' }
  }
  let decoded = ''
  try {
    decoded = Buffer.from(String(event), 'base64').toString('utf8')
  } catch {
    decoded = ''
  }
  const isPgp = decoded.includes('BEGIN PGP MESSAGE')
  return {
    isPgp,
    pending: true,
    reason: 'PGP decryption deferred until HSBC private key is provisioned',
  }
}

/**
 * Build the acknowledgement body HSBC expects in the webhook response.
 */
export const buildNotificationAck = (notification, ok = true) => ({
  subscriptionId: notification.subscriptionId || '',
  custRelId: notification.custRelId || '',
  eventCat: notification.eventCat || '',
  eventId: notification.eventId || '',
  eventFrmt: notification.eventFrmt || '',
  statusCode: ok ? 'Success' : 'RJCT',
  statusDesc: ok
    ? 'Event has been processed successfully'
    : 'Error while processing the payload',
})

// Constant-time string comparison to avoid leaking the secret via timing.
const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) {
    return false
  }
  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * Validate the caller against the configured webhook credentials.
 * HSBC sends `clientId` / `secret` headers on the callback. When no webhook
 * secret is configured this FAILS CLOSED in production (an unauthenticated
 * settlement callback must never be accepted there) and stays lenient only
 * outside production for local/sandbox testing.
 */
export const isAuthorisedNotification = (headers = {}) => {
  const expectedId = String(process.env.HSBC_PAYMENT_WEBHOOK_CLIENT_ID || '').trim()
  const expectedSecret = String(
    process.env.HSBC_PAYMENT_WEBHOOK_SECRET || '',
  ).trim()
  if (!expectedSecret) {
    return process.env.NODE_ENV !== 'production'
  }
  const gotId = String(headers.clientid || headers.clientId || '').trim()
  const gotSecret = String(headers.secret || '').trim()
  return (!expectedId || safeEqual(gotId, expectedId)) && safeEqual(gotSecret, expectedSecret)
}
