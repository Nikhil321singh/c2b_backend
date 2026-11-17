import express from 'express'
import verifyToken from '../middlewares/authJwt.js'
import ivsController from '../controller/ivsController.js'
import { imeiVerificationLimiter } from '../middlewares/rateLimiter.js'

const ivsRoute = express.Router()

ivsRoute.post(
  '/verify',
  verifyToken,
  imeiVerificationLimiter,
  ivsController.verifyImei,
)
export default ivsRoute
