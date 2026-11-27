import BuybackPayout, { PAYOUT_STATUS } from '../../models/buybackPayoutModel.js'
import leads from '../../models/leadsModel.js'
import storeModel from '../../models/storeModel.js'
import UsersModel from '../../models/UsersModel.js'
import { encryptPII } from '../../utils/kmsEncryption.js'
import { validateVpa } from '../../integrations/hsbc/hsbcUpiClient.js'
import { sendPayoutApprovalNotification } from '../payoutNotificationService.js'
import {
  PayoutBusinessError,
  validateBankDetails,
  maskAccount,
  maskVpa,
  vpaHash,
  numericReference,
  publicPayout,
  tokenHash,
  UPI_VPA_PATTERN,
  isBankTransferPayout,
  ROLE_SUPER_ADMIN,
  ROLE_COMPANY_ADMIN,
  ROLE_MANAGER,
  ROLE_ADMIN_MANAGER,
  ROLE_ACCOUNTS_USER,
} from './validation.js'
import { syncLeadStatus } from './processing.js'

const findByCustomerToken = async (token) => {
  if (!token || token.length < 32) {
    throw new PayoutBusinessError('Invalid payment link', 404)
  }
  const payout = await BuybackPayout.findOne({
    customerLinkTokenHash: tokenHash(token),
  }).select('+customerLinkTokenHash')
  if (!payout) {
    throw new PayoutBusinessError('Payment link not found', 404)
  }
  await expireAwaitingPayoutIfNeeded(payout)
  return payout
}

const expireAwaitingPayoutIfNeeded = async (payout) => {
  if (
    payout.status === PAYOUT_STATUS.AWAITING_VPA &&
    payout.customerLinkExpiresAt <= new Date()
  ) {
    payout.status = PAYOUT_STATUS.EXPIRED
    payout.statusMessage = 'This payment link has expired.'
    await payout.save()
    await syncLeadStatus(payout)
  }
  return payout
}

export const getCustomerPayout = async (token) =>
  publicPayout(await findByCustomerToken(token))

const notifyPayoutApprovers = async (payout) => {
  const approvers = await UsersModel.find({
    status: true,
    $or: [
      { role: ROLE_SUPER_ADMIN },
      {
        role: { $in: [ROLE_COMPANY_ADMIN, ROLE_ACCOUNTS_USER] },
        companyId: payout.companyId,
      },
      {
        role: { $in: [ROLE_MANAGER, ROLE_ADMIN_MANAGER] },
        companyId: payout.companyId,
        $or: [
          { storeId: payout.storeId },
          { assignedStores: payout.storeId },
        ],
      },
    ],
  })
    .select('email')
    .lean()
  const [lead, store] = await Promise.all([
    leads.findById(payout.leadId).select('uniqueCode').lean(),
    storeModel.findById(payout.storeId).select('storeName').lean(),
  ])
  const notification = await sendPayoutApprovalNotification({
    recipients: approvers.map((approver) => approver.email),
    amount: payout.amount,
    leadCode: lead?.uniqueCode,
    storeName: store?.storeName,
  })
  payout.approval.notificationState = notification.delivered
    ? 'DELIVERED'
    : 'FAILED'
  payout.approval.notifiedAt = new Date()
  await payout.save()
}

const finalizeCustomerSubmission = async (
  payout,
  { statusMessageApproved, statusMessageReady, historyAction },
) => {
  payout.status =
    payout.approval?.status === 'PENDING'
      ? PAYOUT_STATUS.PENDING_APPROVAL
      : PAYOUT_STATUS.READY_FOR_PAYMENT
  payout.statusMessage =
    payout.status === PAYOUT_STATUS.PENDING_APPROVAL
      ? statusMessageApproved
      : statusMessageReady
  await payout.save()
  await syncLeadStatus(payout)
  await leads.findByIdAndUpdate(payout.leadId, {
    $push: {
      history: {
        action: historyAction,
        changes: {
          payoutId: payout._id,
          approvalRequired: payout.approval?.required,
        },
      },
    },
  })
  if (payout.status === PAYOUT_STATUS.PENDING_APPROVAL) {
    await notifyPayoutApprovers(payout)
  }
  return publicPayout(payout)
}

export const submitCustomerVpa = async ({ token, vpa }) => {
  const normalizedVpa = String(vpa || '').trim().toLowerCase()
  if (
    normalizedVpa.length > 255 ||
    !UPI_VPA_PATTERN.test(normalizedVpa)
  ) {
    throw new PayoutBusinessError('Enter a valid UPI ID')
  }
  const payout = await findByCustomerToken(token)
  if (payout.status === PAYOUT_STATUS.EXPIRED) {
    throw new PayoutBusinessError('Payment link has expired', 410)
  }
  if (payout.status !== PAYOUT_STATUS.AWAITING_VPA) {
    return publicPayout(payout)
  }

  const reference = numericReference()
  const validation = await validateVpa({ vpa: normalizedVpa, reference })
  const result = validation.data || {}
  if (result.valStatusCode !== 'VE') {
    throw new PayoutBusinessError(
      result.valStatusDesc || 'The UPI ID could not be verified',
      422,
    )
  }

  payout.beneficiaryVpaEncrypted = await encryptPII(normalizedVpa)
  payout.beneficiaryVpaHash = vpaHash(normalizedVpa)
  payout.beneficiaryVpaMasked = maskVpa(normalizedVpa)
  payout.beneficiaryNameEncrypted = result.payerName
    ? await encryptPII(result.payerName)
    : ''
  payout.beneficiaryIfscEncrypted = result.ifsc
    ? await encryptPII(result.ifsc)
    : ''
  payout.vpaValidationReference = reference
  payout.vpaValidatedAt = new Date()
  payout.customerLinkSubmittedAt = new Date()
  return finalizeCustomerSubmission(payout, {
    statusMessageApproved: 'UPI ID verified. Waiting for payout approval.',
    statusMessageReady: 'UPI ID verified. The store can now make the payment.',
    historyAction: 'Customer UPI ID verified by HSBC',
  })
}

export const submitCustomerBankDetails = async ({
  token,
  accountNumber,
  ifsc,
  accountName,
}) => {
  const details = validateBankDetails({ accountNumber, ifsc, accountName })
  const payout = await findByCustomerToken(token)
  if (payout.status === PAYOUT_STATUS.EXPIRED) {
    throw new PayoutBusinessError('Payment link has expired', 410)
  }
  if (!isBankTransferPayout(payout)) {
    throw new PayoutBusinessError('This payout does not accept bank details', 409)
  }
  if (payout.status !== PAYOUT_STATUS.AWAITING_VPA) {
    return publicPayout(payout)
  }

  payout.beneficiaryAccountNumberEncrypted = await encryptPII(details.accountNumber)
  payout.beneficiaryAccountMasked = maskAccount(details.accountNumber)
  payout.beneficiaryIfscEncrypted = await encryptPII(details.ifsc)
  payout.beneficiaryNameEncrypted = await encryptPII(details.accountName)
  payout.customerLinkSubmittedAt = new Date()
  return finalizeCustomerSubmission(payout, {
    statusMessageApproved: 'Bank details received. Waiting for payout approval.',
    statusMessageReady: 'Bank details received. The store can now make the payment.',
    historyAction: 'Customer bank details received for IMPS payout',
  })
}

export { findByCustomerToken, expireAwaitingPayoutIfNeeded, notifyPayoutApprovers }
