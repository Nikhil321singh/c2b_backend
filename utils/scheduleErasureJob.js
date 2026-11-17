import cron from 'node-cron'
import erasureRequestModel from '../models/erasureRequestModel.js'
import userModel from '../models/UsersModel.js'
import leadsModel from '../models/leadsModel.js'
import devicesLotModel from '../models/devicesLotModel.js'
import quoteLogModel from '../models/QuoteLogModel.js'
import { safeLog } from './piiMasking.js'
import { auditLog } from '../middlewares/logSanitization.js'

/**
 * DPDP Act 2023 - Section 5.2: Right to Erasure
 * Scheduled job to automatically delete user data after grace period
 * Runs daily at 2:00 AM
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

    // Delete device lots
    const devicesLotResult = await devicesLotModel.deleteMany({ userId })
    summary.deviceLot = devicesLotResult.deletedCount || 0

    // Delete quote logs
    const quoteResult = await quoteLogModel.deleteMany({ userId })
    summary.quoteLogs = quoteResult.deletedCount || 0

    // Delete user account (last)
    const userResult = await userModel.deleteOne({ _id: userId })
    summary.user = userResult.deletedCount === 1

    return summary
  } catch (error) {
    safeLog.error(`Error during data deletion for user ${userId}:`, error)
    throw error
  }
}

async function processErasureRequests() {
  try {
    const now = new Date()

    // Find all pending requests where scheduled deletion date has passed
    const pendingRequests = await erasureRequestModel.find({
      status: 'PENDING',
      scheduledDeletionDate: { $lte: now },
    })

    if (pendingRequests.length === 0) {
      safeLog.info('No erasure requests ready for processing')
      return
    }

    safeLog.info(
      `Processing ${pendingRequests.length} erasure request(s) scheduled for deletion`,
    )

    for (const request of pendingRequests) {
      try {
        safeLog.info(
          `Processing erasure request ${request._id} for user ${request.userId}`,
        )

        // Perform data deletion
        const deletionSummary = await performDataDeletion(request.userId)

        // Update erasure request
        request.status = 'COMPLETED'
        request.completionDate = now
        request.deletedData = deletionSummary
        await request.save()

        // Audit log
        auditLog('DATA_ERASURE_COMPLETED', {
          action: 'SCHEDULED_DATA_ERASURE',
          erasureRequestId: request._id,
          targetUserId: request.userId,
          deletionSummary,
          automatedExecution: true,
        })

        safeLog.info(
          `Successfully completed erasure for user ${request.userId}: ${JSON.stringify(deletionSummary)}`,
        )
      } catch (error) {
        safeLog.error(
          `Failed to process erasure request ${request._id} for user ${request.userId}:`,
          error,
        )
        // Continue processing other requests even if one fails
      }
    }

    safeLog.info(
      `Completed processing ${pendingRequests.length} erasure request(s)`,
    )
  } catch (error) {
    safeLog.error('Error in processErasureRequests:', error)
  }
}

/**
 * Schedule the erasure job
 * Runs every day at 2:00 AM (server time)
 * Cron format: minute hour day month weekday
 */
export function scheduleErasureJob() {
  // Run at 2:00 AM every day
  const job = cron.schedule('0 2 * * *', async () => {
    safeLog.info('Starting scheduled erasure job')
    await processErasureRequests()
    safeLog.info('Completed scheduled erasure job')
  })

  safeLog.info('Erasure job scheduled: Runs daily at 2:00 AM')

  // Optionally run immediately on startup for testing (comment out in production)
  // processErasureRequests();

  return job
}

export default scheduleErasureJob
