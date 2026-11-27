import crypto from 'crypto'
import mongoose from 'mongoose'
import BuybackPayout, { PAYOUT_STATUS } from '../../models/buybackPayoutModel.js'
import leads from '../../models/leadsModel.js'
import storeModel from '../../models/storeModel.js'
import UsersModel from '../../models/UsersModel.js'
import { decryptPII } from '../../utils/kmsEncryption.js'
import { safeLog } from '../../utils/piiMasking.js'
import {
  initiatePayout,
  enquirePayout,
  HsbcUpiTransportError,
} from '../../integrations/hsbc/hsbcUpiClient.js'
import {
  initiateImpsPayout,
  enquireImpsStatus,
  initiateNeftPayout,
  enquireNeftStatus,
  classifyIsoStatus,
  HsbcPaymentTransportError,
} from '../../integrations/hsbc/hsbcPaymentInitiationClient.js'
import {
  sendPayoutLinkNotification,
  sendPayoutRejectionNotification,
} from '../payoutNotificationService.js'
import {
  emitNotification,
  NOTIFICATION_TYPES,
} from '../notificationService.js'
import {
  PayoutBusinessError,
  tokenHash,
  paymentLinkForToken,
  numericReference,
  numericEnquiryReference,
  SUPPORTED_HSBC_MODES,
  TOKEN_BYTES,
  isImpsPayout,
  isNeftPayout,
  isBankTransferPayout,
  ADMIN_ROLES,
  ROLE_SUPER_ADMIN,
  ROLE_MANAGER,
  validateApprovalDecision,
} from './validation.js'
import { getStorePayoutSettings, requiresApproval } from './settings.js'
import {
  syncLeadStatus,
  applyProviderResult,
  applyImpsResult,
  applyNeftResult,
  getLeadForNotification,
  completeReceipt,
  handleStatusEnquiryFailure,
} from './processing.js'
import { expireAwaitingPayoutIfNeeded } from './customer.js'
import { loadActor, assertPayoutAccess } from './access.js'

const PAYOUT_NOT_FOUND_MESSAGE = 'Payout not found'

const notifyPayoutDecision = async (payout, actorId, decision) => {
  try {
    await emitNotification({
      userId: payout.initiatedBy,
      companyId: payout.companyId,
      type: NOTIFICATION_TYPES.PAYOUT_APPROVAL_DECIDED,
      title: decision.approved ? 'Customer payout approved' : 'Customer payout rejected',
      body: decision.approved
        ? `The payout of ₹${Number(payout.amount).toFixed(2)} was approved.`
        : `The payout of ₹${Number(payout.amount).toFixed(2)} was rejected: ${decision.remarks}`,
      entityType: 'buybackPayout',
      entityId: payout._id,
      createdBy: actorId,
    })
    if (!decision.approved) {
      const lead = await getLeadForNotification(payout)
      await sendPayoutRejectionNotification({
        email: await decryptPII(lead?.emailId),
        customerName: await decryptPII(lead?.name),
        amount: payout.amount,
        remarks: decision.remarks,
      })
    }
  } catch (error) {
    safeLog.error('Unable to deliver payout approval decision notifications', error)
  }
}

const assertCanResendPayout = (payout) => {
  if (
    ![
      PAYOUT_STATUS.AWAITING_VPA,
      PAYOUT_STATUS.EXPIRED,
      PAYOUT_STATUS.FAILED,
    ].includes(payout.status)
  ) {
    throw new PayoutBusinessError(
      'A new link can only be sent while waiting for a UPI ID, after expiry, or after a failed payout',
      409,
    )
  }
  if (
    payout.status === PAYOUT_STATUS.AWAITING_VPA &&
    payout.linkNotificationState === 'DELIVERED'
  ) {
    throw new PayoutBusinessError(
      'The payment link has already been delivered to the customer',
      409,
    )
  }
}

