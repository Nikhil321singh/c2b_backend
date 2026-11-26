import mongoose from 'mongoose'
const { Schema } = mongoose

const leadsSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'users',
    },
    storeId: {
      type: Schema.Types.ObjectId,
      ref: 'store',
      index: true
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'company',
      index: true
    },
    QNA: {
      type: Array,
      required: true,
    },
    phoneNumber: {
      type: String,
      required: true,
    },
    aadharNumber: {
      type: String,
      required: true,
    },
    // Populated only when the Aadhaar number was entered manually (Aadhaar
    // verification off for the company, or DigiLocker verification failed)
    // instead of coming from a real DigiLocker verification, so there is an
    // audit trail explaining why it wasn't auto-verified.
    aadharVerificationReason: {
      type: String,
    },
    brandId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    modelId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: 'models',
    },
    price: {
      type: Number,
      required: true,
    },
    bonusPrice: {
      type: Number,
      default: 0,
    },
    slabBonusAmount: {
      type: Number,
      default: 0,
    },
    negotiatedAmount: {
      type: Number,
      default: 0,
    },
    slabApplied: {
      type: String,
      default: '',
    },
    couponDiscount: {
      type: Number,
      default: 0,
    },
    exactValue: {
      type: Number,
      default: 0,
    },
    quotedPrice: {
      type: Number,
      default: 0,
    },
    reason: {
      type: String,
    },
    is_selled: {
      type: Boolean,
      default: false,
    },
    soldAt: {
      type: Date,
      index: true,
    },
    name: {
      type: String,
      default: '',
    },
    storage: {
      type: String,
      default: '',
    },
    documentId: {
      type: Schema.Types.ObjectId,
      ref: 'documents',
    },
    gradeId: {
      type: Schema.ObjectId,
      ref: 'condtioncodes',
    },
    deviceReport: {
      type: Object,
      default: {}
    },
    actualPrice: {
      type: Number,
      default: 0,
    },
    reciept: {
      type: String,
      default: '',
    },
    payoutId: {
      type: Schema.Types.ObjectId,
      ref: 'buybackPayout',
      index: true,
    },
    payoutStatus: {
      type: String,
      default: '',
      index: true,
    },
    payoutAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    storePaymentRequestId: {
      type: Schema.Types.ObjectId,
      ref: 'devicesLot',
      index: true,
    },
    storePaymentStatus: {
      type: String,
      enum: ['', 'PAYMENT_REQUESTED', 'FLAGGED', 'PAYMENT_DONE'],
      default: '',
      index: true,
    },
    deviceIdentityHash: {
      type: String,
      select: false,
      index: true,
    },
    customerIdentityHash: {
      type: String,
      select: false,
      index: true,
    },
    ram: {
      type: String,
      required: true,
    },
    uniqueCode: {
      type: String,
      required: true,
      default: '',
      unique: true,
      sparse: true,
    },
    emailId: {
      type: String,
    },
    status: {
      type: String,
      default: 'Pending in QC',
    },
    tncVersion: {
      type: String,
      default: '',
    },
    history: [{
      action: String,
      performedBy: { type: Schema.Types.ObjectId, ref: 'users' },
      timestamp: { type: Date, default: Date.now },
      changes: Object
    }],
  },
  { timestamps: true }
)

// Performance optimization indexes for sold items queries
leadsSchema.index({ is_selled: 1, status: 1, createdAt: -1 })
leadsSchema.index({ storeId: 1, is_selled: 1, status: 1 })
leadsSchema.index({ companyId: 1, is_selled: 1 })
leadsSchema.index({ userId: 1, is_selled: 1 })
leadsSchema.index({ status: 1, createdAt: -1 })

// Search optimization indexes
leadsSchema.index({ phoneNumber: 1 })
leadsSchema.index({ emailId: 1 })
leadsSchema.index({ name: 1 })

const leadsModel = mongoose.model('leads', leadsSchema)

export default leadsModel
