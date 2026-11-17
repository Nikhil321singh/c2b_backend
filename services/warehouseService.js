import mongoose from 'mongoose'
import leadsModel from '../models/leadsModel.js'
import usersModel from '../models/UsersModel.js'
import devicesLotModel from '../models/devicesLotModel.js'
import { ROLES } from '../middlewares/rbac.js'
import {
  CourierConfigurationError,
  courierConfigurationStatus,
  createCourierOrder,
  trackCourierShipments,
} from '../integrations/courier/courierClient.js'
import { safeLog } from '../utils/piiMasking.js'
import { uploadShippingLabelToS3 } from '../utils/invoiceHelpers.js'
import {
  emitNotification,
  NOTIFICATION_TYPES,
} from './notificationService.js'

export class WarehouseError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

const loadActor = async (actorId) => {
  const actor = await usersModel.findById(actorId).lean()
  if (!actor || actor.status === false) {
    throw new WarehouseError('User account is unavailable', 403)
  }
  return actor
}

const assertRole = (actor, roles, message) => {
  if (!roles.includes(actor.role)) {
    throw new WarehouseError(message, 403)
  }
}

const assertCompany = (actor, entityCompanyId) => {
  if (
    actor.role !== ROLES.SUPER_ADMIN &&
    String(actor.companyId) !== String(entityCompanyId)
  ) {
    throw new WarehouseError('Cannot access another company Warehouse', 403)
  }
}

const populateWarehouseLead = (query) =>
  query
    .populate('storeId', 'storeName storeId address contactNumber email region')
    .populate('companyId', 'name companyCode')
    .populate('logisticAgentId', 'name firstName lastName email phoneNumber role')
    .populate('logisticAssignedBy', 'name firstName lastName email role')
    .populate('modelId', 'name')

const historyEntry = (action, actorId, changes = {}) => ({
  action,
  performedBy: actorId,
  timestamp: new Date(),
  changes,
})

const tabFilter = (tab) => {
  switch (String(tab || '').toLowerCase()) {
    case 'unassigned':
      return { deliveryStatus: 'UNASSIGNED' }
    case 'assigned':
      return {
        deliveryStatus: {
          $in: ['OUT_FOR_PICKUP', 'PICKUP_COMPLETE', 'PUSHED_TO_LOGISTICS', 'DELIVERED'],
        },
      }
    case 'picked-up':
      return {
        deliveryStatus: {
          $in: ['OUT_FOR_PICKUP', 'PICKUP_COMPLETE'],
        },
      }
    case 'cancelled':
      return { deliveryStatus: 'CANCELLED' }
    default:
      return {}
  }
}

export const listWarehouseLeads = async ({ actorId, query = {} }) => {
  const actor = await loadActor(actorId)
  assertRole(
    actor,
    [
      ROLES.SUPER_ADMIN,
      ROLES.COMPANY_ADMIN,
      ROLES.WAREHOUSE_USER,
      ROLES.LOGISTIC_USER,
    ],
    'Your role cannot access the Warehouse',
  )
  const filter = {
    warehouseStatus: 'IN_WAREHOUSE',
    ...tabFilter(query.tab),
  }
  if (actor.role !== ROLES.SUPER_ADMIN) {
    filter.companyId = actor.companyId
  }
  if (actor.role === ROLES.LOGISTIC_USER) {
    filter.logisticAgentId = actor._id
    filter.deliveryStatus = {
      $in: ['OUT_FOR_PICKUP', 'PICKUP_COMPLETE', 'PUSHED_TO_LOGISTICS', 'DELIVERED'],
    }
  }
  const page = Math.max(Number(query.page) || 0, 0)
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100)
  const [items, total] = await Promise.all([
    populateWarehouseLead(
      leadsModel
        .find(filter)
        .sort({ updatedAt: -1 })
        .skip(page * limit)
        .limit(limit),
    ).lean(),
    leadsModel.countDocuments(filter),
  ])
  return { items, total, page, limit, courier: courierConfigurationStatus() }
}

export const listLogisticAgents = async ({ actorId }) => {
  const actor = await loadActor(actorId)
  assertRole(
    actor,
    [ROLES.SUPER_ADMIN, ROLES.COMPANY_ADMIN, ROLES.WAREHOUSE_USER],
    'Your role cannot list Logistic agents',
  )
  const filter = { role: ROLES.LOGISTIC_USER, status: true }
  if (actor.role !== ROLES.SUPER_ADMIN) {
    filter.companyId = actor.companyId
  }
  return usersModel
    .find(filter)
    .select('name firstName lastName email phoneNumber companyId')
    .sort({ name: 1 })
    .lean()
}

