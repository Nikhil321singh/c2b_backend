import mongoose from 'mongoose'

const PII_FIELDS = {
  aadhar: ['aadharNumber', 'aadhaarNumber', 'aadhar', 'aadhaar'],
  phone: ['phoneNumber', 'phone', 'mobile', 'mobileNumber', 'contactNumber'],
  email: ['email', 'emailId', 'emailAddress'],
  imei: ['imei', 'IMEI'],
  pan: ['panNumber', 'pan', 'PAN'],
  gst: ['gstNumber', 'gst', 'GST', 'GSTIN'],
  name: ['name', 'fullName', 'firstName', 'lastName'],
  address: ['address', 'fullAddress'],
}

function maskPIIValue(type, value) {
  switch (type) {
    case 'aadhar':
      return maskAadhaar(value)
    case 'phone':
      return maskPhone(value)
    case 'email':
      return maskEmail(value)
    case 'imei':
      return maskIMEI(value)
    case 'pan':
      return maskPAN(value)
    case 'gst':
      return maskGST(value)
    case 'name':
      return maskName(value)
    case 'address':
      return maskAddress(value)
    default:
      return value
  }
}

function detectPIIField(key) {
  for (const [type, fields] of Object.entries(PII_FIELDS)) {
    if (fields.includes(key)) {
      return type
    }
  }
  return null
}

function isSpecialObject(value) {
  return (
    value instanceof Date ||
    value instanceof mongoose.Types.ObjectId ||
    Buffer.isBuffer(value) ||
    value?._bsontype === 'ObjectId' ||
    value?.constructor?.name === 'ObjectId'
  )
}

export const maskAadhaar = (aadharNumber) => {
  if (!aadharNumber) {
    return ''
  }

  // Remove any spaces or hyphens
  const cleaned = String(aadharNumber).replace(/[\s-]/g, '')

  // Validate: must be 12 digits
  if (!/^\d{12}$/.test(cleaned)) {
    return aadharNumber // Return original if invalid
  }

  // Return full cleaned value
  return cleaned
}

export const maskPhone = (phoneNumber) => {
  if (!phoneNumber) {
    return ''
  }

  // Remove spaces, hyphens, parentheses
  const cleaned = String(phoneNumber).replace(/[\s\-()]/g, '')

  let countryCode
  let number = cleaned

  // Handle +countrycode format
  if (cleaned.startsWith('+')) {
    const match = cleaned.match(/^\+(\d{1,3})(\d+)$/)

    if (match) {
      countryCode = `+${match[1]}`
      number = match[2]
    }
  }
  // Handle 91XXXXXXXXXX
  else if (cleaned.startsWith('91') && cleaned.length === 12) {
    countryCode = '+91'
    number = cleaned.slice(2)
  }
  // Handle 0XXXXXXXXXX
  else if (cleaned.startsWith('0')) {
    countryCode = '+91'
    number = cleaned.slice(1)
  }

  // Default country code
  countryCode = countryCode || '+91'

  // Validate Indian number length
  if (!/^\d{10}$/.test(number)) {
    return phoneNumber // Return original if invalid
  }

  // Return full formatted value
  return `${countryCode} ${number}`
}

export const maskEmail = (email) => {
  if (!email) {
    return ''
  }

  const cleaned = String(email).trim()

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(cleaned)) {
    return email // Return original if invalid
  }

  // Return full email
  return cleaned
}

export const maskIMEI = (imei) => {
  if (!imei) {
    return ''
  }

  const cleaned = String(imei).replace(/[\s-]/g, '')

  // Validate: must be 14-15 digits
  if (!/^\d{14,15}$/.test(cleaned)) {
    return imei // Return original if invalid
  }

  // Return full cleaned value
  return cleaned
}

export const maskPAN = (pan) => {
  if (!pan) {
    return ''
  }

  const cleaned = String(pan).toUpperCase().trim()

  // Validate: must be 10 alphanumeric characters
  if (!/^[A-Z0-9]{10}$/.test(cleaned)) {
    return pan // Return original if invalid
  }

  // Return full cleaned value
  return cleaned
}

