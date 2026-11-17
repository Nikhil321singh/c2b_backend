import express from 'express'
import rateLimit from 'express-rate-limit'
import verifyToken from '../middlewares/authJwt.js'
import buybackPayoutController from '../controller/buybackPayoutController.js'

const buybackPayoutRoute = express.Router()

const publicLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many attempts. Please try again later.',
  },
})

buybackPayoutRoute
  .get(
    '/public/:token',
    publicLinkLimiter,
    buybackPayoutController.customerDetails,
  )
  .post(
    '/public/:token/vpa',
    publicLinkLimiter,
    buybackPayoutController.customerSubmitVpa,
  )
  .post(
    '/public/:token/bank',
    publicLinkLimiter,
    buybackPayoutController.customerSubmitBankDetails,
  )
  .get('/', verifyToken, buybackPayoutController.list)
  .get(
    '/configuration-status',
    verifyToken,
    buybackPayoutController.configurationStatus,
  )
  .get('/:id', verifyToken, buybackPayoutController.findById)
  .post(
    '/:id/approval',
    verifyToken,
    buybackPayoutController.decideApproval,
  )
  .post('/:id/pay', verifyToken, buybackPayoutController.pay)
  .post(
    '/:id/resend-link',
    verifyToken,
    buybackPayoutController.resendLink,
  )
  .post(
    '/:id/status',
    verifyToken,
    buybackPayoutController.refreshStatus,
  )

export default buybackPayoutRoute
