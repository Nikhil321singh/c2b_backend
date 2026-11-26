import erasureRequestModel from '../models/erasureRequestModel.js'
import userModel from '../models/UsersModel.js'
import leadsModel from '../models/leadsModel.js'
import devicesLotModel from '../models/devicesLotModel.js'
import quoteLogModel from '../models/QuoteLogModel.js'
import { safeLog } from '../utils/piiMasking.js'
import { auditLog } from '../middlewares/logSanitization.js'

const USER_AGENT_HEADER = 'user-agent'

// DPDP Act 2023 - Section 5.2: Right to Erasure
// Grace period: 30 days before actual deletion
const GRACE_PERIOD_DAYS = 30

/**
 * POST /api/erasure/request
 * Request data deletion (user or admin)
 */
export const requestErasure = async (req, res) => {
  try {
    const { userId, reason } = req.body
    const requestedBy = req.userId // From JWT token

    // Validate userId
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' })
    }

    // Check if user exists
    const user = await userModel.findById(userId)
    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Check if there's already a pending request
    const existingRequest = await erasureRequestModel.findOne({
      userId,
      status: 'PENDING',
    })

    if (existingRequest) {
      return res.status(400).json({
        error: 'A pending erasure request already exists for this user',
        request: {
          id: existingRequest._id,
          requestDate: existingRequest.requestDate,
          scheduledDeletionDate: existingRequest.scheduledDeletionDate,
        },
      })
    }

    // Calculate scheduled deletion date (30 days from now)
    const scheduledDeletionDate = new Date()
    scheduledDeletionDate.setDate(
      scheduledDeletionDate.getDate() + GRACE_PERIOD_DAYS,
    )

    // Create erasure request
    const erasureRequest = new erasureRequestModel({
      userId,
      userEmail: user.email,
      userPhone: user.phoneNumber,
      requestedBy,
      scheduledDeletionDate,
      reason,
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent: req.get(USER_AGENT_HEADER),
    })

    await erasureRequest.save()

    // Audit log
    auditLog('DATA_ERASURE_REQUESTED', {
      userId: requestedBy,
      action: 'REQUEST_DATA_ERASURE',
      targetUserId: userId,
      erasureRequestId: erasureRequest._id,
      scheduledDeletionDate,
      reason,
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent: req.get(USER_AGENT_HEADER),
    })

    safeLog.info(
      `Data erasure requested for user ${userId}, scheduled for ${scheduledDeletionDate.toISOString()}`,
    )

    return res.status(201).json({
      success: true,
      message: `Data erasure request created. Data will be permanently deleted on ${scheduledDeletionDate.toISOString()}`,
      request: {
        id: erasureRequest._id,
        requestDate: erasureRequest.requestDate,
        scheduledDeletionDate: erasureRequest.scheduledDeletionDate,
        gracePeriodDays: GRACE_PERIOD_DAYS,
      },
    })
  } catch (error) {
    safeLog.error('Error requesting data erasure:', error)
    return res.status(500).json({ error: error.message })
  }
}

/**
 * POST /api/erasure/cancel/:requestId
 * Cancel a pending erasure request (within grace period)
 */
export const cancelErasure = async (req, res) => {
  try {
    const { requestId } = req.params
    const { reason } = req.body
    const userId = req.userId

    const erasureRequest = await erasureRequestModel.findById(requestId)

    if (!erasureRequest) {
      return res.status(404).json({ error: 'Erasure request not found' })
    }

    if (erasureRequest.status !== 'PENDING') {
      return res.status(400).json({
        error: `Cannot cancel request with status: ${erasureRequest.status}`,
      })
    }

    // Update status to cancelled
    erasureRequest.status = 'CANCELLED'
    erasureRequest.cancellationDate = new Date()
    erasureRequest.cancellationReason = reason
    await erasureRequest.save()

    // Audit log
    auditLog('DATA_ERASURE_CANCELLED', {
      userId,
      action: 'CANCEL_DATA_ERASURE',
      erasureRequestId: requestId,
      targetUserId: erasureRequest.userId,
      cancellationReason: reason,
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent: req.get(USER_AGENT_HEADER),
    })

    safeLog.info(
      `Data erasure request ${requestId} cancelled by user ${userId}`,
    )

    return res.status(200).json({
      success: true,
      message: 'Erasure request cancelled successfully',
      request: {
        id: erasureRequest._id,
        status: erasureRequest.status,
        cancellationDate: erasureRequest.cancellationDate,
      },
    })
  } catch (error) {
    safeLog.error('Error cancelling erasure request:', error)
    return res.status(500).json({ error: error.message })
  }
}

