import mongoose from 'mongoose'

const { Schema } = mongoose

const imeiVerificationLogSchema = new Schema(
  {
    imei1: {
      type: String,
      required: true,
    },
    imei2: {
      type: String,
      default: null,
    },
    deviceModel: {
      type: String,
      default: '',
    },
    storeId: {
      type: String,
      index: true,
    },
    agentId: {
      type: String,
      index: true,
    },
    leadId: {
      type: String,
      default: null,
    },
    imei1Status: {
      type: String,
      enum: ['CLEAN', 'BLOCKED', 'STOLEN', 'UNKNOWN', 'ERROR'],
      required: true,
    },
    imei2Status: {
      type: String,
      enum: ['CLEAN', 'BLOCKED', 'STOLEN', 'UNKNOWN', 'ERROR', null],
      default: null,
    },
    allowTransaction: {
      type: Boolean,
      required: true,
    },
    referenceId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    ivsRawResponse: {
      type: Schema.Types.Mixed,
      default: null,
    },
    verifiedAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
)

imeiVerificationLogSchema.index({ imei1: 1, verifiedAt: -1 })
imeiVerificationLogSchema.index({ storeId: 1, verifiedAt: -1 })
imeiVerificationLogSchema.index({ agentId: 1, verifiedAt: -1 })

const ImeiVerificationLog = mongoose.model(
  'imeiverificationlogs',
  imeiVerificationLogSchema,
)

export default ImeiVerificationLog
