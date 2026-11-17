import express from 'express'
import sangeetaconfigController from '../controller/sangeetaconfigController.js'
import { decryptSpecificFields } from '../middlewares/piiEncryptionMiddleware.js'

const sangeetaconfigRoute = express.Router()

// Fields used in Sangeeta responses (includes renamed fields from aggregations)
const SANGEETA_PII_FIELDS = [
  'phoneNumber',
  'aadharNumber',
  'emailId',
  'IMEI',
  'imei',
  'imeiNo',
  'customerMobile',
  'mobile',
  'email',
  'aadhar',
  'panNumber',
  'gstNumber',
]

sangeetaconfigRoute
  .post('/valuation/estimate', sangeetaconfigController.getUpToValue)
  .get(
    '/transactions/completed',
    decryptSpecificFields(SANGEETA_PII_FIELDS),
    sangeetaconfigController.getAllLeadsComplete,
  )
  .get(
    '/devices/status',
    decryptSpecificFields(SANGEETA_PII_FIELDS),
    sangeetaconfigController.getAllDeviceStatus,
  )
  .post(
    '/getLeadByUniquecode',
    decryptSpecificFields(SANGEETA_PII_FIELDS),
    sangeetaconfigController.getLeadByUniqueCode,
  )

export default sangeetaconfigRoute
