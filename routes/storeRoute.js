import express from 'express'
import storeController from '../controller/storeController.js'
import verifyToken from '../middlewares/authJwt.js'
import { authorizeCompanyAndStore } from '../middlewares/companyScopingMiddleware.js'
import { applyFieldLevelAccess } from '../middlewares/fieldLevelAccess.js'
import {
  encryptRequestPII,
  decryptResponsePII,
} from '../middlewares/piiEncryptionMiddleware.js'
import multer from 'multer'

const storage = multer.memoryStorage()

const fileFilter = (req, file, cb) => {
  const allowedMimes = [
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true)
  } else {
    cb(
      new Error('Invalid file type. Only .csv and .xlsx files are allowed.'),
      false,
    )
  }
}

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
})

const storeRoute = express.Router()

// Apply decryption middleware globally to all GET routes
storeRoute.use(decryptResponsePII)

storeRoute
  .post(
    '/create',
    verifyToken,
    authorizeCompanyAndStore,
    encryptRequestPII,
    storeController.create,
  )
  .put(
    '/edit',
    verifyToken,
    authorizeCompanyAndStore,
    encryptRequestPII,
    storeController.update,
  )
  .delete(
    '/deleteById',
    verifyToken,
    authorizeCompanyAndStore,
    storeController.deleteById,
  )
  .get(
    '/findById',
    verifyToken,
    authorizeCompanyAndStore,
    applyFieldLevelAccess,
    storeController.findById,
  ) // Masks address/phone for unauthorized roles
  .get(
    '/findAll',
    verifyToken,
    authorizeCompanyAndStore,
    applyFieldLevelAccess,
    storeController.findAll,
  ) // Masks address/phone for unauthorized roles
  .post(
    '/uploadStores',
    verifyToken,
    authorizeCompanyAndStore,
    upload.single('file'),
    storeController.uploadData,
  )
  .get(
    '/adminReport',
    verifyToken,
    authorizeCompanyAndStore,
    applyFieldLevelAccess,
    storeController.adminReport,
  ) // Masks PII in reports

export default storeRoute
