import mongoose from 'mongoose'
import notificationModel from '../models/notificationModel.js'
import { safeLog } from '../utils/piiMasking.js'

// Operational notification event types shown in the authenticated user inbox.
export const NOTIFICATION_TYPES = Object.freeze({
  STORE_PAYMENT_PAID: 'STORE_PAYMENT_PAID',
  STORE_PAYMENT_FLAGGED: 'STORE_PAYMENT_FLAGGED',
  PAYMENT_REQUEST_CREATED: 'PAYMENT_REQUEST_CREATED',
  PAYOUT_APPROVAL_DECIDED: 'PAYOUT_APPROVAL_DECIDED',
})

const NOTIFICATION_TYPE_VALUES = Object.values(NOTIFICATION_TYPES)

export const isValidNotificationType = (type) =>
  NOTIFICATION_TYPE_VALUES.includes(type)

export class NotificationError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

const asString = (value) => String(value ?? '').trim()

/**
 * Validate and normalise a notification into the shape stored on the model.
 * Pure (no I/O) so it can be unit tested. Throws when required fields are
 * missing or the type is unknown.
 */
export const buildNotification = (input = {}) => {
  const userId = input.userId
  if (!userId) {
    throw new NotificationError('notification userId is required')
  }
  const type = asString(input.type)
  if (!isValidNotificationType(type)) {
    throw new NotificationError(`Unknown notification type: ${type || '(empty)'}`)
  }
  const title = asString(input.title)
  if (!title) {
    throw new NotificationError('notification title is required')
  }

  return {
    userId,
    companyId: input.companyId || null,
    type,
    title,
    body: asString(input.body),
    entityType: asString(input.entityType),
    entityId: input.entityId || null,
    createdBy: input.createdBy || null,
  }
}

/**
 * Persist a single notification. Side-effect only: a failure is logged and
 * swallowed so it never breaks the caller's primary transaction.
 */
export const emitNotification = async (input) => {
  try {
    const doc = buildNotification(input)
    return await notificationModel.create(doc)
  } catch (error) {
    safeLog.error('Failed to emit notification', error)
    return null
  }
}

/**
 * Fan-out helper: emit one notification per input. Each is independently
 * guarded, so one bad entry never blocks the rest or the caller.
 */
export const emitNotifications = async (inputs = []) => {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return []
  }
  return Promise.all(inputs.map((input) => emitNotification(input)))
}

const toObjectId = (id) => new mongoose.Types.ObjectId(id)

/**
 * Build the recipient-scoped list filter. Pure and unit tested. A user can only
 * ever query their own notifications.
 */
export const buildListFilter = ({ actorId, unreadOnly = false }) => {
  const filter = { userId: toObjectId(actorId) }
  if (unreadOnly) {
    filter.read = false
  }
  return filter
}

export const listNotifications = async ({ actorId, query = {} }) => {
  const page = Math.max(parseInt(query.page, 10) || 0, 0)
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100)
  const filter = buildListFilter({
    actorId,
    unreadOnly: String(query.unread) === 'true',
  })

  const [items, total, unreadCount] = await Promise.all([
    notificationModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(page * limit)
      .limit(limit)
      .lean(),
    notificationModel.countDocuments(filter),
    notificationModel.countDocuments({ userId: toObjectId(actorId), read: false }),
  ])

  return { items, total, unreadCount, page, limit }
}

export const getUnreadCount = async ({ actorId }) => {
  const unreadCount = await notificationModel.countDocuments({
    userId: toObjectId(actorId),
    read: false,
  })
  return { unreadCount }
}

/**
 * Mark one notification read. Scoped to the caller, so a user cannot touch
 * another user's notification.
 */
export const markNotificationRead = async ({ actorId, notificationId }) => {
  if (!mongoose.Types.ObjectId.isValid(notificationId)) {
    throw new NotificationError('Invalid notification id')
  }
  const updated = await notificationModel.findOneAndUpdate(
    { _id: notificationId, userId: toObjectId(actorId) },
    { $set: { read: true, readAt: new Date() } },
    { new: true },
  )
  if (!updated) {
    throw new NotificationError('Notification not found', 404)
  }
  return updated
}

export const markAllNotificationsRead = async ({ actorId }) => {
  const result = await notificationModel.updateMany(
    { userId: toObjectId(actorId), read: false },
    { $set: { read: true, readAt: new Date() } },
  )
  return { modified: result.modifiedCount || 0 }
}
