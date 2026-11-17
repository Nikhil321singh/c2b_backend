import express from 'express'
import hsbcPaymentWebhookController from '../controller/hsbcPaymentWebhookController.js'

// HSBC-initiated callback (Payment Status Notification). No JWT: HSBC
// authenticates via the clientId/secret headers, validated in the controller.
const hsbcPaymentWebhookRoute = express.Router()

hsbcPaymentWebhookRoute.post(
  '/status-notification',
  hsbcPaymentWebhookController.receiveStatusNotification,
)

export default hsbcPaymentWebhookRoute