const resetPayoutForRetry = (payout) => {
  payout.beneficiaryVpaEncrypted = undefined
  payout.beneficiaryVpaHash = undefined
  payout.beneficiaryVpaMasked = ''
  payout.beneficiaryNameEncrypted = undefined
  payout.beneficiaryIfscEncrypted = undefined
  payout.vpaValidationReference = ''
  payout.vpaValidatedAt = undefined
  payout.customerLinkSubmittedAt = undefined
  payout.approval.status = payout.approval.required
    ? 'PENDING'
    : 'NOT_REQUIRED'
  payout.approval.decidedBy = undefined
  payout.approval.decidedAt = undefined
  payout.approval.remarks = ''
  payout.approval.notificationState = 'NOT_SENT'
  payout.approval.notifiedAt = undefined
  payout.merchantOrderNo = undefined
  payout.providerReferenceNo = ''
  payout.providerTransactionId = ''
  payout.providerTransactionRrn = ''
  payout.providerApprovalNo = ''
  payout.providerResponseCode = ''
  payout.providerStatus = ''
  payout.providerMessage = ''
  payout.failedAt = undefined
}

const dispatchPayout = async (claimed, merchantOrderNo, actorId) => {
  try {
    if (isImpsPayout(claimed)) {
      const [beneficiaryAccount, beneficiaryIfsc] = await Promise.all([
        decryptPII(claimed.beneficiaryAccountNumberEncrypted),
        decryptPII(claimed.beneficiaryIfscEncrypted),
      ])
      const result = await initiateImpsPayout({
        beneficiaryAccount,
        beneficiaryIfsc,
        amount: claimed.amount,
        requestId: merchantOrderNo,
      })
      claimed.attempts.push({
        actorId,
        requestReference: merchantOrderNo,
        httpStatus: result.httpStatus,
        outcome: result.success ? 'SUCCESS' : result.responseCode || 'FAILED',
        responseCode: result.responseCode,
        responseMessage: result.responseDescription,
      })
      await applyImpsResult(claimed, result)
    } else if (isNeftPayout(claimed)) {
      const [beneficiaryAccount, beneficiaryIfsc, beneficiaryName] =
        await Promise.all([
          decryptPII(claimed.beneficiaryAccountNumberEncrypted),
          decryptPII(claimed.beneficiaryIfscEncrypted),
          decryptPII(claimed.beneficiaryNameEncrypted),
        ])
      const result = await initiateNeftPayout({
        beneficiaryName,
        beneficiaryAccount,
        beneficiaryIfsc,
        amount: claimed.amount,
        requestId: merchantOrderNo,
      })
      claimed.attempts.push({
        actorId,
        requestReference: merchantOrderNo,
        httpStatus: result.httpStatus,
        outcome: result.statusCode || 'UNKNOWN',
        responseCode: result.statusCode,
        responseMessage: result.statusDescription,
      })
      await applyNeftResult(claimed, result)
    } else {
      const beneficiaryVpa = await decryptPII(claimed.beneficiaryVpaEncrypted)
      const response = await initiatePayout({
        beneficiaryVpa,
        amount: claimed.amount,
        merchantOrderNo,
        remarks: `GREST buyback ${String(claimed.leadId).slice(-12)}`,
      })
      claimed.attempts.push({
        actorId,
        requestReference: merchantOrderNo,
        httpStatus: response.httpStatus,
        outcome: response.data?.transStatus || 'UNKNOWN',
        responseCode: response.data?.respCode,
        responseMessage: response.data?.transMessage,
      })
      await applyProviderResult(claimed, response.data || {})
    }
  } catch (error) {
    claimed.status = PAYOUT_STATUS.STATUS_UNKNOWN
    claimed.statusMessage =
      'HSBC did not confirm the result. Use status enquiry before retrying.'
    claimed.attempts.push({
      actorId,
      requestReference: merchantOrderNo,
      httpStatus: error.status,
      outcome: 'TRANSPORT_ERROR',
      responseMessage: error.message,
    })
    await claimed.save()
    await syncLeadStatus(claimed)
    if (
      !(error instanceof HsbcUpiTransportError) &&
      !(error instanceof HsbcPaymentTransportError)
    ) {
      throw error
    }
  }
}

