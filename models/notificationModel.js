import mongoose from 'mongoose'

const { Schema } = mongoose

// In-app notification delivered to a single recipient user. Operational only;
// no customer PII or payment/bank details are stored here.
const notificationSchema = new Schema(
  {
    // Recipient.
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'users',
      required: true,
      index: true,
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'company',
      index: true,
    },
    type: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    body: {
      type: String,
      default: '',
    },
    // Loosely-typed reference to the subject of the notification.
    entityType: {
      type: String,
      default: '',
    },
    entityId: {
      type: Schema.Types.ObjectId,
      default: null,
    },
    read: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
      default: null,
    },
    // Actor whose action produced the notification, when applicable.
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'users',
      default: null,
    },
  },
  { timestamps: true },
)

// Recipient inbox, newest first, with unread filtering.
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 })

const notificationModel = mongoose.model('notification', notificationSchema)

export default notificationModel
