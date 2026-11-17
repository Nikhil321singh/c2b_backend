import express from 'express'
import pickupDevicesController from '../controller/pickupDevicesController.js'
import verifyToken from '../middlewares/authJwt.js'
import companyScopingMiddleware from '../middlewares/companyScopingMiddleware.js'
import multer from 'multer'
import { applyFieldLevelAccess } from '../middlewares/fieldLevelAccess.js'
import { decryptResponsePII } from '../middlewares/piiEncryptionMiddleware.js'

const upload = multer({ storage: multer.memoryStorage() })

const pickupDevicesRoute = express.Router()

pickupDevicesRoute
  .get(
    '/all',
    verifyToken,
    companyScopingMiddleware,
    applyFieldLevelAccess,
    decryptResponsePII,
    pickupDevicesController.allLots,
  )
  .get(
    '/search',
    verifyToken,
    companyScopingMiddleware,
    applyFieldLevelAccess,
    decryptResponsePII,
    pickupDevicesController.searchLots,
  )
  .get(
    '/history',
    verifyToken,
    companyScopingMiddleware,
    applyFieldLevelAccess,
    decryptResponsePII,
    pickupDevicesController.lotsHistory,
  )
  .post('/update', verifyToken, pickupDevicesController.updateStatus)
  .get(
    '/devices/:rid',
    verifyToken,
    applyFieldLevelAccess,
    decryptResponsePII,
    pickupDevicesController.devicesList,
  )
  .get(
    '/technicianReport',
    verifyToken,
    companyScopingMiddleware,
    applyFieldLevelAccess,
    decryptResponsePII,
    pickupDevicesController.technicianReport,
  )
  .put(
    '/updatePaymentReceipt/:id',
    verifyToken,
    upload.single('paymentReceipt'),
    pickupDevicesController.updatePaymentReceiptAndRemarks,
  )

export default pickupDevicesRoute
