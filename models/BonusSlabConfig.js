import mongoose from 'mongoose'
const { Schema } = mongoose

const slabSchema = new Schema({
  minValue: {
    type: Number,
    required: true,
    min: 0
  },
  maxValue: {
    type: Number,
    required: true,
    min: 0
  },
  bonusAmount: {
    type: Number,
    required: true,
    min: 0
  }
}, { _id: false })

const auditLogEntrySchema = new Schema({
  timestamp: { type: Date, default: Date.now },
  userId: { type: Schema.Types.ObjectId, ref: 'users', required: true },
  action: {
    type: String,
    enum: ['Created', 'Updated', 'FeatureEnabled', 'FeatureDisabled', 'SlabUpdated', 'Deleted'],
    required: true
  },
  changes: { type: Object, default: {} }
}, { _id: false })

const bonusSlabConfigSchema = new Schema({
  companyId: {
    type: Schema.Types.ObjectId,
    ref: 'company',
    required: true,
    unique: true,
    index: true
  },
  isEnabled: {
    type: Boolean,
    default: false
  },
  slabs: {
    type: [slabSchema],
    default: []
  },
  effectiveFrom: {
    type: Date,
    default: Date.now
  },
  notes: {
    type: String,
    default: ''
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'users',
    required: true
  },
  updatedBy: {
    type: Schema.Types.ObjectId,
    ref: 'users'
  },
  auditLog: {
    type: [auditLogEntrySchema],
    default: []
  }
}, { timestamps: true })

bonusSlabConfigSchema.index({ isEnabled: 1, companyId: 1 })

const BonusSlabConfig = mongoose.model('bonusslabconfigs', bonusSlabConfigSchema)

export default BonusSlabConfig
