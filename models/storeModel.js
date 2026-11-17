import mongoose from 'mongoose'
const { Schema } = mongoose

const storeSchema = new Schema(
  {
    storeId: {
      type: String,
      unique: true,
      sparse: true,
    },
    storeName: {
      type: String,
      required: true,
    },
    companyId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'company',
      index: true,
    },
    region: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: false,
    },
    uniqueId: {
      type: String,
      required: true,
    },
    contactNumber: {
      type: String,
      required: true,
    },
    address: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'users',
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'users',
    },
    payoutSettings: {
      enabled: {
        type: Boolean,
        default: false,
      },
      mode: {
        type: String,
        enum: ['MANUAL', 'HSBC_UPI', 'HSBC_IMPS', 'HSBC_NEFT'],
        default: 'MANUAL',
      },
      approvalEnabled: {
        type: Boolean,
        default: false,
      },
      approvalThreshold: {
        type: Number,
        min: 0,
        default: 0,
      },
      payoutCeiling: {
        type: Number,
        min: 0,
        default: 0,
      },
      customerLinkExpiryMinutes: {
        type: Number,
        min: 5,
        max: 1440,
        default: 30,
      },
    },
  },
  { timestamps: true }
)

// Performance optimization indexes
storeSchema.index({ storeName: 1 })
storeSchema.index({ companyId: 1, storeName: 1 })
storeSchema.index({ status: 1 })
storeSchema.index({ region: 1 })

const storeModel = mongoose.model('store', storeSchema)

export default storeModel
