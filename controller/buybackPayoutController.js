import {
  PayoutBusinessError,
  getCustomerPayout,
  submitCustomerVpa,
  submitCustomerBankDetails,
  approvePayout,
  makePayout,
  refreshPayoutStatus,
  getPayoutForUser,
  listPayoutsForUser,
  resendPayoutLink,
  assignPayoutToLogistics,
} from '../services/buybackPayoutService.js'
import {
  HsbcUpiConfigurationError,
  HsbcUpiTransportError,
  hsbcUpiClientConfigStatus,
} from '../integrations/hsbc/hsbcUpiClient.js'
import { safeLog } from '../utils/piiMasking.js'

const disablePaymentStateCaching = (res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    Expires: '0',
  })
}

const sendError = (res, error) => {
  if (error instanceof PayoutBusinessError) {
    return res
      .status(error.statusCode)
      .json({ success: false, message: error.message })
  }
  safeLog.error('Buyback payout request failed', {
    errorName: error?.name || 'Error',
    errorMessage: error?.message || 'Unknown error',
    providerCode: error?.code || '',
    providerStatus: error?.status || '',
    providerEndpoint: error?.endpoint || '',
    providerTimeout: error?.isTimeout === true,
  })
  if (error instanceof HsbcUpiConfigurationError) {
    return res.status(503).json({
      success: false,
      message: 'HSBC UPI configuration is incomplete',
      code: 'HSBC_CONFIG_ERROR',
      detail: error.message,
    })
  }
  if (error instanceof HsbcUpiTransportError) {
    let code
    if (error.isTimeout) {
      code = 'HSBC_TIMEOUT'
    } else if (error.status) {
      code = `HSBC_HTTP_${error.status}`
    } else {
      code = 'HSBC_NETWORK_ERROR'
    }
    return res.status(502).json({
      success: false,
      message: error.message,
      code,
    })
  }
  return res.status(500).json({
    success: false,
    message: 'Unable to process payout request',
  })
}

const customerDetails = async (req, res) => {
  try {
    disablePaymentStateCaching(res)
    const data = await getCustomerPayout(req.params.token)
    return res.json({ success: true, data })
  } catch (error) {
    return sendError(res, error)
  }
}

const customerSubmitVpa = async (req, res) => {
  try {
    disablePaymentStateCaching(res)
    const data = await submitCustomerVpa({
      token: req.params.token,
      vpa: req.body.vpa,
    })
    return res.json({
      success: true,
      message: 'UPI ID verified successfully',
      data,
    })
  } catch (error) {
    return sendError(res, error)
  }
}

const customerSubmitBankDetails = async (req, res) => {
  try {
    disablePaymentStateCaching(res)
    const data = await submitCustomerBankDetails({
      token: req.params.token,
      accountNumber: req.body.accountNumber,
      ifsc: req.body.ifsc,
      accountName: req.body.accountName,
    })
    return res.json({
      success: true,
      message: 'Bank details received successfully',
      data,
    })
  } catch (error) {
    return sendError(res, error)
  }
}

const list = async (req, res) => {
  try {
    disablePaymentStateCaching(res)
    const data = await listPayoutsForUser({
      actorId: req.userId,
      query: req.query,
    })
    return res.json({ success: true, data })
  } catch (error) {
    return sendError(res, error)
  }
}

const findById = async (req, res) => {
  try {
    disablePaymentStateCaching(res)
    const data = await getPayoutForUser({
      payoutId: req.params.id,
      actorId: req.userId,
    })
    return res.json({ success: true, data })
  } catch (error) {
    return sendError(res, error)
  }
}

const decideApproval = async (req, res) => {
  try {
    disablePaymentStateCaching(res)
    if (typeof req.body.approved !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'approved must be true or false',
      })
    }
    const data = await approvePayout({
      payoutId: req.params.id,
      actorId: req.userId,
      approved: req.body.approved,
      remarks: req.body.remarks,
    })
    return res.json({
      success: true,
      message: req.body.approved ? 'Payout approved' : 'Payout rejected',
      data,
    })
  } catch (error) {
    return sendError(res, error)
  }
}

const pay = async (req, res) => {
  try {
    disablePaymentStateCaching(res)
    const data = await makePayout({
      payoutId: req.params.id,
      actorId: req.userId,
    })
    return res.json({
      success: true,
      message: data.statusMessage,
      data,
    })
  } catch (error) {
    return sendError(res, error)
  }
}

const sendToLogistics = async (req, res) => {
  try {
    disablePaymentStateCaching(res)
    const data = await assignPayoutToLogistics({
      payoutId: req.params.id,
      actorId: req.userId,
      remarks: req.body?.remarks,
    })
    return res.json({
      success: true,
      message: `Sent to logistics in ${data.logistics?.lotCode || 'a new lot'}`,
      data,
    })
  } catch (error) {
    return sendError(res, error)
  }
}

const refreshStatus = async (req, res) => {
  try {
    disablePaymentStateCaching(res)
    const data = await refreshPayoutStatus({
      payoutId: req.params.id,
      actorId: req.userId,
    })
    return res.json({
      success: true,
      message: `Status checked: ${data.statusMessage}`,
      data,
    })
  } catch (error) {
    return sendError(res, error)
  }
}

const resendLink = async (req, res) => {
  try {
    disablePaymentStateCaching(res)
    const result = await resendPayoutLink({
      payoutId: req.params.id,
      actorId: req.userId,
    })
    return res.json({
      success: true,
      message: result.notification.delivered
        ? `A new payout link was sent by ${result.notification.channel || 'notification'}.`
        : `A new payout link was created, but notification delivery failed: ${
            result.notification.reason || 'provider rejected the request'
          }`,
      data: {
        ...result.payout.toJSON(),
        id: result.payout._id,
        paymentLink: result.paymentLink,
        notificationDelivered: result.notification.delivered,
        notificationProviderRequestId:
          result.notification.providerRequestId || '',
        notificationError: result.notification.reason || '',
      },
    })
  } catch (error) {
    return sendError(res, error)
  }
}

const configurationStatus = async (_req, res) =>
  res.json({ success: true, data: hsbcUpiClientConfigStatus() })

export default {
  customerDetails,
  customerSubmitVpa,
  customerSubmitBankDetails,
  list,
  findById,
  decideApproval,
  pay,
  refreshStatus,
  resendLink,
  sendToLogistics,
  configurationStatus,
}
