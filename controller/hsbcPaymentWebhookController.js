import { safeLog } from '../utils/piiMasking.js'
import {
  parseStatusNotification,
  buildNotificationAck,
  isAuthorisedNotification,
} from '../integrations/hsbc/hsbcPaymentNotification.js'
import {
  pgpConfigured,
  decryptVerifyFromBase64,
} from '../integrations/hsbc/hsbcPgp.js'
import { extractTag } from '../integrations/hsbc/hsbcPaymentInitiationClient.js'
import { applyStatusNotification } from '../services/buybackPayoutService.js'

// Decrypt the PGP event (PAIN002) and apply its status to the matching payout.
const processEvent = async (event) => {
  if (!event || !pgpConfigured()) {
    return { processed: false, reason: 'pgp_not_configured' }
  }
  const { text, verified } = await decryptVerifyFromBase64(event)
  if (!verified) {
    // The PAIN002 event must be signed by HSBC. Reject forged or unsigned
    // events instead of settling a payout on their say-so.
    return { processed: false, reason: 'signature_unverified' }
  }
  const statusCode = extractTag(text, 'TxSts') || extractTag(text, 'GrpSts')
  const reference =
    extractTag(text, 'OrgnlEndToEndId') ||
    extractTag(text, 'OrgnlInstrId') ||
    extractTag(text, 'OrgnlMsgId') ||
    extractTag(text, 'AcctSvcrRef')
  await applyStatusNotification({ reference, statusCode })
  return { processed: true, verified: true, statusCode, reference }
}

/**
 * Receive an HSBC "Payment Status Notification" callback: authenticate, decrypt
 * the PAIN002 event, update the matching payout, and acknowledge.
 */
const receiveStatusNotification = async (req, res) => {
  const notification = parseStatusNotification(req.body || {})
  try {
    if (!isAuthorisedNotification(req.headers)) {
      return res.status(400).json(buildNotificationAck(notification, false))
    }
    const outcome = await processEvent(notification.event)
    if (outcome.reason === 'signature_unverified') {
      safeLog.warn('HSBC payment status notification rejected: unverified signature', {
        eventId: notification.eventId,
        subscriptionId: notification.subscriptionId,
      })
      return res.status(400).json(buildNotificationAck(notification, false))
    }
    safeLog.info('HSBC payment status notification received', {
      eventId: notification.eventId,
      eventCat: notification.eventCat,
      subscriptionId: notification.subscriptionId,
      ...outcome,
    })
    return res.status(200).json(buildNotificationAck(notification, true))
  } catch (error) {
    safeLog.error('HSBC payment status notification failed', error)
    return res.status(500).json(buildNotificationAck(notification, false))
  }
}

export default { receiveStatusNotification }
