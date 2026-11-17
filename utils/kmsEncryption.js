import crypto from 'crypto'
import { safeLog } from './piiMasking.js'

let ENCRYPTION_CONFIG
try {
  const module = await import('../config/encryption.config.js')
  ENCRYPTION_CONFIG = module.default
} catch (err) {
  safeLog.error('[AES] ❌ Failed to load encryption.config.js')
  safeLog.error(
    '[AES]    Create config/encryption.config.js with encryption keys',
  )
  safeLog.error('[AES]    See utils/cryptoEncryption.js for required structure')
  ENCRYPTION_CONFIG = { keys: {} }
}

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // 96-bit IV recommended for GCM

function getActiveKey() {
  const keys = ENCRYPTION_CONFIG.keys || {}

  // Find active key
  const activeKeyId = Object.keys(keys).find((id) => keys[id].active)
  if (activeKeyId) {
    return {
      id: activeKeyId,
      key: Buffer.from(keys[activeKeyId].key, 'hex'),
    }
  }

  // Fallback to first key
  const firstKeyId = Object.keys(keys)[0]
  if (firstKeyId) {
    return {
      id: firstKeyId,
      key: Buffer.from(keys[firstKeyId].key, 'hex'),
    }
  }

  // No keys available
  throw new Error(
    'No encryption keys configured in config/encryption.config.js',
  )
}

/**
 * Get a specific encryption key by ID (for decryption with old keys).
 */
function getKeyById(keyId) {
  const keys = ENCRYPTION_CONFIG.keys || {}

  if (!keys[keyId]) {
    throw new Error(`Encryption key '${keyId}' not found in config`)
  }

  return Buffer.from(keys[keyId].key, 'hex')
}

function cloneMongoObject(data) {
  if (Array.isArray(data)) {
    return [...data]
  }

  const cloned = {}

  for (const key in data) {
    const value = data[key]

    if (!value) {
      cloned[key] = value
    } else if (value instanceof Date) {
      // Preserve Date objects as ISO strings
      cloned[key] = value.toISOString()
    } else if (
      typeof value === 'object' &&
      value.constructor &&
      value.constructor.name === 'ObjectId'
    ) {
      cloned[key] = value.toString()
    } else {
      cloned[key] = value
    }
  }

  return cloned
}

async function decryptTopLevelFields(data, decrypted, fields) {
  for (const field of fields) {
    if (typeof data[field] === 'string' && data[field]) {
      try {
        decrypted[field] = await decryptPII(data[field])
      } catch (error) {
        safeLog.error(`Failed to decrypt field: ${field}`, error)
        decrypted[field] = data[field]
      }
    }
  }
}

async function decryptNestedFields(obj, fields, visited) {
  const SKIP = ['userId', 'storeId', 'companyId', 'createdBy', 'updatedBy']

  for (const key in obj) {
    const value = obj[key]

    if (!value || typeof value !== 'object') {
      continue
    }
    if (SKIP.includes(key)) {
      continue
    }

    if (Array.isArray(value)) {
      obj[key] = await decryptPIIFieldsArray(value, fields, visited)
    } else {
      obj[key] = await decryptPIIFields(value, fields, visited)
    }
  }
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== ''
}

export async function encryptPII(plaintext) {
  if (!plaintext) {
    return null
  }

  const textToEncrypt = String(plaintext)

  try {
    const { id: keyId, key } = getActiveKey()
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
    const encrypted = Buffer.concat([
      cipher.update(textToEncrypt, 'utf8'),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()

    // Format: keyId:iv:tag:ciphertext (all base64)

    return [
      keyId,
      iv.toString('base64'),
      tag.toString('base64'),
      encrypted.toString('base64'),
    ].join(':')
  } catch (error) {
    safeLog.error('AES encryption failed:', error)
    throw new Error('Failed to encrypt data')
  }
}

export async function decryptPII(ciphertext) {
  if (!ciphertext) {
    return null
  }

  try {
    // Check if this looks like our encrypted format
    if (!isEncrypted(ciphertext)) {
      // Not encrypted — return as-is (legacy plaintext data)
      return ciphertext
    }
    // Parse format: keyId:iv:authTag:ciphertext
    const parts = ciphertext.split(':')
    if (parts.length !== 4) {
      safeLog.error('[AES] Invalid ciphertext format (expected 4 parts)')
      return ciphertext // Graceful fallback
    }
    const [keyId, ivB64, authTagB64, encryptedB64] = parts

    // Get the key that was used for encryption
    const key = getKeyById(keyId)

    const iv = Buffer.from(ivB64, 'base64')
    const tag = Buffer.from(authTagB64, 'base64')
    const encrypted = Buffer.from(encryptedB64, 'base64')

    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)

    // Decrypt
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ])

    return decrypted.toString('utf-8')
  } catch (error) {
    safeLog.error('AES decryption failed:', error)
    throw new Error('Failed to decrypt data')
  }
}

