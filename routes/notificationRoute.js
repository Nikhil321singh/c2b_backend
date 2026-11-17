import express from 'express'
import verifyToken from '../middlewares/authJwt.js'
import notificationController from '../controller/notificationController.js'

const notificationRoute = express.Router()

notificationRoute
  .get('/', verifyToken, notificationController.list)
  .get('/unread-count', verifyToken, notificationController.unreadCount)
  .post('/read-all', verifyToken, notificationController.markAllRead)
  .post('/:id/read', verifyToken, notificationController.markRead)

export default notificationRoute
