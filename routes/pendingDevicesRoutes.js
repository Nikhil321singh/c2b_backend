import express from 'express'
import pendingDevicesController from '../controller/pendingDevicesController.js'
import verifyToken from '../middlewares/authJwt.js'
import companyScopingMiddleware from '../middlewares/companyScopingMiddleware.js'
import { applyFieldLevelAccess } from '../middlewares/fieldLevelAccess.js'
import {
  encryptRequestPII,
  decryptResponsePII,
} from '../middlewares/piiEncryptionMiddleware.js'

const pendingDevicesRoutes = express.Router()

pendingDevicesRoutes
  .get(
    '/all',
    verifyToken,
    companyScopingMiddleware,
    applyFieldLevelAccess,
    decryptResponsePII,
    pendingDevicesController.allDevices,
  ) //get all the leads which are selled
  .get(
    '/search',
    verifyToken,
    companyScopingMiddleware,
    applyFieldLevelAccess,
    decryptResponsePII,
    pendingDevicesController.searchDevice,
  )
  .post(
    '/update',
    verifyToken,
    encryptRequestPII,
    pendingDevicesController.updateStatus,
  ) //update the lead Status it take id array and status
  .post(
    '/updatereq',
    verifyToken,
    encryptRequestPII,
    pendingDevicesController.updateRequest,
  )
  .post(
    '/pickupreq',
    verifyToken,
    encryptRequestPII,
    pendingDevicesController.pickupRequest,
  ) /*takes leads id array as input and
   push them to devicesLOts schema's devicesList field and the id of that lot is new refrence id*/

export default pendingDevicesRoutes
