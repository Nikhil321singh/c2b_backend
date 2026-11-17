import {
  encryptPIIFields,
  decryptPIIFields,
  decryptPIIFieldsArray,
  PII_FIELDS_TO_ENCRYPT,
} from '../utils/kmsEncryption.js'
import { safeLog } from '../utils/piiMasking.js'
import { auditLog } from './logSanitization.js'

async function decryptResponseData(data) {
  if (!data) {
    return data
  }

  if (!Array.isArray(data) && typeof data === 'object' && data._id) {
    return decryptPIIFields(data, PII_FIELDS_TO_ENCRYPT)
  }

  if (Array.isArray(data)) {
    return decryptPIIFieldsArray(data, PII_FIELDS_TO_ENCRYPT)
  }

  if (data.data && Array.isArray(data.data)) {
    return {
      ...data,
      data: await decryptPIIFieldsArray(data.data, PII_FIELDS_TO_ENCRYPT),
    }
  }

  if (data.result && Array.isArray(data.result)) {
    return {
      ...data,
      result: await decryptPIIFieldsArray(data.result, PII_FIELDS_TO_ENCRYPT),
    }
  }

  return data
}

function logPIIAccess(req, action, recordCount, resourceId) {
  if (!req.user) {
    return
  }

  auditLog('PII_ACCESS', {
    userId: req.user.id,
    userRole: req.user.role,
    action,
    resourceType: getResourceType(req.path),
    resourceId,
    recordCount,
    piiFields: PII_FIELDS_TO_ENCRYPT,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  })
}

const hasValue = (v) => v !== undefined && v !== null && v !== ''

export const uppercasePIIBeforeEncryption = (req, res, next) => {
  if (!req.body || Object.keys(req.body).length === 0) {
    return next()
  }
  PII_FIELDS_TO_ENCRYPT.forEach((field) => {
    if (req.body[field] && typeof req.body[field] === 'string') {
      req.body[field] = req.body[field].toUpperCase()
    }
  })
  return next()
}

export const encryptRequestPII = async (req, res, next) => {
  if (!req.body || Object.keys(req.body).length === 0) {
    return next()
  }

  try {
    // Find which PII fields are present in the request

    const piiFieldsPresent = PII_FIELDS_TO_ENCRYPT.filter((field) =>
      hasValue(req.body[field]),
    )
    if (piiFieldsPresent.length === 0) {
      return next() // No PII to encrypt
    }

    // Encrypt PII fields
    req.body = await encryptPIIFields(req.body, piiFieldsPresent)

    // Audit log
    auditLog('PII_ENCRYPTED', {
      userId: req.user?.id,
      userRole: req.user?.role,
      action: 'ENCRYPT_PII',
      encryptedFields: piiFieldsPresent,
      method: req.method,
      path: req.path,
      ipAddress: req.ip,
    })

    safeLog.info('PII fields encrypted in request', {
      fields: piiFieldsPresent.length,
      userId: req.user?.id,
      method: req.method,
      path: req.path,
    })

    return next()
  } catch (error) {
    safeLog.error('Failed to encrypt PII in request:', error)
    return res.status(500).json({
      error: 'Failed to process request',
      message: 'Internal server error while encrypting data',
    })
  }
}

export const decryptResponsePII = async (req, res, next) => {
  const originalJson = res.json.bind(res)

  res.json = async function (data) {
    try {
      const decryptedData = await decryptResponseData(data)

      if (data && req.user) {
        if (Array.isArray(data)) {
          logPIIAccess(req, 'VIEW_PII_LIST', data.length)
        } else if (data?._id) {
          logPIIAccess(req, 'VIEW_PII', null, data._id)
        } else if (data?.data && Array.isArray(data.data)) {
          logPIIAccess(req, 'VIEW_PII_LIST', data.data.length)
        }
      }

      return originalJson(decryptedData)
    } catch (error) {
      safeLog.error('Failed to decrypt PII in response:', error)

      return originalJson({
        error: 'Failed to retrieve data',
        message: 'Internal server error while decrypting data',
      })
    }
  }

  return next()
}

function getResourceType(path) {
  if (path.includes('/leads')) {
    return 'lead'
  }
  if (path.includes('/users')) {
    return 'user'
  }
  if (path.includes('/pickup')) {
    return 'pickup-device'
  }
  if (path.includes('/pending')) {
    return 'pending-device'
  }
  return 'unknown'
}

export const encryptSpecificFields = (fields) => {
  return async (req, res, next) => {
    if (!req.body || Object.keys(req.body).length === 0) {
      return next()
    }

    try {
      const fieldsPresent = fields.filter(
        (field) =>
          req.body[field] !== undefined &&
          req.body[field] !== null &&
          req.body[field] !== '',
      )

      if (fieldsPresent.length > 0) {
        req.body = await encryptPIIFields(req.body, fieldsPresent)

        // Audit log
        auditLog('PII_ENCRYPTED', {
          userId: req.user?.id,
          action: 'ENCRYPT_SPECIFIC_FIELDS',
          encryptedFields: fieldsPresent,
          ipAddress: req.ip,
        })
      }

      return next()
    } catch (error) {
      safeLog.error('Failed to encrypt specific fields:', error)
      return res.status(500).json({ error: 'Failed to process request' })
    }
  }
}

export const decryptSpecificFields = (fields) => {
  return async (req, res, next) => {
    const originalJson = res.json.bind(res)

    res.json = async function (data) {
      try {
        if (!data) {
          return originalJson(data)
        }

        const decryptedData = Array.isArray(data)
          ? await decryptPIIFieldsArray(data, fields)
          : await decryptPIIFields(data, fields)

        return originalJson(decryptedData)
      } catch (error) {
        safeLog.error('Failed to decrypt specific fields:', error)
        return originalJson({ error: 'Failed to retrieve data' })
      }
    }

    return next()
  }
}
