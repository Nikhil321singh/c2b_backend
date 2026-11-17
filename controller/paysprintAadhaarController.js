import axios from 'axios'
import jwt from 'jsonwebtoken'

const GREST_WRAPPER_BASE_URL = 'https://grest.agbe.in/api'

const generatePaysprintToken = () => {
  const payload = {
    timestamp: Math.floor(Date.now() / 1000),
    partnerId: process.env.PAYSPRINT_PARTNER_ID,
    reqid: `${Date.now()}${Math.floor(Math.random() * 10)}`,
  }

  return jwt.sign(payload, process.env.PAYSPRINT_AUTHORISED_KEY, {
    algorithm: 'HS256',
  })
}

const getWrapperConfig = () => ({
  baseUrl: GREST_WRAPPER_BASE_URL,
  paysprintToken: generatePaysprintToken(),
  hasPaysprintConfig:
    !!process.env.PAYSPRINT_PARTNER_ID &&
    !!process.env.PAYSPRINT_AUTHORISED_KEY,
})

const getHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: 'grest_aadhaar_9f3XkL72QaPz8M1vTnR4Yb6HcD',
})

const validatePaysprintConfig = (config, res) => {
  if (config.hasPaysprintConfig) {
    return true
  }

  return res.status(500).json({
    success: false,
    message:
      'Configuration missing. Set PAYSPRINT_PARTNER_ID and PAYSPRINT_AUTHORISED_KEY',
  })
}

const isHtmlTimeout = (response) =>
  response.status === 408 ||
  (typeof response.data === 'string' &&
    response.data.includes('<!DOCTYPE html>'))

const buildRequestBody = (body, token) => ({
  ...body,
  token,
})

const makeWrapperRequest = async (url, body) =>
  axios.post(url, body, {
    headers: getHeaders(),
    timeout: 120000,
    validateStatus: (status) => status < 500,
  })

const handleOtpTimeout = (res) =>
  res.status(200).json({
    success: true,
    message: 'Something went wrong, Please try again after 5 minutes.',
    data: {
      note: 'Request processing may take longer than expected',
    },
  })

const handleVerifyTimeout = (res) =>
  res.status(200).json({
    success: false,
    message: 'Verification request timed out. Please try again.',
  })

const handleFailure = (res, payload, message) =>
  res.status(200).json({
    success: false,
    message: payload?.message || message,
    data: payload?.data,
    provider: payload?.provider,
  })

const handleSuccess = (res, payload) =>
  res.status(200).json({
    success: true,
    data: payload?.data,
    provider: payload?.provider,
  })

const handleCatchError = (error, res, message) =>
  res.status(error.response?.status || 500).json({
    success: false,
    message: error.response?.data?.message || message,
    error: error.response?.data || error.message,
  })

export const sendAadhaarOtp = async (req, res) => {
  try {
    const { id_number } = req.body
    const config = getWrapperConfig()

    if (!id_number || !/^\d{12}$/.test(String(id_number))) {
      return res.status(400).json({
        success: false,
        message: 'id_number must be a valid 12-digit Aadhaar number',
      })
    }

    const validationResult = validatePaysprintConfig(config, res)
    if (validationResult !== true) {
      return validationResult
    }

    const response = await makeWrapperRequest(
      `${config.baseUrl}/initiateAadhaar`,
      buildRequestBody(req.body, config.paysprintToken),
    )

    if (isHtmlTimeout(response)) {
      return handleOtpTimeout(res)
    }

    const payload = response.data || {}

    if (!payload.success) {
      return handleFailure(
        res,
        payload,
        'Failed to initiate Aadhaar verification',
      )
    }

    return handleSuccess(res, payload)
  } catch (error) {
    if (['ECONNABORTED', 'ETIMEDOUT'].includes(error.code)) {
      return handleOtpTimeout(res)
    }

    return handleCatchError(
      error,
      res,
      'Failed to initiate Aadhaar verification',
    )
  }
}

export const verifyAadhaarOtp = async (req, res) => {
  try {
    const { client_id, otp } = req.body
    const config = getWrapperConfig()

    if (!client_id || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: client_id, otp',
      })
    }

    const validationResult = validatePaysprintConfig(config, res)
    if (validationResult !== true) {
      return validationResult
    }

    const response = await makeWrapperRequest(
      `${config.baseUrl}/verifyAadhaar`,
      buildRequestBody(req.body, config.paysprintToken),
    )

    if (isHtmlTimeout(response)) {
      return handleVerifyTimeout(res)
    }

    const payload = response.data || {}

    if (!payload.success) {
      return handleFailure(res, payload, 'Failed to verify Aadhaar OTP')
    }

    return handleSuccess(res, payload)
  } catch (error) {
    if (['ECONNABORTED', 'ETIMEDOUT'].includes(error.code)) {
      return handleVerifyTimeout(res)
    }

    return handleCatchError(error, res, 'Failed to verify Aadhaar OTP')
  }
}