const enquireBankTransferStatus = async (payout, actorId) => {
  if (isNeftPayout(payout)) {
    try {
      const result = await enquireNeftStatus({
        requestId: payout.merchantOrderNo,
        referenceId: payout.providerReferenceNo,
      })
      payout.attempts.push({
        actorId,
        requestReference: payout.merchantOrderNo,
        httpStatus: result.httpStatus,
        outcome: `STATUS_${result.statusCode || 'UNKNOWN'}`,
        responseCode: result.statusCode,
        responseMessage: result.statusDescription,
      })
      payout.lastStatusCheckedAt = new Date()
      await applyNeftResult(payout, result)
      await completeReceipt(payout)
      return payout
    } catch (error) {
      await handleStatusEnquiryFailure(payout, actorId, error)
    }
  }
  if (isImpsPayout(payout)) {
    try {
      const result = await enquireImpsStatus({
        requestId: payout.merchantOrderNo,
        amount: payout.amount,
      })
      payout.attempts.push({
        actorId,
        requestReference: payout.merchantOrderNo,
        httpStatus: result.httpStatus,
        outcome: `STATUS_${result.success ? 'SUCCESS' : result.responseCode || 'UNKNOWN'}`,
        responseCode: result.responseCode,
        responseMessage: result.responseDescription,
      })
      payout.lastStatusCheckedAt = new Date()
      await applyImpsResult(payout, result)
      await completeReceipt(payout)
      return payout
    } catch (error) {
      await handleStatusEnquiryFailure(payout, actorId, error)
    }
  }
  return null
}

const buildPayoutListFilter = (actor, query, actorId) => {
  const filter = {}
  if (actor.role !== ROLE_SUPER_ADMIN) {
    filter.companyId = actor.companyId
  }
  if (actor.role === ROLE_MANAGER) {
    const assignedStoreIds = [
      actor.storeId,
      ...(actor.assignedStores || []),
    ].filter(Boolean)
    filter.storeId = { $in: assignedStoreIds }
  } else if (!ADMIN_ROLES.has(actor.role)) {
    filter.initiatedBy = actorId
  }
  if (query.status && Object.values(PAYOUT_STATUS).includes(query.status)) {
    filter.status = query.status
  }
  if (query.storeId && mongoose.isValidObjectId(query.storeId)) {
    if (actor.role === ROLE_MANAGER) {
      const allowedStores = [
        actor.storeId,
        ...(actor.assignedStores || []),
      ].map(String)
      filter.storeId = allowedStores.includes(String(query.storeId))
        ? query.storeId
        : { $in: [] }
    } else {
      filter.storeId = query.storeId
    }
  }
  return filter
}

// Search runs over every payout the user may see, not only the loaded page:
// lead code, store name, initiator name/email, HSBC order number, RRN, HSBC
// code, status, payment mode and the masked account / UPI ID. The role scope
// set by buildPayoutListFilter still applies on top, so search never widens it.
const SEARCH_MAX_LENGTH = 50
const SEARCH_MATCH_LIMIT = 500
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const matchingIds = async (model, filter) =>
  (await model.find(filter).select('_id').limit(SEARCH_MATCH_LIMIT).lean()).map(
    (row) => row._id,
  )

const applyPayoutSearch = async (filter, query) => {
  const search = String(query.search || '').trim().slice(0, SEARCH_MAX_LENGTH)
  if (!search) {
    return
  }
  const pattern = { $regex: escapeRegex(search), $options: 'i' }
  const [leadIds, storeIds, userIds] = await Promise.all([
    matchingIds(leads, { uniqueCode: pattern }),
    matchingIds(storeModel, { storeName: pattern }),
    matchingIds(UsersModel, { $or: [{ name: pattern }, { email: pattern }] }),
  ])
  filter.$or = [
    { merchantOrderNo: pattern },
    { providerTransactionRrn: pattern },
    { providerResponseCode: pattern },
    { status: pattern },
    { provider: pattern },
    { beneficiaryAccountMasked: pattern },
    { beneficiaryVpaMasked: pattern },
    ...(leadIds.length ? [{ leadId: { $in: leadIds } }] : []),
    ...(storeIds.length ? [{ storeId: { $in: storeIds } }] : []),
    ...(userIds.length ? [{ initiatedBy: { $in: userIds } }] : []),
  ]
}

