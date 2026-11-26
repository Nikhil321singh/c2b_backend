import express from 'express'
import verifyToken from '../middlewares/authJwt.js'
import {
  generateAadhaarToken,
  initiateAadhaarSession,
  getAadhaarAccessToken,
  getAadhaarIssuedFiles,
  downloadAadhaarXml,
  verifyAadhaarViaDigiLocker,
} from '../controller/digilockerAadhaarController.js'

const digilockerAadhaarRoute = express.Router()

const generateTokenEndpoint = (req, res) => {
  try {
    const tokenData = generateAadhaarToken()
    return res.status(200).json({
      success: true,
      data: tokenData,
    })
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to generate token',
      error: error.message,
    })
  }
}

digilockerAadhaarRoute.post('/generate-token', verifyToken, generateTokenEndpoint)
digilockerAadhaarRoute.post('/initiate-session', verifyToken, initiateAadhaarSession)
digilockerAadhaarRoute.post('/access-token', verifyToken, getAadhaarAccessToken)
digilockerAadhaarRoute.post('/issued-files', verifyToken, getAadhaarIssuedFiles)
digilockerAadhaarRoute.post('/download-xml', verifyToken, downloadAadhaarXml)
digilockerAadhaarRoute.post('/verify-aadhaar', verifyToken, verifyAadhaarViaDigiLocker)

export default digilockerAadhaarRoute