/**
 * Encrypt multiple PII fields in an object
 *
 * @param {Object} data - Object with PII fields
 * @param {Array<string>} fieldsToEncrypt - Array of field names to encrypt
 * @returns {Promise<Object>} Object with encrypted fields
 */
export async function encryptPIIFields(data, fieldsToEncrypt) {
  if (!data) {
    return data
  }

  const encrypted = { ...data }

  for (const field of fieldsToEncrypt) {
    if (hasValue(data[field])) {
      try {
        encrypted[field] = await encryptPII(data[field])
      } catch (error) {
        safeLog.error(`Failed to encrypt field: ${field}`, error)
        // CRITICAL: Do NOT save plaintext if encryption fails
        // This ensures DPDP compliance - fail securely
        throw new Error(
          `Failed to encrypt sensitive field: ${field}. Request rejected for security.`,
        )
      }
    }
  }

  return encrypted
}

/**
 * Decrypt multiple PII fields in an object
 *
 * @param {Object} data - Object with encrypted PII fields
 * @param {Array<string>} fieldsToDecrypt - Array of field names to decrypt
 * @param {Set} visited - Set to track visited objects (prevents circular references)
 * @returns {Promise<Object>} Object with decrypted fields
 */
export async function decryptPIIFields(
  data,
  fieldsToDecrypt,
  visited = new Set(),
) {
  if (!data || typeof data !== 'object') {
    return data
  }
  if (visited.has(data)) {
    return data
  }

  visited.add(data)

  const decrypted = cloneMongoObject(data)

  await decryptTopLevelFields(data, decrypted, fieldsToDecrypt)

  await decryptNestedFields(decrypted, fieldsToDecrypt, visited)

  return decrypted
}

/**
 * Decrypt PII fields in an array of objects
 *
 * @param {Array<Object>} dataArray - Array of objects with encrypted PII fields
 * @param {Array<string>} fieldsToDecrypt - Array of field names to decrypt
 * @param {Set} visited - Set to track visited objects (prevents circular references)
 * @returns {Promise<Array<Object>>} Array with decrypted objects
 */
export async function decryptPIIFieldsArray(
  dataArray,
  fieldsToDecrypt,
  visited = new Set(),
) {
  if (!Array.isArray(dataArray)) {
    return dataArray
  }

  const decryptedArray = []

  for (const item of dataArray) {
    const decrypted = await decryptPIIFields(item, fieldsToDecrypt, visited)
    decryptedArray.push(decrypted)
  }

  return decryptedArray
}

function isEncrypted(value) {
  if (typeof value !== 'string' || value.length < 50) {
    return false
  }

  const parts = value.split(':')
  if (parts.length !== 4) {
    return false
  }

  const [keyId, iv, authTag, ciphertext] = parts

  const base64Regex = /^[A-Za-z0-9+/]+=*$/

  return (
    /^[a-zA-Z0-9_-]+$/.test(keyId) &&
    base64Regex.test(iv) &&
    base64Regex.test(authTag) &&
    base64Regex.test(ciphertext)
  )
}

export const PII_FIELDS_TO_ENCRYPT = [
  'aadharNumber', // Aadhaar number (12 digits)
  'phoneNumber', // Phone number (10 digits)
  'emailId', // Email address
  'IMEI', // Device IMEI number (stored in documents collection)
  'imei', // Device IMEI number (projected alias in aggregation responses)
  'panNumber', // PAN number
  'gstNumber', // GST number
]

export function getEncryptionStatus(data, fields = PII_FIELDS_TO_ENCRYPT) {
  const status = {}

  for (const field of fields) {
    if (data[field]) {
      status[field] = isEncrypted(data[field]) ? 'encrypted' : 'plaintext'
    } else {
      status[field] = 'not_present'
    }
  }

  return status
}