const enquirePayoutRailStatus = async (payout) => {
  if (payout.status === PAYOUT_STATUS.SUCCESS) {
    return
  }
  if (isImpsPayout(payout)) {
    const result = await enquireImpsStatus({
      requestId: payout.merchantOrderNo,
      amount: payout.amount,
    })
    payout.attempts.push({
      requestReference: payout.merchantOrderNo,
      httpStatus: result.httpStatus,
      outcome: `AUTO_STATUS_${result.responseCode || 'UNKNOWN'}`,
      responseCode: result.responseCode,
      responseMessage: result.responseDescription,
    })
    payout.lastStatusCheckedAt = new Date()
    await applyImpsResult(payout, result)
  } else if (isNeftPayout(payout)) {
    const result = await enquireNeftStatus({
      requestId: payout.merchantOrderNo,
      referenceId: payout.providerReferenceNo,
    })
    payout.attempts.push({
      requestReference: payout.merchantOrderNo,
      httpStatus: result.httpStatus,
      outcome: `AUTO_STATUS_${result.statusCode || 'UNKNOWN'}`,
      responseCode: result.statusCode,
      responseMessage: result.statusDescription,
    })
    payout.lastStatusCheckedAt = new Date()
    await applyNeftResult(payout, result)
  } else {
    const enquiryReference = numericEnquiryReference()
    const response = await enquirePayout({
      merchantOrderNo: payout.merchantOrderNo,
      reference: enquiryReference,
      rrn: payout.providerTransactionRrn,
    })
    payout.attempts.push({
      requestReference: enquiryReference,
      httpStatus: response.httpStatus,
      outcome: `AUTO_STATUS_${response.data?.transStatus || 'UNKNOWN'}`,
      responseCode: response.data?.respCode,
      responseMessage: response.data?.transMessage,
    })
    payout.lastStatusCheckedAt = new Date()
    await applyProviderResult(payout, response.data || {})
  }
}

const reconcilePayout = async (payout) => {
  await enquirePayoutRailStatus(payout)
  if (
    payout.status === PAYOUT_STATUS.SUCCESS &&
    payout.receiptState === 'PROCESSING'
  ) {
    payout.receiptState = 'FAILED'
    await payout.save()
  }
  await completeReceipt(payout)
}

export const createPayoutForPurchase = async ({
  lead,
  initiatedBy,
  amount,
}) => {
  const existing = await BuybackPayout.findOne({ leadId: lead._id })
  if (existing) {
    return {
      payout: existing,
      paymentLink: null,
      notification: {
        delivered: false,
        reason: 'Payout already exists',
      },
    }
  }

  const settings = await getStorePayoutSettings(lead.storeId)
  if (
    !settings.companyEnabled ||
    !settings.enabled ||
    !SUPPORTED_HSBC_MODES.includes(settings.mode)
  ) {
    throw new PayoutBusinessError('HSBC payout is not enabled for store')
  }

  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url')
  const approvalRequired = requiresApproval(settings, amount)
  const expiresAt = new Date(
    Date.now() + settings.customerLinkExpiryMinutes * 60 * 1000,
  )
  const payout = await BuybackPayout.create({
    leadId: lead._id,
    companyId: lead.companyId || lead.userId?.companyId,
    storeId: lead.storeId,
    initiatedBy,
    amount,
    provider: settings.mode,
    statusMessage: ['HSBC_IMPS', 'HSBC_NEFT'].includes(settings.mode)
      ? 'Waiting for the customer to provide bank account details.'
      : 'Waiting for the customer to provide a UPI ID.',
    customerLinkTokenHash: tokenHash(token),
    customerLinkExpiresAt: expiresAt,
    approval: {
      required: approvalRequired,
      threshold: settings.approvalThreshold,
      status: approvalRequired ? 'PENDING' : 'NOT_REQUIRED',
    },
  })
  const notification = {
    delivered: false,
    pendingUserAction: true,
    reason: 'Waiting for the lead generator to send the payout link',
  }

  await leads.findByIdAndUpdate(lead._id, {
    payoutId: payout._id,
    payoutStatus: payout.status,
    payoutAmount: amount,
    $push: {
      history: {
        action: 'HSBC UPI payout link created',
        performedBy: initiatedBy,
        changes: { payoutId: payout._id, amount },
      },
    },
  })

  return { payout, paymentLink: null, notification }
}

