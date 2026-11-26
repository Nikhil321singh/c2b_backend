import mongoose from 'mongoose'

const { Schema } = mongoose

const addressSchema = new Schema(
  {
    name: { type: String, default: '' },
    address1: { type: String, default: '' },
    address2: { type: String, default: '' },
    address3: { type: String, default: '' },
    pincode: { type: String, default: '' },
    mobile: { type: String, default: '' },
    email: { type: String, default: '' },
  },
  { _id: false },
)

// One courier shipment booked with Blue Dart. Keeps the AWB and pickup token
// so the shipment can be tracked or cancelled later.
const logisticSchema = new Schema(
  {
    provider: {
      type: String,
      default: 'BLUEDART',
    },
    // Optional link to the sale this shipment carries.
    leadId: {
      type: Schema.Types.ObjectId,
      ref: 'leads',
      default: null,
      index: true,
    },
    // Our reference, sent to Blue Dart as CreditReferenceNo (max 20 chars).
    referenceId: {
      type: String,
      required: true,
      index: true,
    },
    awbNo: {
      type: String,
      required: true,
      unique: true,
    },
    pickupTokenNumber: {
      type: String,
      default: '',
    },
    pickupDate: {
      type: Date,
      default: null,
    },
    pickupRegistrationFailed: {
      type: Boolean,
      default: false,
    },
    pickupRegistrationError: {
      type: String,
      default: '',
    },
    // Shipping label PDF stored in S3 (key for signed links, URL for reference).
    labelKey: {
      type: String,
      default: '',
    },
    labelUrl: {
      type: String,
      default: '',
    },
    destinationArea: {
      type: String,
      default: '',
    },
    destinationLocation: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: ['CREATED', 'PICKUP_FAILED', 'CANCELLED'],
      default: 'CREATED',
      index: true,
    },
    pickupStatus: {
      type: String,
      enum: ['REGISTERED', 'FAILED', 'CANCELLED', ''],
      default: '',
    },
    // Latest scan reported by Blue Dart tracking, stored verbatim.
    trackingStatus: {
      type: String,
      default: '',
    },
    trackingStatusDate: {
      type: String,
      default: '',
    },
    expectedDeliveryDate: {
      type: String,
      default: '',
    },
    trackedAt: {
      type: Date,
      default: null,
    },
    pickup: addressSchema,
    drop: addressSchema,
    declaredValue: {
      type: Number,
      default: 0,
    },
    weight: {
      type: Number,
      default: 0,
    },
    pieceCount: {
      type: Number,
      default: 1,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'users',
      default: null,
    },
    cancelledBy: {
      type: Schema.Types.ObjectId,
      ref: 'users',
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
)

logisticSchema.index({ createdAt: -1 })

const logisticModel = mongoose.model('logistic', logisticSchema)

export default logisticModel
