import { PAYOUT_STATUS } from '../../models/buybackPayoutModel.js'
import leads from '../../models/leadsModel.js'
import { sendPayoutSuccessNotification } from '../payoutNotificationService.js'
import { decryptPII } from '../../utils/kmsEncryption.js'
import { safeLog } from '../../utils/piiMasking.js'
import { PayoutBusinessError, classifyBankEnquiryFailure } from './validation.js'

const PAYMENT_SUCCESS_MESSAGE = 'Payment completed successfully.'

const syncLeadStatus = (payout) =>
  leads.findByIdAndUpdate(payout.leadId, {
    payoutStatus: payout.status,
    ...(payout.status === PAYOUT_STATUS.SUCCESS
      ? {
          // Same final lead status as the manual store-payment flow.
          status: 'Completed',
          $push: {
            history: {
              action: 'HSBC UPI payout completed',
              performedBy: payout.paymentClaimedBy,
              changes: {
                payoutId: payout._id,
                amount: payout.amount,
                rrn: payout.providerTransactionRrn,
              },
            },
          },
        }
      : {}),
  })

const applyProviderResult = async (payout, result) => {
  payout.providerResponseCode = result.respCode || ''
  payout.providerStatus = result.transStatus || ''
  payout.providerMessage = result.transMessage || result.respMessage || ''
  payout.providerReferenceNo = result.refNo || payout.providerReferenceNo
  payout.providerTransactionId =
    result.newTransId || result.transId || payout.providerTransactionId
  payout.providerTransactionRrn =
    result.newTransRRN || result.transRRN || payout.providerTransactionRrn
  payout.providerApprovalNo =
    result.transApprNo || result.approvalNumber || payout.providerApprovalNo

  if (result.respCode === '00' && result.transStatus === 'S') {
    payout.status = PAYOUT_STATUS.SUCCESS
    payout.statusMessage = PAYMENT_SUCCESS_MESSAGE
    payout.paidAt = payout.paidAt || new Date()
  } else if (['F', 'R'].includes(result.transStatus)) {
    payout.status = PAYOUT_STATUS.FAILED
    payout.statusMessage =
      result.transMessage || 'The payout was declined by HSBC.'
    payout.failedAt = new Date()
  } else {
    payout.status = PAYOUT_STATUS.STATUS_UNKNOWN
    payout.statusMessage =
      result.transMessage ||
      'Payment confirmation is pending. Check status before trying again.'
  }
  await payout.save()
  await syncLeadStatus(payout)
  return payout
}

// Map a normalised IMPS result (from hsbcPaymentInitiationClient) onto the payout.
const applyImpsResult = async (payout, result) => {
  payout.providerResponseCode = result.responseCode || ''
  payout.providerStatus = result.success ? 'S' : result.responseCode || 'F'
  payout.providerMessage = result.responseDescription || ''
  payout.providerTransactionRrn = result.rrn || payout.providerTransactionRrn

  if (result.success) {
    payout.status = PAYOUT_STATUS.SUCCESS
    payout.statusMessage = PAYMENT_SUCCESS_MESSAGE
    payout.paidAt = payout.paidAt || new Date()
  } else {
    payout.status = PAYOUT_STATUS.FAILED
    payout.statusMessage =
      result.responseDescription || 'The payout was declined by HSBC.'
    payout.failedAt = new Date()
  }
  await payout.save()
  await syncLeadStatus(payout)
  return payout
}

