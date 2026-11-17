import express from 'express'
import verifyToken from '../middlewares/authJwt.js'
import {
    sendAadhaarOtp,
    verifyAadhaarOtp,
} from '../controller/paysprintAadhaarController.js'

const paysprintAadhaarRoute = express.Router()

paysprintAadhaarRoute.post('/send-otp', verifyToken, sendAadhaarOtp)
paysprintAadhaarRoute.post('/verify-otp', verifyToken, verifyAadhaarOtp)

export default paysprintAadhaarRoute
