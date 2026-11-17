import express from 'express'
import leadsController from '../controller/leadsController.js'
import verifyToken from '../middlewares/authJwt.js'
import companyScopingMiddleware from '../middlewares/companyScopingMiddleware.js'
import { applyFieldLevelAccess } from '../middlewares/fieldLevelAccess.js'
import {
  encryptRequestPII,
  decryptResponsePII,
} from '../middlewares/piiEncryptionMiddleware.js'

const leadsRoute = express.Router()

leadsRoute
  .get(
    '/findAll',
    verifyToken,
    companyScopingMiddleware,
    applyFieldLevelAccess, // Register masking middleware first
    decryptResponsePII, // Register decryption middleware second (executes first)
    leadsController.findAll,
  )
  .get(
    '/findAllSelled',
    verifyToken,
    companyScopingMiddleware,
    applyFieldLevelAccess, // Register masking middleware first
    decryptResponsePII, // Register decryption middleware second (executes first)
    leadsController.findAllSelled,
  )
  .get(
    '/findLeadById',
    verifyToken,
    companyScopingMiddleware,
    applyFieldLevelAccess, // Register masking middleware first
    decryptResponsePII, // Register decryption middleware second (executes first)
    leadsController.findLeadById,
  )
  .get(
    '/findAll/ordercreated',
    verifyToken,
    companyScopingMiddleware,
    applyFieldLevelAccess, // Register masking middleware first
    decryptResponsePII, // Register decryption middleware second (executes first)
    leadsController.orderCreated,
  )
  .get(
    '/findAll/quotecreated',
    verifyToken,
    companyScopingMiddleware,
    applyFieldLevelAccess, // Register masking middleware first
    decryptResponsePII, // Register decryption middleware second (executes first)
    leadsController.QuoteCreated,
  )
  .post(
    '/Admincalculate',
    verifyToken,
    encryptRequestPII,
    applyFieldLevelAccess,
    leadsController.calculatePriceAdmin,
  )

export default leadsRoute
