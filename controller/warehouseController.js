import {
  WarehouseError,
  assignLogisticAgent,
  cancelWarehouseLead,
  listLogisticAgents,
  listWarehouseLeads,
  pushAssignedLeadsToCourier,
  refreshCourierTracking,
  restoreWarehouseLead,
  updateDeliveryStatus,
} from '../services/warehouseService.js'
import { safeLog } from '../utils/piiMasking.js'

const sendError = (res, error) => {
  if (error instanceof WarehouseError) {
    return res
      .status(error.statusCode)
      .json({ success: false, message: error.message })
  }
  safeLog.error('Warehouse request failed', error)
  return res
    .status(500)
    .json({ success: false, message: 'Unable to process Warehouse request' })
}

const execute = (handler) => async (req, res) => {
  try {
    const data = await handler(req)
    return res.json({ success: true, data })
  } catch (error) {
    return sendError(res, error)
  }
}

export default {
  list: execute((req) =>
    listWarehouseLeads({ actorId: req.userId, query: req.query }),
  ),
  agents: execute((req) => listLogisticAgents({ actorId: req.userId })),
  assign: execute((req) =>
    assignLogisticAgent({
      actorId: req.userId,
      leadId: req.params.leadId,
      logisticAgentId: req.body.logisticAgentId,
    }),
  ),
  updateStatus: execute((req) =>
    updateDeliveryStatus({
      actorId: req.userId,
      leadId: req.params.leadId,
      deliveryStatus: req.body.deliveryStatus,
    }),
  ),
  cancel: execute((req) =>
    cancelWarehouseLead({
      actorId: req.userId,
      leadId: req.params.leadId,
      reason: req.body.reason,
    }),
  ),
  restore: execute((req) =>
    restoreWarehouseLead({
      actorId: req.userId,
      leadId: req.params.leadId,
    }),
  ),
  push: execute((req) =>
    pushAssignedLeadsToCourier({ actorId: req.userId }),
  ),
  track: execute((req) => refreshCourierTracking({ actorId: req.userId })),
}

