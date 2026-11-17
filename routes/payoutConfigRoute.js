import express from 'express'
import verifyToken from '../middlewares/authJwt.js'
import payoutConfigController from '../controller/payoutConfigController.js'

// Focused payout-configuration API (Super Admin + Company Admin). Read/update
// company buyback settings and per-store payout settings without driving the
// full company/store CRUD endpoints.
const payoutConfigRoute = express.Router()

payoutConfigRoute
  .get('/company', verifyToken, payoutConfigController.getCompany)
  .put('/company', verifyToken, payoutConfigController.updateCompany)
  .get('/stores/:storeId', verifyToken, payoutConfigController.getStore)
  .put('/stores/:storeId', verifyToken, payoutConfigController.updateStore)

export default payoutConfigRoute
