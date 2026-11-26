import express from 'express'
import verifyToken from '../middlewares/authJwt.js'
import blueDartController from '../controller/blueDartController.js'

const blueDartRoute = express.Router()

blueDartRoute
  .get('/status', verifyToken, blueDartController.status)
  .get('/shipments', verifyToken, blueDartController.listShipments)
  .get('/shipments/:awbNo', verifyToken, blueDartController.getShipment)
  .get('/shipments/:awbNo/label', verifyToken, blueDartController.getShipmentLabel)
  .post('/create-shipment', verifyToken, blueDartController.createShipment)
  .post('/track', verifyToken, blueDartController.track)
  .post('/register-pickup', verifyToken, blueDartController.registerPickup)
  .post('/cancel-waybill', verifyToken, blueDartController.cancelWaybill)
  .post('/cancel-pickup', verifyToken, blueDartController.cancelPickup)

export default blueDartRoute