// Map a NEFT result. NEFT settles in batches, so an accepted result stays
// PROCESSING (reconciliation / status enquiry confirm final settlement).
const applyNeftResult = async (payout, result) => {
  payout.providerResponseCode = result.groupStatusCode || result.statusCode || ''
  payout.providerStatus = result.transactionStatusCode || result.statusCode || ''
  payout.providerMessage = result.statusDescription || ''
  payout.providerReferenceNo = result.referenceId || payout.providerReferenceNo
  payout.providerTransactionRrn = result.rrn || payout.providerTransactionRrn

  if (result.classification === 'SUCCESS') {
    payout.status = PAYOUT_STATUS.SUCCESS
    payout.statusMessage = PAYMENT_SUCCESS_MESSAGE
    payout.paidAt = payout.paidAt || new Date()
  } else if (result.classification === 'FAILED') {
    payout.status = PAYOUT_STATUS.FAILED
    payout.statusMessage =
      result.statusDescription || 'The payout was rejected by HSBC.'
    payout.failedAt = new Date()
  } else {
    payout.status = PAYOUT_STATUS.PROCESSING
    payout.statusMessage =
      'Payment accepted by HSBC; awaiting settlement confirmation.'
  }
  await payout.save()
  await syncLeadStatus(payout)
  return payout
}

const getLeadForNotification = (payout) =>
  leads
    .findById(payout.leadId)
    .select('phoneNumber emailId name modelId')
    .populate('modelId', 'name')

const sendSuccessNotification = async (payout) => {
  if (
    payout.status !== PAYOUT_STATUS.SUCCESS ||
    payout.successNotificationState === 'DELIVERED'
  ) {
    return
  }
  const lead = await getLeadForNotification(payout)
  const notification = await sendPayoutSuccessNotification({
    mobileNumber: await decryptPII(lead?.phoneNumber),
    email: await decryptPII(lead?.emailId),
    customerName: await decryptPII(lead?.name),
    amount: payout.amount,
    transactionRrn: payout.providerTransactionRrn,
  })
  payout.successNotificationState = notification.delivered
    ? 'DELIVERED'
    : 'FAILED'
  payout.successNotificationLastAttemptAt = new Date()
  await payout.save()
}

const completeReceipt = async (payout) => {
  if (payout.status !== PAYOUT_STATUS.SUCCESS) {
    return
  }
  if (payout.receiptState === 'COMPLETED') {
    await sendSuccessNotification(payout)
    return
  }
  if (payout.receiptState === 'PROCESSING') {
    return
  }
  payout.receiptState = 'PROCESSING'
  await payout.save()
  try {
    const { finalizePurchaseAfterPayout } = await import(
      '../../controller/questionnaireController.js'
    )
    const providerLabels = {
      HSBC_UPI: 'UPI (HSBC)',
      HSBC_IMPS: 'IMPS (HSBC)',
      HSBC_NEFT: 'NEFT (HSBC)',
    }
    const receiptUrl = await finalizePurchaseAfterPayout(payout.leadId, {
      paymentMode: providerLabels[payout.provider] || 'Manual',
      paymentReference:
        payout.providerTransactionRrn ||
        payout.providerReferenceNo ||
        payout.merchantOrderNo ||
        '',
      paidAt: payout.paidAt,
      paymentStatus: 'Paid',
    })
    payout.receiptState = 'COMPLETED'
    payout.receiptUrl = receiptUrl || ''
    payout.receiptGeneratedAt = new Date()
    await payout.save()
    await sendSuccessNotification(payout)
  } catch (error) {
    payout.receiptState = 'FAILED'
    await payout.save()
    safeLog.error('Post-payout receipt delivery failed', error)
  }
}

const handleStatusEnquiryFailure = async (payout, actorId, error) => {
  const failure = classifyBankEnquiryFailure(error)
  payout.status = PAYOUT_STATUS.STATUS_UNKNOWN
  payout.statusMessage = failure.message
  payout.lastStatusCheckedAt = new Date()
  payout.attempts.push({
    actorId,
    requestReference: payout.merchantOrderNo,
    httpStatus: error.status,
    outcome: failure.outcome,
    responseMessage: error.message,
  })
  await payout.save()
  await syncLeadStatus(payout)
  throw new PayoutBusinessError(payout.statusMessage, 502)
}

export {
  syncLeadStatus,
  applyProviderResult,
  applyImpsResult,
  applyNeftResult,
  getLeadForNotification,
  sendSuccessNotification,
  completeReceipt,
  handleStatusEnquiryFailure,
}
