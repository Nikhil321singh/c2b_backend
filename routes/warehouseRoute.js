import express from 'express'
import verifyToken from '../middlewares/authJwt.js'
import warehouseController from '../controller/warehouseController.js'
import { decryptResponsePII } from '../middlewares/piiEncryptionMiddleware.js'

const warehouseRoute = express.Router()

warehouseRoute
  .get('/leads', verifyToken, decryptResponsePII, warehouseController.list)
  .get(
    '/logistic-agents',
    verifyToken,
    decryptResponsePII,
    warehouseController.agents,
  )
  .post('/leads/:leadId/assign', verifyToken, warehouseController.assign)
  .post('/leads/:leadId/status', verifyToken, warehouseController.updateStatus)
  .post('/leads/:leadId/cancel', verifyToken, warehouseController.cancel)
  .post('/leads/:leadId/restore', verifyToken, warehouseController.restore)
  .post('/push-to-logistics', verifyToken, warehouseController.push)
  .post('/refresh-tracking', verifyToken, warehouseController.track)

export default warehouseRoute