/**
 * GET /api/erasure/status/:userId
 * Check erasure request status for a user
 */
export const getErasureStatus = async (req, res) => {
  try {
    const { userId } = req.params

    const requests = await erasureRequestModel
      .find({ userId })
      .sort({ requestDate: -1 })
      .populate('requestedBy', 'email role')
      .lean()

    return res.status(200).json({
      success: true,
      requests,
    })
  } catch (error) {
    safeLog.error('Error fetching erasure status:', error)
    return res.status(500).json({ error: error.message })
  }
}

/**
 * GET /api/erasure/pending
 * List all pending erasure requests (Admin only)
 */
export const getPendingRequests = async (req, res) => {
  try {
    const requests = await erasureRequestModel
      .find({ status: 'PENDING' })
      .sort({ scheduledDeletionDate: 1 })
      .populate('userId', 'email phoneNumber role')
      .populate('requestedBy', 'email role')
      .lean()

    return res.status(200).json({
      success: true,
      count: requests.length,
      requests,
    })
  } catch (error) {
    safeLog.error('Error fetching pending erasure requests:', error)
    return res.status(500).json({ error: error.message })
  }
}

/**
 * POST /api/erasure/execute/:requestId
 * Manually execute erasure (Admin only, or scheduled job)
 */
export const executeErasure = async (req, res) => {
  try {
    const { requestId } = req.params
    const executedBy = req.userId

    const erasureRequest = await erasureRequestModel.findById(requestId)

    if (!erasureRequest) {
      return res.status(404).json({ error: 'Erasure request not found' })
    }

    if (erasureRequest.status !== 'PENDING') {
      return res.status(400).json({
        error: `Cannot execute request with status: ${erasureRequest.status}`,
      })
    }

    // Check if grace period has elapsed (for manual execution by admin)
    const now = new Date()
    if (now < erasureRequest.scheduledDeletionDate) {
      return res.status(400).json({
        error: `Cannot execute before scheduled deletion date: ${erasureRequest.scheduledDeletionDate.toISOString()}`,
        gracePeriodRemaining: Math.ceil(
          (erasureRequest.scheduledDeletionDate - now) / (1000 * 60 * 60 * 24),
        ),
      })
    }

    // Execute deletion
    const deletionSummary = await performDataDeletion(erasureRequest.userId)

    // Update erasure request
    erasureRequest.status = 'COMPLETED'
    erasureRequest.completionDate = new Date()
    erasureRequest.deletedData = deletionSummary
    await erasureRequest.save()

    // Audit log
    auditLog('DATA_ERASURE_COMPLETED', {
      userId: executedBy,
      action: 'EXECUTE_DATA_ERASURE',
      erasureRequestId: requestId,
      targetUserId: erasureRequest.userId,
      deletionSummary,
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent: req.get(USER_AGENT_HEADER),
    })

    safeLog.info(
      `Data erasure completed for user ${erasureRequest.userId}: ${JSON.stringify(deletionSummary)}`,
    )

    return res.status(200).json({
      success: true,
      message: 'Data erasure completed successfully',
      deletionSummary,
    })
  } catch (error) {
    safeLog.error('Error executing data erasure:', error)
    return res.status(500).json({ error: error.message })
  }
}

/**
 * Helper: Perform actual data deletion across all collections
 */
async function performDataDeletion(userId) {
  const summary = {
    leads: 0,
    deviceLot: 0,
    quoteLogs: 0,
    user: false,
  }

  try {
    // Delete leads
    const leadsResult = await leadsModel.deleteMany({ userId })
    summary.leads = leadsResult.deletedCount || 0

    // Delete device lots. Lots sent from Customer Payouts belong to the paid
    // payout, not to the user who clicked "Send to Logistics", so they stay.
    const pickupResult = await devicesLotModel.deleteMany({
      userId,
      source: { $ne: 'PAYOUT' },
    })
    summary.deviceLot = pickupResult.deletedCount || 0

    // Delete quote logs
    const quoteResult = await quoteLogModel.deleteMany({ userId })
    summary.quoteLogs = quoteResult.deletedCount || 0

    // Delete user account (last)
    const userResult = await userModel.deleteOne({ _id: userId })
    summary.user = userResult.deletedCount === 1

    safeLog.info(`Data deletion summary for user ${userId}:`, summary)

    return summary
  } catch (error) {
    safeLog.error(`Error during data deletion for user ${userId}:`, error)
    throw error
  }
}

export default {
  requestErasure,
  cancelErasure,
  getErasureStatus,
  getPendingRequests,
  executeErasure,
}
