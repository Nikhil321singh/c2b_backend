import express from 'express'
import multer from 'multer'
import verifyToken from '../middlewares/authJwt.js'
import storePaymentController from '../controller/storePaymentController.js'

// Mark Paid accepts an optional receipt file (same as Pickup Confirm Payment).
const RECEIPT_MAX_BYTES = 10 * 1024 * 1024
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RECEIPT_MAX_BYTES, files: 1 },
})

const storePaymentRoute = express.Router()

storePaymentRoute
  .post('/requests', verifyToken, storePaymentController.create)
  .get('/', verifyToken, storePaymentController.list)
  .get('/:id', verifyToken, storePaymentController.findById)
  .post('/:id/flag', verifyToken, storePaymentController.flag)
  .post('/:id/unflag', verifyToken, storePaymentController.unflag)
  .post(
    '/:id/mark-paid',
    verifyToken,
    upload.single('paymentReceipt'),
    storePaymentController.markPaid,
  )

export default storePaymentRoute

