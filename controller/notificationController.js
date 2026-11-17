import { safeLog } from '../utils/piiMasking.js'
import {
  listNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from '../services/notificationService.js'

const sendError = (res, error) => {
  const statusCode = error?.statusCode || 500
  if (statusCode >= 500) {
    safeLog.error('Notification request failed', error)
  }
  return res.status(statusCode).json({
    success: false,
    message:
      statusCode >= 500
        ? 'Unable to process notification request'
        : error.message,
  })
}

const list = async (req, res) => {
  try {
    const data = await listNotifications({
      actorId: req.userId,
      query: req.query,
    })
    return res.json({ success: true, data })
  } catch (error) {
    return sendError(res, error)
  }
}

const unreadCount = async (req, res) => {
  try {
    const data = await getUnreadCount({ actorId: req.userId })
    return res.json({ success: true, data })
  } catch (error) {
    return sendError(res, error)
  }
}

const markRead = async (req, res) => {
  try {
    const data = await markNotificationRead({
      actorId: req.userId,
      notificationId: req.params.id,
    })
    return res.json({ success: true, message: 'Notification marked read', data })
  } catch (error) {
    return sendError(res, error)
  }
}

const markAllRead = async (req, res) => {
  try {
    const data = await markAllNotificationsRead({ actorId: req.userId })
    return res.json({
      success: true,
      message: 'All notifications marked read',
      data,
    })
  } catch (error) {
    return sendError(res, error)
  }
}

export default { list, unreadCount, markRead, markAllRead }
