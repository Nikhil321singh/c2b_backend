import express from 'express'
import verifyToken from '../middlewares/authJwt.js'
import storePaymentController from '../controller/storePaymentController.js'

const storePaymentRoute = express.Router()

storePaymentRoute
  .post('/requests', verifyToken, storePaymentController.create)
  .get('/', verifyToken, storePaymentController.list)
  .get('/:id', verifyToken, storePaymentController.findById)
  .post('/:id/flag', verifyToken, storePaymentController.flag)
  .post('/:id/unflag', verifyToken, storePaymentController.unflag)
  .post('/:id/mark-paid', verifyToken, storePaymentController.markPaid)

export default storePaymentRoute