export const approvePayout = async ({
  payoutId,
  actorId,
  approved,
  remarks,
}) => {
  const decision = validateApprovalDecision({ approved, remarks })
  const payout = await BuybackPayout.findById(payoutId)
  if (!payout) {
    throw new PayoutBusinessError(PAYOUT_NOT_FOUND_MESSAGE, 404)
  }
  await assertPayoutAccess(payout, actorId, { approver: true })
  if (payout.status !== PAYOUT_STATUS.PENDING_APPROVAL) {
    throw new PayoutBusinessError('Payout is not awaiting approval')
  }
  const decidedAt = new Date()
  const decided = await BuybackPayout.findOneAndUpdate(
    {
      _id: payout._id,
      status: PAYOUT_STATUS.PENDING_APPROVAL,
      'approval.status': 'PENDING',
    },
    {
      $set: {
        'approval.status': decision.approved ? 'APPROVED' : 'REJECTED',
        'approval.decidedBy': actorId,
        'approval.decidedAt': decidedAt,
        'approval.remarks': decision.remarks,
        status: decision.approved
          ? PAYOUT_STATUS.READY_FOR_PAYMENT
          : PAYOUT_STATUS.REJECTED,
        statusMessage: decision.approved
          ? 'Payout approved. The store can now make the payment.'
          : 'Payout rejected.',
      },
    },
    { new: true },
  )
  if (!decided) {
    throw new PayoutBusinessError(
      'This payout approval has already been decided',
      409,
    )
  }
  await Promise.all([
    syncLeadStatus(decided),
    leads.findByIdAndUpdate(decided.leadId, {
      $push: {
        history: {
          action: decision.approved
            ? 'HSBC UPI payout approved'
            : 'HSBC UPI payout rejected',
          performedBy: actorId,
          changes: {
            payoutId: decided._id,
            amount: decided.amount,
            remarks: decision.remarks,
          },
        },
      },
    }),
  ])
  await notifyPayoutDecision(decided, actorId, decision)
  return decided
}

export const resendPayoutLink = async ({ payoutId, actorId }) => {
  const payout = await BuybackPayout.findById(payoutId).select(
    '+beneficiaryVpaEncrypted +beneficiaryVpaHash +beneficiaryNameEncrypted +beneficiaryIfscEncrypted',
  )
  if (!payout) {
    throw new PayoutBusinessError(PAYOUT_NOT_FOUND_MESSAGE, 404)
  }
  await assertPayoutAccess(payout, actorId, { payer: true })
  await expireAwaitingPayoutIfNeeded(payout)
  assertCanResendPayout(payout)

  const settings = await getStorePayoutSettings(payout.storeId)
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url')
  if (payout.status === PAYOUT_STATUS.FAILED) {
    resetPayoutForRetry(payout)
  }
  payout.customerLinkTokenHash = tokenHash(token)
  payout.customerLinkExpiresAt = new Date(
    Date.now() + settings.customerLinkExpiryMinutes * 60 * 1000,
  )
  payout.status = PAYOUT_STATUS.AWAITING_VPA
  // Keep the prompt in step with the payout rail; a resend must not turn a bank
  // transfer back into a UPI request.
  payout.statusMessage = isBankTransferPayout(payout)
    ? 'Waiting for the customer to provide bank account details.'
    : 'Waiting for the customer to provide a UPI ID.'
  payout.linkNotificationState = 'NOT_SENT'
  payout.linkNotificationProviderRequestId = ''
  payout.linkNotificationError = ''
  await payout.save()

  const lead = await getLeadForNotification(payout)
  const paymentLink = paymentLinkForToken(token)
  const notification = await sendPayoutLinkNotification({
    mobileNumber: await decryptPII(lead?.phoneNumber),
    email: await decryptPII(lead?.emailId),
    customerName: await decryptPII(lead?.name),
    amount: payout.amount,
    device: lead?.modelId?.name || 'device',
    link: paymentLink,
  })
  payout.linkNotificationState = notification.delivered
    ? 'DELIVERED'
    : 'FAILED'
  payout.linkNotificationProviderRequestId =
    notification.providerRequestId || ''
  payout.linkNotificationError = notification.delivered
    ? ''
    : notification.reason || 'Notification provider rejected the request'
  payout.linkNotificationLastAttemptAt = new Date()
  await payout.save()
  await syncLeadStatus(payout)
  await leads.findByIdAndUpdate(payout.leadId, {
    $push: {
      history: {
        action:
          notification.delivered
            ? 'Customer payout link delivered'
            : 'Customer payout link delivery failed',
        performedBy: actorId,
        changes: {
          payoutId: payout._id,
          notificationChannel: notification.channel || '',
          recipientSource: notification.recipientSource || '',
        },
      },
    },
  })
  return { payout, paymentLink, notification }
}