const loadLeadForAction = async (leadId) => {
  if (!mongoose.Types.ObjectId.isValid(leadId)) {
    throw new WarehouseError('Invalid lead ID')
  }
  const lead = await leadsModel.findById(leadId)
  if (!lead) {
    throw new WarehouseError('Warehouse lead not found', 404)
  }
  if (lead.warehouseStatus !== 'IN_WAREHOUSE') {
    throw new WarehouseError('Lead is not available in the Warehouse', 409)
  }
  return lead
}

// Notify the original payment requester (owner of the device lot) about a
// warehouse event on their lead. Side-effect only; never blocks the caller.
const notifyLotRequester = async (lead, { type, title, body, actorId }) => {
  if (!lead.storePaymentRequestId) {
    return
  }
  const lot = await devicesLotModel
    .findById(lead.storePaymentRequestId)
    .select('userId companyId')
    .lean()
  if (!lot?.userId) {
    return
  }
  await emitNotification({
    userId: lot.userId,
    companyId: lot.companyId || lead.companyId,
    type,
    title,
    body,
    entityType: 'lead',
    entityId: lead._id,
    createdBy: actorId,
  })
}

export const assignLogisticAgent = async ({
  actorId,
  leadId,
  logisticAgentId,
}) => {
  const [actor, lead] = await Promise.all([
    loadActor(actorId),
    loadLeadForAction(leadId),
  ])
  assertRole(
    actor,
    [ROLES.SUPER_ADMIN, ROLES.WAREHOUSE_USER],
    'Only a Warehouse User can assign Logistic agents',
  )
  assertCompany(actor, lead.companyId)
  if (!mongoose.Types.ObjectId.isValid(logisticAgentId)) {
    throw new WarehouseError('Invalid Logistic agent ID')
  }
  const agent = await usersModel.findOne({
    _id: logisticAgentId,
    companyId: lead.companyId,
    role: ROLES.LOGISTIC_USER,
    status: true,
  })
  if (!agent) {
    throw new WarehouseError(
      'Active Logistic agent was not found under this company',
      404,
    )
  }
  if (lead.deliveryStatus === 'CANCELLED') {
    throw new WarehouseError('Restore the cancelled lead before assignment', 409)
  }
  const previousAgent = lead.logisticAgentId
  lead.logisticAgentId = agent._id
  lead.logisticAssignedBy = actor._id
  lead.logisticAssignedAt = new Date()
  lead.deliveryStatus = 'OUT_FOR_PICKUP'
  lead.history.push(
    historyEntry('LOGISTIC_ASSIGNED', actor._id, {
      fromAgent: previousAgent,
      toAgent: agent._id,
      deliveryStatus: 'OUT_FOR_PICKUP',
    }),
  )
  await lead.save()
  // Notify the assigned Logistic User of the new pickup (side-effect only).
  await emitNotification({
    userId: agent._id,
    companyId: lead.companyId,
    type: NOTIFICATION_TYPES.LOGISTIC_ASSIGNMENT,
    title: 'New lead assigned to you',
    body: `Lead ${lead.uniqueCode || lead._id} is out for pickup.`,
    entityType: 'lead',
    entityId: lead._id,
    createdBy: actor._id,
  })
  return populateWarehouseLead(leadsModel.findById(lead._id)).lean()
}

export const updateDeliveryStatus = async ({
  actorId,
  leadId,
  deliveryStatus,
}) => {
  const [actor, lead] = await Promise.all([
    loadActor(actorId),
    loadLeadForAction(leadId),
  ])
  assertRole(
    actor,
    [ROLES.SUPER_ADMIN, ROLES.WAREHOUSE_USER],
    'Only a Warehouse User can update delivery status',
  )
  assertCompany(actor, lead.companyId)
  const allowedTransitions = {
    OUT_FOR_PICKUP: ['PICKUP_COMPLETE'],
    PICKUP_COMPLETE: ['DELIVERED'],
    PUSHED_TO_LOGISTICS: ['DELIVERED'],
  }
  if (!(allowedTransitions[lead.deliveryStatus] || []).includes(deliveryStatus)) {
    throw new WarehouseError(
      `Cannot move delivery from ${lead.deliveryStatus} to ${deliveryStatus}`,
      409,
    )
  }
  const previousStatus = lead.deliveryStatus
  lead.deliveryStatus = deliveryStatus
  lead.history.push(
    historyEntry('DELIVERY_STATUS_UPDATED', actor._id, {
      from: previousStatus,
      to: deliveryStatus,
    }),
  )
  await lead.save()
  if (deliveryStatus === 'DELIVERED') {
    await notifyLotRequester(lead, {
      type: NOTIFICATION_TYPES.LEAD_DELIVERED,
      title: 'Device delivered',
      body: `Lead ${lead.uniqueCode || lead._id} has been delivered.`,
      actorId: actor._id,
    })
  }
  return populateWarehouseLead(leadsModel.findById(lead._id)).lean()
}

