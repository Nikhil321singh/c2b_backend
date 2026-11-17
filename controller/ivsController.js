import Joi from 'joi'
import { safeLog } from '../utils/piiMasking.js'
import { auditLog } from '../middlewares/logSanitization.js'
import ImeiVerificationLog from '../models/ImeiVerificationLog.js'
import { verifyImeiWithIvs, IVS_STATUS } from '../utils/ivsService.js'

const verifyImeiSchema = Joi.object({
  imei1: Joi.string()
    .pattern(/^\d{15}$/)
    .required()
    .messages({
      'string.pattern.base': 'IMEI 1 must be exactly 15 numeric digits',
      'any.required': 'IMEI 1 is required',
    }),
  imei2: Joi.string()
    .pattern(/^\d{15}$/)
    .optional()
    .allow(null, '')
    .messages({
      'string.pattern.base': 'IMEI 2 must be exactly 15 numeric digits',
    }),
  deviceModel: Joi.string().max(200).optional().allow(null, ''),
  storeId: Joi.string().optional().allow(null, ''),
  agentId: Joi.string().optional().allow(null, ''),
  leadId: Joi.string().optional().allow(null, ''),
})

function buildVerificationResult(imeiResult, imei1, imei2) {
  const isClean =
    imeiResult.imei1Status === IVS_STATUS.CLEAN &&
    (!imei2 || imeiResult.imei2Status === IVS_STATUS.CLEAN)

  return {
    imei1Status: imeiResult.imei1Status,
    imei1CdotStatus: imeiResult.imei1CdotStatus,
    imei2Status: imeiResult.imei2Status,
    imei2CdotStatus: imeiResult.imei2CdotStatus,
    allowTransaction: isClean,
    verifiedAt: imeiResult.verifiedAt,
    referenceId: imeiResult.referenceId,
    message: imeiResult.message,
  }
}

async function logVerification(req, imeiResult, imei1, imei2, deviceModel, storeId, agentId) {
  try {
    const logEntry = new ImeiVerificationLog({
      imei1,
      imei2: imei2 || null,
      deviceModel: deviceModel || '',
      storeId,
      agentId,
      leadId: req.body.leadId || null,
      imei1Status: imeiResult.imei1Status,
      imei2Status: imeiResult.imei2Status || null,
      allowTransaction: imeiResult.allowTransaction,
      referenceId: imeiResult.referenceId,
      ivsRawResponse: imeiResult.rawResponse,
      verifiedAt: new Date(imeiResult.verifiedAt),
    })

    await logEntry.save()

    auditLog('IMEI_VERIFICATION', {
      userId: req.userId,
      action: 'IMEI_VERIFY',
      referenceId: imeiResult.referenceId,
      imei1Status: imeiResult.imei1Status,
      imei2Status: imeiResult.imei2Status,
      allowTransaction: imeiResult.allowTransaction,
      storeId,
    })

    return logEntry
  } catch (error) {
    safeLog.error('[IVS] Failed to save verification log', {
      referenceId: imeiResult.referenceId,
      error: error.message,
    })
    return null
  }
}

export async function verifyImei(req, res) {
  const startTime = Date.now()

  console.log('[IVS_DEBUG] Incoming request body:', JSON.stringify(req.body, null, 2))

  try {
    const { error, value } = verifyImeiSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    })

    if (error) {
      const errorMessages = error.details.map((d) => d.message)
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errorMessages,
      })
    }

    const { imei1, imei2, deviceModel } = value

    const storeId = req.body.storeId || req.storeId || req.storeName || ''
    const agentId = req.body.agentId || req.userId || ''

    if (imei2 && imei1 === imei2) {
      return res.status(400).json({
        success: false,
        message: 'IMEI 1 and IMEI 2 must be different',
      })
    }

    const imeiResult = await verifyImeiWithIvs({
      imei1,
      imei2: imei2 || null,
      deviceModel: deviceModel || null,
    })

    await logVerification(req, imeiResult, imei1, imei2, deviceModel, storeId, agentId)

    const response = buildVerificationResult(imeiResult, imei1, imei2)

    const duration = Date.now() - startTime
    safeLog.info('[IVS] Verification completed', {
      referenceId: response.referenceId,
      duration: `${duration}ms`,
      imei1Status: response.imei1Status,
      imei2Status: response.imei2Status,
      allowTransaction: response.allowTransaction,
    })

    return res.status(200).json({
      success: true,
      data: response,
    })
  } catch (error) {
    safeLog.error('[IVS] Verification controller error:', error.message)
    return res.status(500).json({
      success: false,
      message: 'An unexpected error occurred during IMEI verification',
    })
  }
}

export default {
  verifyImei,
}
