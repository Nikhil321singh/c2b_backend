import express from 'express'
import companyController from '../controller/companyController.js'
import verifyToken from '../middlewares/authJwt.js'
import companyScopingMiddleware from '../middlewares/companyScopingMiddleware.js'
import { applyFieldLevelAccess } from '../middlewares/fieldLevelAccess.js'
import {
  encryptRequestPII,
  decryptResponsePII,
  uppercasePIIBeforeEncryption,
} from '../middlewares/piiEncryptionMiddleware.js'
import multer from 'multer'
const upload = multer({ storage: multer.memoryStorage() })

const companyRoute = express.Router()

// Apply decryption middleware globally to all GET routes
companyRoute.use(decryptResponsePII)

companyRoute
  .post(
    '/create',
    verifyToken,
    companyScopingMiddleware,
    uppercasePIIBeforeEncryption,
    encryptRequestPII,
    upload.array('files'),
    companyController.create,
  )
  .put(
    '/edit',
    verifyToken,
    companyScopingMiddleware,
    uppercasePIIBeforeEncryption,
    encryptRequestPII,
    upload.array('files'),
    companyController.update,
  )
  .delete(
    '/deleteById',
    verifyToken,
    companyScopingMiddleware,
    companyController.deleteById,
  )
  .get(
    '/findById',
    verifyToken,
    companyScopingMiddleware,
    applyFieldLevelAccess,
    companyController.findById,
  ) // Masks PAN/GST for unauthorized roles
  .get(
    '/findAll',
    verifyToken,
    companyScopingMiddleware,
    applyFieldLevelAccess,
    companyController.findAll,
  ) // Masks PAN/GST for unauthorized roles
  .post(
    '/uploadCompanies',
    verifyToken,
    companyScopingMiddleware,
    upload.single('file'),
    companyController.uploadData,
  )
  .post(
    '/bulk-toggle-aadhaar',
    verifyToken,
    companyController.bulkToggleAadharVerification,
  )
  .post(
    '/bulk-toggle-payout',
    verifyToken,
    companyController.bulkToggleBuybackPayout,
  )

export default companyRoute