export const cancelWarehouseLead = async ({ actorId, leadId, reason }) => {
  if (!String(reason || '').trim()) {
    throw new WarehouseError('Cancellation reason is required')
  }
  const [actor, lead] = await Promise.all([
    loadActor(actorId),
    loadLeadForAction(leadId),
  ])
  assertRole(
    actor,
    [ROLES.SUPER_ADMIN, ROLES.COMPANY_ADMIN, ROLES.WAREHOUSE_USER],
    'Your role cannot cancel Warehouse leads',
  )
  assertCompany(actor, lead.companyId)
  if (lead.deliveryStatus === 'DELIVERED') {
    throw new WarehouseError('A delivered lead cannot be cancelled', 409)
  }
  const previousStatus = lead.deliveryStatus
  lead.deliveryStatus = 'CANCELLED'
  lead.cancellation = {
    reason: String(reason).trim(),
    cancelledBy: actor._id,
    cancelledAt: new Date(),
  }
  lead.history.push(
    historyEntry('WAREHOUSE_CANCELLED', actor._id, {
      from: previousStatus,
      reason: String(reason).trim(),
    }),
  )
  await lead.save()
  // Let the assigned Logistic User know their pickup was cancelled.
  if (lead.logisticAgentId) {
    await emitNotification({
      userId: lead.logisticAgentId,
      companyId: lead.companyId,
      type: NOTIFICATION_TYPES.LEAD_CANCELLED,
      title: 'Assigned lead cancelled',
      body: `Lead ${lead.uniqueCode || lead._id} was cancelled: ${String(reason).trim()}`,
      entityType: 'lead',
      entityId: lead._id,
      createdBy: actor._id,
    })
  }
  return populateWarehouseLead(leadsModel.findById(lead._id)).lean()
}

export const restoreWarehouseLead = async ({ actorId, leadId }) => {
  const [actor, lead] = await Promise.all([
    loadActor(actorId),
    loadLeadForAction(leadId),
  ])
  assertRole(
    actor,
    [ROLES.SUPER_ADMIN, ROLES.COMPANY_ADMIN],
    'Only Company Admin or Super Admin can restore cancelled leads',
  )
  assertCompany(actor, lead.companyId)
  if (lead.deliveryStatus !== 'CANCELLED') {
    throw new WarehouseError('Only a cancelled lead can be restored', 409)
  }
  lead.deliveryStatus = 'UNASSIGNED'
  lead.logisticAgentId = undefined
  lead.logisticAssignedBy = undefined
  lead.logisticAssignedAt = undefined
  lead.cancellation.restoredBy = actor._id
  lead.cancellation.restoredAt = new Date()
  lead.history.push(
    historyEntry('WAREHOUSE_RESTORED', actor._id, {
      to: 'UNASSIGNED',
    }),
  )
  await lead.save()
  return populateWarehouseLead(leadsModel.findById(lead._id)).lean()
}

const courierPayload = (lead) => ({
  referenceId: lead.uniqueCode || String(lead._id),
  pickup: {
    storeId: lead.storeId?.storeId || String(lead.storeId?._id || lead.storeId),
    name: lead.storeId?.storeName || '',
    address: lead.storeId?.address || '',
    phone: lead.storeId?.contactNumber || '',
  },
  customer: {
    name: lead.name || '',
    phone: lead.phoneNumber || '',
    email: lead.emailId || '',
  },
  device: {
    model: lead.modelId?.name || '',
    amount: Number(lead.payoutAmount || lead.price || 0),
  },
})

const uploadCourierLabel = async (created, candidate) => {
  if (!created.labelContent) {
    return ''
  }
  try {
    return await uploadShippingLabelToS3(
      created.labelContent,
      candidate.uniqueCode || String(candidate._id),
    )
  } catch (error) {
    safeLog.error('Shipping label upload failed', error)
    return ''
  }
}

const pushCandidateToCourier = async (candidate, configuration, actor, now) => {
  try {
    const created = await createCourierOrder(courierPayload(candidate))
    const labelUrl = await uploadCourierLabel(created, candidate)
    await leadsModel.updateOne(
      { _id: candidate._id, deliveryStatus: 'PICKUP_COMPLETE' },
      {
        $set: {
          deliveryStatus: 'PUSHED_TO_LOGISTICS',
          courier: {
            provider: configuration.provider,
            orderId: created.orderId,
            status: created.providerStatus,
            pushedAt: now,
            lastAttemptAt: now,
            attempts: Number(candidate.courier?.attempts || 0) + 1,
            lastError: created.providerError || '',
            labelUrl,
            shipmentPickupDate: created.shipmentPickupDate || '',
          },
        },
        $push: {
          history: historyEntry('PUSHED_TO_LOGISTICS', actor._id, {
            courierOrderId: created.orderId,
            provider: configuration.provider,
          }),
        },
      },
    )
    return {
      leadId: candidate._id,
      success: true,
      orderId: created.orderId,
    }
  } catch (error) {
    const message =
      error instanceof CourierConfigurationError
        ? error.message
        : error.response?.data?.message || error.message
    // Log the message only: the axios error's config holds the courier auth
    // header and the account licence key in the request body.
    safeLog.error(`Courier order creation failed: ${message}`)
    await leadsModel.updateOne(
      { _id: candidate._id },
      {
        $set: {
          'courier.provider': configuration.provider,
          'courier.lastAttemptAt': now,
          'courier.lastError': message,
        },
        $inc: { 'courier.attempts': 1 },
        $push: {
          history: historyEntry('LOGISTICS_PUSH_FAILED', actor._id, {
            error: message,
          }),
        },
      },
    )
    return {
      leadId: candidate._id,
      success: false,
      error: message,
    }
  }
}