export const makePayout = async ({ payoutId, actorId }) => {
  const payout = await BuybackPayout.findById(payoutId).select(
    '+beneficiaryVpaEncrypted',
  )
  if (!payout) {
    throw new PayoutBusinessError(PAYOUT_NOT_FOUND_MESSAGE, 404)
  }
  await assertPayoutAccess(payout, actorId, { payer: true })

  if (payout.status === PAYOUT_STATUS.SUCCESS) {
    await completeReceipt(payout)
    return payout
  }
  if (
    [PAYOUT_STATUS.PROCESSING, PAYOUT_STATUS.STATUS_UNKNOWN].includes(
      payout.status,
    )
  ) {
    throw new PayoutBusinessError(
      'Payment status must be checked before another attempt',
      409,
    )
  }
  if (
    payout.status !== PAYOUT_STATUS.READY_FOR_PAYMENT
  ) {
    throw new PayoutBusinessError('Payout is not ready for payment', 409)
  }

  const allowedStatus = payout.status
  const merchantOrderNo = payout.merchantOrderNo || numericReference()
  const claimed = await BuybackPayout.findOneAndUpdate(
    { _id: payout._id, status: allowedStatus },
    {
      status: PAYOUT_STATUS.PROCESSING,
      statusMessage: 'Payment request sent to HSBC.',
      merchantOrderNo,
      paymentClaimedBy: actorId,
      paymentClaimedAt: new Date(),
    },
    { new: true },
  ).select(
    '+beneficiaryVpaEncrypted +beneficiaryAccountNumberEncrypted +beneficiaryIfscEncrypted +beneficiaryNameEncrypted',
  )
  if (!claimed) {
    throw new PayoutBusinessError('Payout is already being processed', 409)
  }
  await syncLeadStatus(claimed)

  await dispatchPayout(claimed, merchantOrderNo, actorId)
  await completeReceipt(claimed)
  return claimed
}

export const refreshPayoutStatus = async ({ payoutId, actorId }) => {
  const payout = await BuybackPayout.findById(payoutId)
  if (!payout) {
    throw new PayoutBusinessError(PAYOUT_NOT_FOUND_MESSAGE, 404)
  }
  await assertPayoutAccess(payout, actorId)
  if (!payout.merchantOrderNo) {
    throw new PayoutBusinessError('Payment has not been initiated')
  }
  if (payout.status === PAYOUT_STATUS.SUCCESS) {
    await completeReceipt(payout)
    return payout
  }
  const enquired = await enquireBankTransferStatus(payout, actorId)
  if (enquired) {
    return enquired
  }
  const enquiryReference = numericEnquiryReference()
  let response
  try {
    response = await enquirePayout({
      merchantOrderNo: payout.merchantOrderNo,
      reference: enquiryReference,
      rrn: payout.providerTransactionRrn,
    })
  } catch (error) {
    payout.status = PAYOUT_STATUS.STATUS_UNKNOWN
    payout.statusMessage =
      error.status === 404
        ? 'HSBC status enquiry is currently unavailable. Do not retry the payment; check again after HSBC enables the enquiry API.'
        : 'HSBC could not confirm the payment status. Do not retry the payment; check status again later.'
    payout.lastStatusCheckedAt = new Date()
    payout.attempts.push({
      actorId,
      requestReference: enquiryReference,
      httpStatus: error.status,
      outcome:
        error.status === 404
          ? 'STATUS_ENDPOINT_UNAVAILABLE'
          : 'STATUS_TRANSPORT_ERROR',
      responseMessage: error.message,
    })
    await payout.save()
    await syncLeadStatus(payout)
    throw new PayoutBusinessError(payout.statusMessage, 502)
  }
  payout.attempts.push({
    actorId,
    requestReference: enquiryReference,
    httpStatus: response.httpStatus,
    outcome: `STATUS_${response.data?.transStatus || 'UNKNOWN'}`,
    responseCode: response.data?.respCode,
    responseMessage: response.data?.transMessage,
  })
  payout.lastStatusCheckedAt = new Date()
  await applyProviderResult(payout, response.data || {})
  await completeReceipt(payout)
  return payout
}

