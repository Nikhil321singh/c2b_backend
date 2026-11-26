import express from 'express'
import verifyToken from '../middlewares/authJwt.js'
import { checkRole, ROLES } from '../middlewares/rbac.js'
import { decryptResponsePII } from '../middlewares/piiEncryptionMiddleware.js'
import logisticsController from '../controller/logisticsController.js'
import logisticsBluedartController from '../controller/logisticsBluedartController.js'

const logisticsRoute = express.Router()

// Warehouse module: Super Admin and the Warehouse role only.
const warehouseAccess = [
  verifyToken,
  checkRole([ROLES.SUPER_ADMIN, ROLES.LOGISTICS_ADMIN]),
]

// Shared by the read/update pair and its POST alias.
const ITEM_PATH = '/items/:leadId'

logisticsRoute
  .get('/paid-leads', ...warehouseAccess, decryptResponsePII, logisticsController.paidLeads)
  .get('/filters', ...warehouseAccess, logisticsController.filterOptions)
  .get(ITEM_PATH, ...warehouseAccess, logisticsController.getItem)
  .patch(ITEM_PATH, ...warehouseAccess, logisticsController.updateItem)
  // POST alias: API Gateway's CORS preflight only allows GET/POST/OPTIONS.
  .post(ITEM_PATH, ...warehouseAccess, logisticsController.updateItem)
  .post('/items/:leadId/manual-booking', ...warehouseAccess, logisticsController.manualBooking)
  .post('/items/:leadId/status', ...warehouseAccess, logisticsController.updateStatus)
  .post('/items/:leadId/cancel', ...warehouseAccess, logisticsController.cancelShipment)
  .get('/items/:leadId/label', ...warehouseAccess, logisticsController.shipmentLabel)
  .post('/items/:leadId/track', ...warehouseAccess, logisticsBluedartController.trackShipmentStatus)
  .get('/items/:leadId/bluedart', ...warehouseAccess, logisticsBluedartController.bookingContext)
  .post('/items/:leadId/bluedart', ...warehouseAccess, logisticsBluedartController.bluedartBooking)
  .post('/bluedart/bulk', ...warehouseAccess, logisticsBluedartController.bluedartBulkBooking)
  .get('/bluedart/pincode/:pincode', ...warehouseAccess, logisticsBluedartController.pincodeServiceability)

export default logisticsRoute
