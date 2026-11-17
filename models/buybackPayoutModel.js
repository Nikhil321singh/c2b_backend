import mongoose from 'mongoose'

const { Schema } = mongoose

export const PAYOUT_STATUS = Object.freeze({
  AWAITING_VPA: 'AWAITING_VPA',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  READY_FOR_PAYMENT: 'READY_FOR_PAYMENT',
  PROCESSING: 'PROCESSING',
  STATUS_UNKNOWN: 'STATUS_UNKNOWN',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
})

const providerAttemptSchema = new Schema(
  {
    attemptedAt: { type: Date, default: Date.now },
    actorId: { type: Schema.Types.ObjectId, ref: 'users' },
    requestReference: String,
    httpStatus: Number,
    outcome: String,
    responseCode: String,
    responseMessage: String,
  },
  { _id: false },
)

const buybackPayoutSchema = new Schema(
  {
    leadId: {
      type: Schema.Types.ObjectId,
      ref: 'leads',
      required: true,
      unique: true,
      index: true,
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'company',
      required: true,
      index: true,
    },
    storeId: {
      type: Schema.Types.ObjectId,
      ref: 'store',
      required: true,
      index: true,
    },
    initiatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'users',
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    currency: {
      type: String,
      enum: ['INR'],
      default: 'INR',
    },
    provider: {
      type: String,
      enum: ['HSBC_UPI', 'HSBC_IMPS', 'HSBC_NEFT'],
      default: 'HSBC_UPI',
    },
    status: {
      type: String,
      enum: Object.values(PAYOUT_STATUS),
      default: PAYOUT_STATUS.AWAITING_VPA,
      index: true,
    },
    statusMessage: {
      type: String,
      default: 'Waiting for the customer to provide a UPI ID.',
    },
    customerLinkTokenHash: {
      type: String,
      required: true,
      unique: true,
      select: false,
    },
    customerLinkExpiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    linkNotificationState: {
      type: String,
      enum: ['NOT_SENT', 'DELIVERED', 'FAILED'],
      default: 'NOT_SENT',
    },
    linkNotificationLastAttemptAt: Date,
    linkNotificationProviderRequestId: {
      type: String,
      default: '',
    },
    linkNotificationError: {
      type: String,
      default: '',
    },
    customerLinkSubmittedAt: Date,
    beneficiaryVpaEncrypted: {
      type: String,
      select: false,
    },
    beneficiaryVpaHash: {
      type: String,
      select: false,
    },
    beneficiaryVpaMasked: String,
    beneficiaryNameEncrypted: {
      type: String,
      select: false,
    },
    beneficiaryIfscEncrypted: {
      type: String,
      select: false,
    },
    beneficiaryAccountNumberEncrypted: {
      type: String,
      select: false,
    },
    beneficiaryAccountMasked: String,
    vpaValidationReference: String,
    vpaValidatedAt: Date,
    approval: {
      required: { type: Boolean, default: false },
      threshold: { type: Number, default: 0 },
      status: {
        type: String,
        enum: ['NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED'],
        default: 'NOT_REQUIRED',
      },
      decidedBy: { type: Schema.Types.ObjectId, ref: 'users' },
      decidedAt: Date,
      remarks: String,
      notificationState: {
        type: String,
        enum: ['NOT_SENT', 'DELIVERED', 'FAILED'],
        default: 'NOT_SENT',
      },
      notifiedAt: Date,
    },
    merchantOrderNo: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    providerReferenceNo: String,
    providerTransactionId: String,
    providerTransactionRrn: {
      type: String,
      index: true,
      sparse: true,
    },
    providerApprovalNo: String,
    providerResponseCode: String,
    providerStatus: String,
    providerMessage: String,
    paidAt: Date,
    failedAt: Date,
    lastStatusCheckedAt: Date,
    paymentClaimedBy: { type: Schema.Types.ObjectId, ref: 'users' },
    paymentClaimedAt: Date,
    attempts: {
      type: [providerAttemptSchema],
      default: [],
    },
    receiptState: {
      type: String,
      enum: ['NOT_READY', 'PROCESSING', 'COMPLETED', 'FAILED'],
      default: 'NOT_READY',
    },
    receiptUrl: String,
    receiptGeneratedAt: Date,
    successNotificationState: {
      type: String,
      enum: ['NOT_SENT', 'DELIVERED', 'FAILED'],
      default: 'NOT_SENT',
    },
    successNotificationLastAttemptAt: Date,
  },
  { timestamps: true },
)

const removeSensitiveFields = (_document, value) => {
  delete value.customerLinkTokenHash
  delete value.beneficiaryVpaEncrypted
  delete value.beneficiaryVpaHash
  delete value.beneficiaryNameEncrypted
  delete value.beneficiaryIfscEncrypted
  delete value.beneficiaryAccountNumberEncrypted
  return value
}

buybackPayoutSchema.set('toJSON', { transform: removeSensitiveFields })
buybackPayoutSchema.set('toObject', { transform: removeSensitiveFields })

buybackPayoutSchema.index({ companyId: 1, status: 1, createdAt: -1 })
buybackPayoutSchema.index({ storeId: 1, status: 1, createdAt: -1 })
buybackPayoutSchema.index({ initiatedBy: 1, createdAt: -1 })

const BuybackPayout = mongoose.model('buybackPayout', buybackPayoutSchema)

export default BuybackPayout
