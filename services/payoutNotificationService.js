import https from 'https'
import { safeLog } from '../utils/piiMasking.js'
import transporter from '../utils/transporter.js'

const notificationMode = (type) =>
  (
    process.env[
      type === 'LINK'
        ? 'PAYOUT_LINK_NOTIFICATION_MODE'
        : 'PAYOUT_SUCCESS_NOTIFICATION_MODE'
    ] ||
    process.env.PAYOUT_NOTIFICATION_MODE ||
    'EMAIL'
  ).toUpperCase()

const useEmailNotifications = (type) =>
  notificationMode(type) === 'EMAIL'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const escapeHtml = (value) =>
  String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')

const msg91ShortUrlEnabled = () =>
  ['1', 'true', 'yes', 'on'].includes(
    String(process.env.MSG91_PAYOUT_SHORT_URL_ENABLED || '').toLowerCase(),
  )

const msg91RequestId = (body) => {
  const directId = body?.request_id || body?.requestId
  if (directId) {
    return String(directId)
  }

  const message = String(body?.message || '')
  return message.match(/\b[a-zA-Z0-9]{24}\b/)?.[0] || ''
}

export const resolvePayoutEmailRecipient = (customerEmail) => {
  const requestedRecipient = String(customerEmail || '')
    .trim()
    .toLowerCase()
  if (EMAIL_PATTERN.test(requestedRecipient)) {
    return { recipient: requestedRecipient, recipientSource: 'CUSTOMER' }
  }

  const fallbackRecipient = String(
    process.env.PAYOUT_NOTIFICATION_EMAIL || '',
  )
    .trim()
    .toLowerCase()
  if (EMAIL_PATTERN.test(fallbackRecipient)) {
    return { recipient: fallbackRecipient, recipientSource: 'FALLBACK' }
  }
  return { recipient: '', recipientSource: 'NONE' }
}

const sendPayoutEmail = async ({ recipient, subject, html }) => {
  if (!recipient) {
    return {
      delivered: false,
      channel: 'EMAIL',
      reason:
        'Customer email is unavailable and PAYOUT_NOTIFICATION_EMAIL is not configured',
    }
  }

  const info = await transporter.sendMail({
    from: process.env.MAIL,
    to: recipient,
    subject,
    html,
  })
  return {
    delivered: true,
    channel: 'EMAIL',
    providerResponse: info.messageId,
  }
}

const sendDirectEmail = async ({ recipients, subject, html }) => {
  const uniqueRecipients = [
    ...new Set(
      (recipients || [])
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
  if (uniqueRecipients.length === 0) {
    return {
      delivered: false,
      channel: 'EMAIL',
      reason: 'No eligible approval recipients are configured',
    }
  }
  const info = await transporter.sendMail({
    from: process.env.MAIL,
    to: uniqueRecipients,
    subject,
    html,
  })
  return {
    delivered: true,
    channel: 'EMAIL',
    providerResponse: info.messageId,
    recipientCount: uniqueRecipients.length,
  }
}

const msg91SoftFailure = (reason) => ({
  delivered: false,
  channel: 'SMS',
  reason,
})

const normalizeMobile = (mobileNumber) =>
  String(mobileNumber || '')
    .replace(/\D/g, '')
    .slice(-10)

const parseMsg91Json = (body) => {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

const classifyMsg91Response = (response, body) => {
  if (response.statusCode >= 200 && response.statusCode < 300) {
    const parsedBody = parseMsg91Json(body)
    if (!parsedBody) {
      throw new Error('MSG91 returned an invalid JSON response')
    }
    if (parsedBody.type !== 'success' && parsedBody.status !== 'success') {
      throw new Error(parsedBody.message || 'MSG91 rejected the notification')
    }
    return {
      delivered: true,
      channel: 'SMS',
      providerResponse: body,
      providerRequestId: msg91RequestId(parsedBody),
    }
  }
  throw new Error(`MSG91 returned HTTP ${response.statusCode}`)
}

const settleMsg91Response = (response, resolve, reject) => {
  const chunks = []
  response.on('data', (chunk) => chunks.push(chunk))
  response.on('end', () => {
    const body = Buffer.concat(chunks).toString()
    try {
      const delivery = classifyMsg91Response(response, body)
      safeLog.info('MSG91 accepted payout SMS request', {
        providerRequestId: delivery.providerRequestId || 'not-returned',
      })
      resolve(delivery)
    } catch (error) {
      reject(error)
    }
  })
}

const postMsg91Flow = (flowId, mobileNumber, variables) =>
  new Promise((resolve, reject) => {
    if (!flowId || !process.env.MSG91_AUTHKEY) {
      resolve(msg91SoftFailure('SMS template is not configured'))
      return
    }
    const normalizedMobile = normalizeMobile(mobileNumber)
    if (normalizedMobile.length !== 10) {
      resolve(
        msg91SoftFailure('Customer mobile number is unavailable or invalid'),
      )
      return
    }

    const request = https.request(
      {
        method: 'POST',
        hostname: 'control.msg91.com',
        path: '/api/v5/flow',
        headers: {
          authkey: process.env.MSG91_AUTHKEY,
          'Content-Type': 'application/json',
        },
      },
      (response) => settleMsg91Response(response, resolve, reject),
    )

    request.on('error', reject)
    request.write(
      JSON.stringify({
        flow_id: flowId,
        ...(msg91ShortUrlEnabled() ? { short_url: '1' } : {}),
        recipients: [
          {
            mobiles: `91${normalizedMobile}`,
            ...variables,
          },
        ],
      }),
    )
    request.end()
  })

const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Retry an SMS send on transient failure. `postMsg91Flow` resolves for permanent
 * soft failures (missing template / invalid number) and rejects on transient
 * send errors (network / HTTP / provider rejection); only rejections are retried.
 * Exported for unit testing.
 */
export const withSmsRetries = async (
  send,
  { maxAttempts = 3, delayMs = 500 } = {},
) => {
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await send()
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts) {
        await waitMs(delayMs)
      }
    }
  }
  throw lastError
}