export const getPayoutForUser = async ({ payoutId, actorId }) => {
  const payout = await BuybackPayout.findById(payoutId)
  if (!payout) {
    throw new PayoutBusinessError(PAYOUT_NOT_FOUND_MESSAGE, 404)
  }
  await assertPayoutAccess(payout, actorId)
  return expireAwaitingPayoutIfNeeded(payout)
}

export const listPayoutsForUser = async ({ actorId, query = {} }) => {
  const actor = await loadActor(actorId)
  const filter = buildPayoutListFilter(actor, query, actorId)
  await applyPayoutSearch(filter, query)
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100)
  const page = Math.max(Number(query.page) || 1, 1)
  const [items, total] = await Promise.all([
    BuybackPayout.find(filter)
      .populate('leadId', 'uniqueCode modelId')
      .populate('storeId', 'storeName')
      .populate('initiatedBy', 'name email')
      .populate('paymentClaimedBy', 'name email')
      .populate('approval.decidedBy', 'name email')
      .populate('logistics.assignedBy', 'name email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    BuybackPayout.countDocuments(filter),
  ])
  return { items, total, page, limit }
}

/**
 * Apply an HSBC Payment Status Notification (webhook) to the matching payout.
 * Matches on the merchant order / provider reference carried in the PAIN002.
 */
export const applyStatusNotification = async ({ reference, statusCode }) => {
  const ref = String(reference || '').trim()
  if (!ref || !statusCode) {
    return null
  }
  const payout = await BuybackPayout.findOne({
    $or: [{ merchantOrderNo: ref }, { providerReferenceNo: ref }],
  })
  if (!payout || !isBankTransferPayout(payout)) {
    return null
  }
  await applyNeftResult(payout, {
    statusCode,
    statusDescription: `Status notification: ${statusCode}`,
    classification: classifyIsoStatus(statusCode),
    referenceId: ref,
  })
  await completeReceipt(payout)
  return payout
}

export const reconcileIncompletePayouts = async () => {
  const staleBefore = new Date(Date.now() - 2 * 60 * 1000)
  const payouts = await BuybackPayout.find({
    $or: [
      {
        status: {
          $in: [PAYOUT_STATUS.PROCESSING, PAYOUT_STATUS.STATUS_UNKNOWN],
        },
        updatedAt: { $lte: staleBefore },
        merchantOrderNo: { $exists: true, $ne: '' },
      },
      {
        status: PAYOUT_STATUS.SUCCESS,
        $or: [
          {
            receiptState: {
              $in: ['NOT_READY', 'FAILED', 'PROCESSING'],
            },
          },
          {
            successNotificationState: {
              $in: ['NOT_SENT', 'FAILED'],
            },
          },
        ],
        updatedAt: { $lte: staleBefore },
      },
    ],
  })
    .sort({ updatedAt: 1 })
    .limit(25)

  for (const payout of payouts) {
    try {
      await reconcilePayout(payout)
    } catch (error) {
      safeLog.error('Automated HSBC payout reconciliation failed', {
        payoutId: payout._id,
        message: error.message,
      })
    }
  }
  return payouts.length
}