export const maskGST = (gst) => {
  if (!gst) {
    return ''
  }

  const cleaned = String(gst).toUpperCase().trim()

  // Validate: must be 15 alphanumeric characters
  if (!/^[A-Z0-9]{15}$/.test(cleaned)) {
    return gst // Return original if invalid
  }

  // Return full cleaned value
  return cleaned
}

export const maskName = (name) => {
  if (!name) {
    return ''
  }

  const cleaned = String(name).trim()
  const parts = cleaned.split(/\s+/)

  if (parts.length === 0) {
    return ''
  }

  if (parts.length === 1) {
    // Single name
    return `${parts[0][0]}. ****`
  }

  // Multiple parts - first initial + last name
  const firstInitial = parts[0][0]
  const lastName = parts[parts.length - 1]

  return `${firstInitial}. ${lastName}`
}

export const maskAddress = (address) => {
  if (!address) {
    return ''
  }

  if (typeof address === 'object') {
    // Address object
    const city = address.city || ''
    const state = address.state || ''
    return [city, state].filter(Boolean).join(', ')
  }

  // Address string - try to extract city and state
  const cleaned = String(address).trim()

  // Simple heuristic: return only last 2 comma-separated parts (usually city, state)
  const parts = cleaned.split(',').map((p) => p.trim())

  if (parts.length >= 2) {
    // Return last 2 parts (likely city and state)
    return parts.slice(-2).join(', ')
  }

  return '****' // Cannot extract city/state
}

function sanitizeValue(key, value, options, visited) {
  if (value === null || value === undefined) {
    return value
  }

  const piiType = detectPIIField(key)
  if (piiType) {
    return maskPIIValue(piiType, value)
  }

  if (typeof value === 'object') {
    return isSpecialObject(value)
      ? value
      : sanitizeObject(value, options, visited)
  }

  return value
}

export const sanitizeObject = (obj, options = {}, visited = new WeakSet()) => {
  if (!obj || typeof obj !== 'object' || isSpecialObject(obj)) {
    return obj
  }

  if (visited.has(obj)) {
    return '[Circular]'
  }
  visited.add(obj)

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, options, visited))
  }

  const sanitized = {}

  for (const key in obj) {
    sanitized[key] = sanitizeValue(key, obj[key], options, visited)
  }

  return sanitized
}

export const safeLog = {
  info: (...args) => {
    console.log(
      '[INFO]',
      ...args.map((arg) =>
        typeof arg === 'object' ? sanitizeObject(arg) : arg,
      ),
    )
  },

  warn: (...args) => {
    console.warn(
      '[WARN]',
      ...args.map((arg) =>
        typeof arg === 'object' ? sanitizeObject(arg) : arg,
      ),
    )
  },

  error: (...args) => {
    console.error(
      '[ERROR]',
      ...args.map((arg) =>
        typeof arg === 'object' ? sanitizeObject(arg) : arg,
      ),
    )
  },

  debug: (...args) => {
    if (process.env.NODE_ENV === 'development') {
      console.debug(
        '[DEBUG]',
        ...args.map((arg) =>
          typeof arg === 'object' ? sanitizeObject(arg) : arg,
        ),
      )
    }
  },
}

/**
 * Mask sensitive data in error messages
 *
 * @param {Error|string} error - Error object or message
 * @returns {string} Sanitized error message
 */
export const maskErrorMessage = (error) => {
  if (!error) {
    return ''
  }

  let message = error.message || String(error)

  // Regex patterns to detect and mask PII in error messages

  // Aadhaar (12 digits)
  message = message.replace(/\b\d{12}\b/g, 'XXXX XXXX XXXX')

  // Phone numbers (10 digits with optional country code)
  message = message.replace(/\b(\+91|91)?[-\s]?\d{10}\b/g, '+91 XXXXX XXXXX')

  // Email addresses
  message = message.replace(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    '***@***.com',
  )

  // IMEI (14-15 digits)
  message = message.replace(/\b\d{14,15}\b/g, 'IMEI_MASKED')

  return message
}

// Default export
export default {
  maskAadhaar,
  maskPhone,
  maskEmail,
  maskIMEI,
  maskPAN,
  maskGST,
  maskName,
  maskAddress,
  sanitizeObject,
  safeLog,
  maskErrorMessage,
}
