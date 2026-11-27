import {
  StorePaymentError,
  createStorePaymentRequest,
  flagStorePayment,
  getStorePayment,
  listStorePayments,
  markStorePaymentPaid,
  unflagStorePayment,
} from '../services/storePaymentService.js'
import { safeLog } from '../utils/piiMasking.js'
import s3Controller from './s3.controller.js'

const sendError = (res, error) => {
  if (error instanceof StorePaymentError) {
    return res
      .status(error.statusCode)
      .json({ success: false, message: error.message })
  }
  safeLog.error('Store payment request failed', error)
  return res.status(500).json({
    success: false,
    message: 'Unable to process store payment request',
  })
}

const create = async (req, res) => {
  try {
    const data = await createStorePaymentRequest({
      actorId: req.userId,
      leadIds: req.body.leadIds || req.body.deviceIDs,
    })
    return res.status(201).json({
      success: true,
      message:
        data.paymentMode === 'PREPAID_DEFERRED'
          ? 'Payment request recorded; no pickup payment is required'
          : 'Payment request created',
      data,
    })
  } catch (error) {
    return sendError(res, error)
  }
}

const list = async (req, res) => {
  try {
    const data = await listStorePayments({
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
    const data = await getStorePayment({
      actorId: req.userId,
      paymentId: req.params.id,
    })
    return res.json({ success: true, data })
  } catch (error) {
    return sendError(res, error)
  }
}

const flag = async (req, res) => {
  try {
    const data = await flagStorePayment({
      actorId: req.userId,
      paymentId: req.params.id,
      reason: req.body.reason,
    })
    return res.json({
      success: true,
      message: 'Payment request flagged',
      data,
    })
  } catch (error) {
    return sendError(res, error)
  }
}

const unflag = async (req, res) => {
  try {
    const data = await unflagStorePayment({
      actorId: req.userId,
      paymentId: req.params.id,
      resolution: req.body.resolution,
    })
    return res.json({
      success: true,
      message: 'Payment request returned to the Accounts queue',
      data,
    })
  } catch (error) {
    return sendError(res, error)
  }
}

const markPaid = async (req, res) => {
  try {
    const data = await markStorePaymentPaid({
      actorId: req.userId,
      paymentId: req.params.id,
      paymentReference: req.body.paymentReference,
      paymentReceipt: req.body.paymentReceipt,
      remarks: req.body.remarks,
      receiptFile: req.file,
      uploadReceipt: (file) => s3Controller.uploadFileBuffer(file),
    })
    return res.json({
      success: true,
      message:
        data.notification?.state === 'FAILED'
          ? 'Payment completed, but email delivery failed after retries'
          : 'Payment completed and recipients notified',
      data,
    })
  } catch (error) {
    return sendError(res, error)
  }
}

export default { create, list, findById, flag, unflag, markPaid }

