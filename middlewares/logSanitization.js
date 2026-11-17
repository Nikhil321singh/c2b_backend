import {
  sanitizeObject,
  maskErrorMessage,
  safeLog,
} from '../utils/piiMasking.js'

const USER_AGENT_HEADER = 'user-agent'
const ANONYMOUS_USER = 'anonymous'

const buildRequestLog = (req) => ({
  method: req.method,
  url: req.url,
  ip: req.ip || req.connection?.remoteAddress,
  userAgent: req.get(USER_AGENT_HEADER),
  userId: req.user?.id || req.session?.userId || ANONYMOUS_USER,
  timestamp: new Date().toISOString(),
})

const attachSanitizedData = (log, key, data) => {
  if (data && Object.keys(data).length > 0) {
    log[key] = sanitizeObject(data)
  }
}

const buildResponseLog = (req, res, duration) => ({
  method: req.method,
  url: req.url,
  statusCode: res.statusCode,
  duration: `${duration}ms`,
  userId: req.user?.id || req.session?.userId || ANONYMOUS_USER,
  timestamp: new Date().toISOString(),
})

const sanitizeErrorPayload = (data) => {
  try {
    const cloned = JSON.parse(JSON.stringify(data))
    return sanitizeObject(cloned)
  } catch {
    return 'Error serializing response data'
  }
}

const logResponseByStatus = (responseLog, statusCode) => {
  if (statusCode >= 500) {
    safeLog.error('Response (Server Error):', responseLog)
  } else if (statusCode >= 400) {
    safeLog.warn('Response (Client Error):', responseLog)
  } else {
    safeLog.info('Response (Success):', responseLog)
  }
}

export const logSanitizationMiddleware = (req, res, next) => {
  const startTime = Date.now()

  const requestLog = buildRequestLog(req)

  attachSanitizedData(requestLog, 'body', req.body)
  attachSanitizedData(requestLog, 'query', req.query)
  attachSanitizedData(requestLog, 'params', req.params)

  safeLog.info('Incoming Request:', requestLog)

  const originalSend = res.send
  const originalJson = res.json

  const handleResponse = (data, originalFn) => {
    const duration = Date.now() - startTime
    const responseLog = buildResponseLog(req, res, duration)

    if (res.statusCode >= 400) {
      responseLog.error = sanitizeErrorPayload(data)
    }

    logResponseByStatus(responseLog, res.statusCode)

    return originalFn.call(res, data)
  }

  res.send = function (data) {
    res.send = originalSend
    return handleResponse(data, originalSend)
  }

  res.json = function (data) {
    res.json = originalJson
    return handleResponse(data, originalJson)
  }

  next()
}

export const errorLoggerMiddleware = (err, req, res, next) => {
  const errorLog = {
    message: maskErrorMessage(err),
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    method: req.method,
    url: req.url,
    userId: req.user?.id || req.session?.userId || 'anonymous',
    ip: req.ip || req.connection.remoteAddress,
    timestamp: new Date().toISOString(),
  }

  // Sanitize request data
  if (req.body && Object.keys(req.body).length > 0) {
    errorLog.requestBody = sanitizeObject(req.body)
  }

  if (req.query && Object.keys(req.query).length > 0) {
    errorLog.requestQuery = sanitizeObject(req.query)
  }

  safeLog.error('Application Error:', errorLog)

  // Pass error to next middleware
  next(err)
}

/**
 * Override console methods to auto-sanitize PII
 *
 * WARNING: This is aggressive and should be used carefully
 * Only use in production to prevent accidental PII logging
 *
 * Usage:
 *   overrideConsoleMethods();
 */
export const overrideConsoleMethods = () => {
  const originalLog = console.log
  const originalError = console.error
  const originalWarn = console.warn
  const originalInfo = console.info

  console.log = (...args) => {
    const sanitizedArgs = args.map((arg) =>
      typeof arg === 'object' && arg !== null ? sanitizeObject(arg) : arg,
    )
    originalLog.apply(console, sanitizedArgs)
  }

  console.error = (...args) => {
    const sanitizedArgs = args.map((arg) => {
      if (arg instanceof Error) {
        return new Error(maskErrorMessage(arg))
      } else if (typeof arg === 'object' && arg !== null) {
        return sanitizeObject(arg)
      }
      return arg
    })
    originalError.apply(console, sanitizedArgs)
  }

  console.warn = (...args) => {
    const sanitizedArgs = args.map((arg) =>
      typeof arg === 'object' && arg !== null ? sanitizeObject(arg) : arg,
    )
    originalWarn.apply(console, sanitizedArgs)
  }

  console.info = (...args) => {
    const sanitizedArgs = args.map((arg) =>
      typeof arg === 'object' && arg !== null ? sanitizeObject(arg) : arg,
    )
    originalInfo.apply(console, sanitizedArgs)
  }

  console.debug = (...args) => {
    if (process.env.NODE_ENV === 'development') {
      const sanitizedArgs = args.map((arg) =>
        typeof arg === 'object' && arg !== null ? sanitizeObject(arg) : arg,
      )
      originalLog.apply(console, ['[DEBUG]', ...sanitizedArgs])
    }
  }
}

/**
 * Audit logger for sensitive operations
 *
 * This creates structured audit logs for compliance
 *
 * Usage:
 *   auditLog('PII_ACCESS', {
 *     userId: req.user.id,
 *     action: 'VIEW_AADHAAR',
 *     resourceId: leadId,
 *     piiFields: ['aadharNumber'],
 *     justification: 'Customer verification'
 *   });
 *
 * @param {string} eventType - Type of audit event
 * @param {object} details - Event details
 */
export const auditLog = (eventType, details) => {
  const auditEntry = {
    eventType,
    timestamp: new Date().toISOString(),
    ...details,
  }

  // Sanitize PII in audit log details (except for authorized fields)
  const sanitized = { ...auditEntry }

  // Don't sanitize certain audit-specific fields that need to be logged
  const preserveFields = [
    'userId',
    'resourceId',
    'action',
    'justification',
    'result',
  ]

  for (const key in sanitized) {
    if (!preserveFields.includes(key) && typeof sanitized[key] === 'object') {
      sanitized[key] = sanitizeObject(sanitized[key])
    }
  }

  safeLog.info('[AUDIT]', JSON.stringify(sanitized))
}

/**
 * Helper to check if a field contains PII
 *
 * @param {string} fieldName - Field name to check
 * @returns {boolean} True if field is likely PII
 */
export const isPIIField = (fieldName) => {
  const piiFieldPatterns = [
    /aadhar/i,
    /aadhaar/i,
    /phone/i,
    /mobile/i,
    /email/i,
    /imei/i,
    /pan/i,
    /gst/i,
    /password/i,
    /secret/i,
    /token/i,
    /otp/i,
    /signature/i,
    /photo/i,
    /image/i,
  ]

  return piiFieldPatterns.some((pattern) => pattern.test(fieldName))
}

// Default export
export default {
  logSanitizationMiddleware,
  errorLoggerMiddleware,
  overrideConsoleMethods,
  auditLog,
  isPIIField,
}