export const pushAssignedLeadsToCourier = async ({ actorId }) => {
  const actor = await loadActor(actorId)
  assertRole(
    actor,
    [ROLES.SUPER_ADMIN, ROLES.WAREHOUSE_USER],
    'Only a Warehouse User can push leads to Logistics',
  )
  const configuration = courierConfigurationStatus()
  if (!configuration.configured) {
    throw new WarehouseError(
      'Courier API is not configured. Assignment and tracking remain available.',
      503,
    )
  }
  const filter = {
    warehouseStatus: 'IN_WAREHOUSE',
    deliveryStatus: 'PICKUP_COMPLETE',
  }
  if (actor.role !== ROLES.SUPER_ADMIN) {
    filter.companyId = actor.companyId
    filter.logisticAssignedBy = actor._id
  }
  const candidates = await populateWarehouseLead(leadsModel.find(filter)).lean()
  const summary = { pushed: 0, failed: 0, results: [] }
  for (const candidate of candidates) {
    const now = new Date()
    const result = await pushCandidateToCourier(
      candidate,
      configuration,
      actor,
      now,
    )
    if (result.success) {
      summary.pushed += 1
    } else {
      summary.failed += 1
    }
    summary.results.push(result)
  }
  return summary
}


// Blue Dart's tracking servlet accepts comma-separated waybills; the documented
// per-call maximum has not been supplied, so batches are kept conservative.
const TRACKING_BATCH_SIZE = 25

/**
 * Refresh the latest courier scan for leads already pushed to Logistics and
 * record it on the lead. The raw courier status text is stored as-is; no
 * mapping onto GREST delivery statuses is applied.
 */
export const refreshCourierTracking = async ({ actorId }) => {
  const actor = await loadActor(actorId)
  assertRole(
    actor,
    [ROLES.SUPER_ADMIN, ROLES.WAREHOUSE_USER, ROLES.LOGISTIC_USER],
    'Only a Warehouse or Logistic User can refresh courier tracking',
  )
  const configuration = courierConfigurationStatus()
  if (!configuration.trackingConfigured) {
    throw new WarehouseError('Courier tracking is not configured', 503)
  }

  const filter = {
    deliveryStatus: 'PUSHED_TO_LOGISTICS',
    'courier.orderId': { $nin: [null, ''] },
  }
  if (actor.role !== ROLES.SUPER_ADMIN) {
    filter.companyId = actor.companyId
  }
  const leads = await leadsModel
    .find(filter)
    .select('_id uniqueCode courier')
    .lean()
  if (leads.length === 0) {
    return { tracked: 0, failed: 0, results: [] }
  }

  const byAwb = new Map(leads.map((lead) => [String(lead.courier.orderId), lead]))
  const awbNumbers = [...byAwb.keys()]
  const summary = { tracked: 0, failed: 0, results: [] }
  const now = new Date()

  for (let index = 0; index < awbNumbers.length; index += TRACKING_BATCH_SIZE) {
    const batch = awbNumbers.slice(index, index + TRACKING_BATCH_SIZE)
    let entries
    try {
      entries = await trackCourierShipments(batch)
    } catch (error) {
      safeLog.error(`Courier tracking request failed: ${error.message}`)
      summary.failed += batch.length
      summary.results.push(...batch.map((awbNo) => ({ awbNo, success: false })))
      continue
    }
    for (const entry of entries) {
      const lead = byAwb.get(String(entry.awbNo))
      if (!lead || !entry.status) {
        summary.failed += 1
        continue
      }
      await leadsModel.updateOne(
        { _id: lead._id },
        {
          $set: {
            'courier.trackingStatus': entry.status,
            'courier.trackedAt': now,
          },
        },
      )
      summary.tracked += 1
      summary.results.push({
        leadId: lead._id,
        awbNo: entry.awbNo,
        status: entry.status,
        success: true,
      })
    }
  }
  return summary
}