export const sendPayoutLinkNotification = async ({
  mobileNumber,
  email,
  customerName,
  amount,
  device,
  link,
}) => {
  try {
    if (useEmailNotifications('LINK')) {
      const recipientDetails = resolvePayoutEmailRecipient(email)
      const delivery = await sendPayoutEmail({
        recipient: recipientDetails.recipient,
        subject: `GREST payout link - ₹${Number(amount).toFixed(2)}`,
        html: `
          <p>Hello,</p>
          <p>A test payout has been created for <strong>${customerName || 'Customer'}</strong>.</p>
          <p>Amount: <strong>₹${Number(amount).toFixed(2)}</strong></p>
          <p><a href="${link}">Open payout link</a></p>
          <p>This link is time-limited. Do not share it with anyone.</p>
        `,
      })
      return {
        ...delivery,
        recipientSource: recipientDetails.recipientSource,
      }
    }
    return await withSmsRetries(() =>
      postMsg91Flow(
        process.env.MSG91_PAYOUT_LINK_TEMPLATE_ID,
        mobileNumber,
        buildPayoutLinkSmsVariables({ amount, device, link }),
      ),
    )
  } catch (error) {
    safeLog.error('Unable to deliver payout link notification', error)
    return {
      delivered: false,
      channel: useEmailNotifications('LINK') ? 'EMAIL' : 'SMS',
      reason: error.message,
    }
  }
}

export const sendPayoutSuccessNotification = async ({
  mobileNumber,
  email,
  customerName,
  amount,
  transactionRrn,
}) => {
  try {
    if (useEmailNotifications('SUCCESS')) {
      const recipientDetails = resolvePayoutEmailRecipient(email)
      const delivery = await sendPayoutEmail({
        recipient: recipientDetails.recipient,
        subject: `GREST payout completed - ₹${Number(amount).toFixed(2)}`,
        html: `
          <p>Hello,</p>
          <p>The payout for <strong>${customerName || 'Customer'}</strong> was completed successfully.</p>
          <p>Amount: <strong>₹${Number(amount).toFixed(2)}</strong></p>
          <p>Transaction RRN: <strong>${transactionRrn || 'Not provided'}</strong></p>
        `,
      })
      return {
        ...delivery,
        recipientSource: recipientDetails.recipientSource,
      }
    }
    return await withSmsRetries(() =>
      postMsg91Flow(process.env.MSG91_PAYOUT_SUCCESS_TEMPLATE_ID, mobileNumber, {
        var1: customerName || 'Customer',
        var2: Number(amount).toFixed(2),
        var3: transactionRrn || '',
      }),
    )
  } catch (error) {
    safeLog.error('Unable to deliver payout success notification', error)
    return {
      delivered: false,
      channel: useEmailNotifications('SUCCESS') ? 'EMAIL' : 'SMS',
      reason: error.message,
    }
  }
}

export const buildPayoutLinkSmsVariables = ({ amount, device, link }) => ({
  amount: Number(amount).toFixed(2),
  device: String(device || 'device').trim() || 'device',
  link: String(link || '').trim(),
})

export const sendPayoutApprovalNotification = async ({
  recipients,
  amount,
  leadCode,
  storeName,
}) => {
  try {
    return await sendDirectEmail({
      recipients,
      subject: `GREST payout approval required - ₹${Number(amount).toFixed(2)}`,
      html: `
        <p>A customer payout is waiting for approval.</p>
        <p>Lead: <strong>${leadCode || 'N/A'}</strong></p>
        <p>Store: <strong>${storeName || 'N/A'}</strong></p>
        <p>Amount: <strong>₹${Number(amount).toFixed(2)}</strong></p>
        <p>Open Customer Payouts in GREST to approve or reject it.</p>
      `,
    })
  } catch (error) {
    safeLog.error('Unable to deliver payout approval notification', error)
    return {
      delivered: false,
      channel: 'EMAIL',
      reason: error.message,
    }
  }
}

export const sendPayoutRejectionNotification = async ({
  email,
  customerName,
  amount,
  remarks,
}) => {
  try {
    const recipientDetails = resolvePayoutEmailRecipient(email)
    const delivery = await sendPayoutEmail({
      recipient: recipientDetails.recipient,
      subject: `GREST payout rejected - ₹${Number(amount).toFixed(2)}`,
      html: `
        <p>Hello ${escapeHtml(customerName || 'Customer')},</p>
        <p>Your payout request for <strong>₹${Number(amount).toFixed(2)}</strong> was rejected.</p>
        <p>Reason: <strong>${escapeHtml(String(remarks || '').trim())}</strong></p>
        <p>Please contact the store if you need assistance.</p>
      `,
    })
    return {
      ...delivery,
      recipientSource: recipientDetails.recipientSource,
    }
  } catch (error) {
    safeLog.error('Unable to deliver payout rejection notification', error)
    return { delivered: false, channel: 'EMAIL', reason: error.message }
  }
}
