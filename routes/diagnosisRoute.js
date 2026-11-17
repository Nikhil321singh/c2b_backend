import express from 'express'
import {
  createDiagnosisSession,
  getDiagnosisSession,
  updateDiagnosisSession,
  getBlanccoReport
} from '../controller/diagnosisController.js'
import authJwt from '../middlewares/authJwt.js'

const diagnosisRoute = express.Router()

// Create a new diagnosis session
diagnosisRoute.post('/session', authJwt, createDiagnosisSession)

// Poll the status of a diagnosis session
diagnosisRoute.get('/session/:sessionId', getDiagnosisSession)

// Update the status of a diagnosis session (typically called by the customer diagnostic app)
diagnosisRoute.post('/session/:sessionId/status', updateDiagnosisSession)

// Fetch Blancco report
diagnosisRoute.get('/report/:uuid', authJwt, getBlanccoReport)

export default diagnosisRoute
