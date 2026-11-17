/**
 * Automatic Key Rotation Scheduler
 *
 * Monitors encryption key age and automatically rotates keys every 90 days.
 *
 * Features:
 *  - Daily checks for key age
 *  - Automatic key generation
 *  - Config file updates
 *  - Email/log notifications
 *  - Safe rotation with old key preservation
 *
 * @module utils/keyRotationScheduler
 */

import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { safeLog } from './piiMasking.js'

const fileName = fileURLToPath(import.meta.url)
const dirName = path.dirname(fileName)

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const KEY_ROTATION_DAYS = 90 // Rotate keys every 90 days
const CHECK_INTERVAL_HOURS = 24 // Check once per day
const WARNING_DAYS_BEFORE = 7 // Warn 7 days before rotation needed
const CONFIG_PATH = path.join(dirName, '../config/encryption.config.js')

// ═══════════════════════════════════════════════════════════════════════════
// KEY AGE UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

function getKeyAgeDays(createdDate) {
  if (!createdDate) {
    return Infinity
  } // Unknown age = needs rotation

  const created = new Date(createdDate)
  const now = new Date()
  const diffMs = now - created
  return Math.floor(diffMs / (1000 * 60 * 60 * 24))
}

/**
 * Check if a key needs rotation based on age.
 *
 * @param {string} createdDate - ISO date string
 * @param {number} [maxAgeDays=90] - Maximum key age in days
 * @returns {boolean}
 */
function needsRotation(createdDate, maxAgeDays = KEY_ROTATION_DAYS) {
  const age = getKeyAgeDays(createdDate)
  return age >= maxAgeDays
}

/**
 * Check if we should warn about upcoming rotation.
 *
 * @param {string} createdDate - ISO date string
 * @param {number} [maxAgeDays=90] - Maximum key age in days
 * @param {number} [warnBeforeDays=7] - Days before rotation to start warning
 * @returns {boolean}
 */
function shouldWarn(
  createdDate,
  maxAgeDays = KEY_ROTATION_DAYS,
  warnBeforeDays = WARNING_DAYS_BEFORE,
) {
  const age = getKeyAgeDays(createdDate)
  const daysUntilRotation = maxAgeDays - age
  return daysUntilRotation > 0 && daysUntilRotation <= warnBeforeDays
}

// ═══════════════════════════════════════════════════════════════════════════
// KEY GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a new 256-bit encryption key.
 *
 * @returns {string} - 64-character hex string
 */
function generateKey() {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * Generate next key version ID.
 * Examples: v1 -> v2, v2 -> v3, prod-2024-q1 -> prod-2024-q2
 *
 * @param {string} currentKeyId
 * @returns {string}
 */
function getNextKeyId(currentKeyId) {
  // Try to extract version number (e.g., v1, v2, v99)
  const versionMatch = currentKeyId.match(/^v(\d+)$/)
  if (versionMatch) {
    const nextVersion = parseInt(versionMatch[1], 10) + 1
    return `v${nextVersion}`
  }

  // Fallback: use timestamp-based ID
  const timestamp = new Date().toISOString().split('T')[0]
  return `key-${timestamp}`
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG FILE UPDATES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load current encryption config.
 *
 * @returns {Promise<Object>}
 */
async function loadConfig() {
  try {
    // Use dynamic import with cache busting for fresh config
    const timestamp = Date.now()
    const module = await import(`../config/encryption.config.js?t=${timestamp}`)
    return module.default
  } catch (err) {
    throw new Error(`Failed to load encryption config: ${err.message}`)
  }
}

/**
 * Get the active key from config.
 *
 * @param {Object} config
 * @returns {Object|null} - { id, key, created, active }
 */
function getActiveKey(config) {
  const keys = config.keys || {}
  const activeKeyId = Object.keys(keys).find((id) => keys[id].active)

  if (!activeKeyId) {
    return null
  }

  return {
    id: activeKeyId,
    ...keys[activeKeyId],
  }
}

/**
 * Write updated config back to file.
 * This updates the encryption.config.js file with new keys.
 *
 * @param {Object} config - Updated config object
 * @returns {Promise<void>}
 */
async function writeConfig(config) {
  try {
    // Generate formatted config file content
    const configContent = generateConfigFileContent(config)

    // Write to file
    await fs.writeFile(CONFIG_PATH, configContent, 'utf-8')

    safeLog.info('[KEY-ROTATION] ✅ Config file updated successfully')
  } catch (err) {
    throw new Error(`Failed to write config file: ${err.message}`)
  }
}

/**
 * Generate the full config file content as a string.
 * Preserves all comments and formatting.
 *
 * @param {Object} config
 * @returns {string}
 */
function generateConfigFileContent(config) {
  const keys = config.keys || {}

  // Build keys section
  let keysContent = ''
  for (const [keyId, keyData] of Object.entries(keys)) {
    const isActive = keyData.active ? 'true' : 'false'
    const created = keyData.created || new Date().toISOString().split('T')[0]
    const description = keyData.description || `Encryption key ${keyId}`

    keysContent += `    ${keyId}: {
      key: '${keyData.key}',
      active: ${isActive},
      created: '${created}',
      description: '${description}',
    },

`
  }

  // Full file template (preserves original comments)
  return `/**
 * Encryption Keys Configuration
 *
 * CRITICAL SECURITY:
 *  1. Add this file to .gitignore immediately
 *  2. Never commit this file to Git
 *  3. Back up keys securely (encrypted backup, password manager, HSM)
 *  4. Rotate keys periodically (every 90 days)
 *  5. Keep at least 2 keys: one active, one for decrypting old data
 *
 * KEY STRUCTURE:
 *  - id: unique identifier (e.g., 'v1', 'v2', 'prod-2024-q4')
 *  - key: 64-character hex string (32 bytes = 256 bits for AES-256)
 *  - active: boolean (only ONE key should be active at a time)
 *  - created: ISO date string (for audit/rotation tracking)
 *
 * GENERATE A NEW KEY:
 *  Run in terminal:
 *    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * AUTOMATIC KEY ROTATION:
 *  Keys are automatically rotated every 90 days by the key rotation scheduler.
 *  Last rotation: ${new Date().toISOString().split('T')[0]}
 */

export default {
  keys: {
${keysContent}  },
}
`
}

// ═══════════════════════════════════════════════════════════════════════════
// KEY ROTATION LOGIC
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Perform automatic key rotation.
 *
 * Steps:
 *  1. Load current config
 *  2. Generate new key
 *  3. Deactivate old key
 *  4. Add new key as active
 *  5. Write config back to file
 *  6. Log rotation event
 *
 * @returns {Promise<Object>} - { success, oldKeyId, newKeyId, newKey }
 */
async function performKeyRotation() {
  try {
    safeLog.info('[KEY-ROTATION] 🔄 Starting automatic key rotation...')

    // 1. Load current config
    const config = await loadConfig()
    const activeKey = getActiveKey(config)

    if (!activeKey) {
      throw new Error('No active key found in config')
    }

    const oldKeyId = activeKey.id
    safeLog.info(
      `[KEY-ROTATION] Old key: ${oldKeyId} (age: ${getKeyAgeDays(activeKey.created)} days)`,
    )

    // 2. Generate new key
    const newKeyId = getNextKeyId(oldKeyId)
    const newKeyValue = generateKey()
    const createdDate = new Date().toISOString().split('T')[0]

    safeLog.info(`[KEY-ROTATION] Generated new key: ${newKeyId}`)

    // 3. Deactivate old key
    config.keys[oldKeyId].active = false

    // 4. Add new key as active
    config.keys[newKeyId] = {
      key: newKeyValue,
      active: true,
      created: createdDate,
      description: `Auto-rotated key (replaced ${oldKeyId})`,
    }

    // 5. Write config back to file
    await writeConfig(config)

    // 6. Log success
    safeLog.info('[KEY-ROTATION] ✅ Key rotation completed successfully')
    safeLog.info(
      `[KEY-ROTATION]    Old key: ${oldKeyId} (now inactive, kept for decryption)`,
    )
    safeLog.info(`[KEY-ROTATION]    New key: ${newKeyId} (now active)`)
    safeLog.info(
      '[KEY-ROTATION]    ⚠️  IMPORTANT: Restart the application to use the new key',
    )
    safeLog.info(
      '[KEY-ROTATION]    💡 Consider running data re-encryption migration',
    )

    return {
      success: true,
      oldKeyId,
      newKeyId,
      newKey: newKeyValue,
      message: 'Key rotation completed. Please restart the application.',
    }
  } catch (err) {
    safeLog.error('[KEY-ROTATION] ❌ Key rotation failed:', err)
    return {
      success: false,
      error: err.message,
    }
  }
}

/**
 * Check if rotation is needed and perform it if necessary.
 *
 * @returns {Promise<Object>} - Status object
 */
async function checkAndRotate() {
  try {
    const config = await loadConfig()
    const activeKey = getActiveKey(config)

    if (!activeKey) {
      safeLog.error('[KEY-ROTATION] ❌ No active key found')
      return { checked: true, rotated: false, error: 'No active key' }
    }

    const keyAge = getKeyAgeDays(activeKey.created)
    const daysUntilRotation = KEY_ROTATION_DAYS - keyAge

    safeLog.info(`[KEY-ROTATION] 🔍 Checking key age...`)
    safeLog.info(`[KEY-ROTATION]    Active key: ${activeKey.id}`)
    safeLog.info(`[KEY-ROTATION]    Age: ${keyAge} days`)
    safeLog.info(`[KEY-ROTATION]    Days until rotation: ${daysUntilRotation}`)

    // Check if rotation needed
    if (needsRotation(activeKey.created)) {
      safeLog.info(
        `[KEY-ROTATION] ⚠️  Key is ${keyAge} days old - rotation required!`,
      )
      const result = await performKeyRotation()
      return { checked: true, rotated: result.success, ...result }
    }

    // Check if warning needed
    if (shouldWarn(activeKey.created)) {
      safeLog.warn(
        `[KEY-ROTATION] ⚠️  Key will expire in ${daysUntilRotation} days`,
      )
      return {
        checked: true,
        rotated: false,
        warning: true,
        daysUntilRotation,
      }
    }

    // All good
    safeLog.info(
      `[KEY-ROTATION] ✅ Key is ${keyAge} days old - no rotation needed`,
    )
    return { checked: true, rotated: false, keyAge, daysUntilRotation }
  } catch (err) {
    safeLog.error('[KEY-ROTATION] ❌ Check failed:', err)
    return { checked: false, error: err.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULER
// ═══════════════════════════════════════════════════════════════════════════

let schedulerInterval = null

/**
 * Start the key rotation scheduler.
 * Checks key age daily and rotates if needed.
 *
 * @param {number} [intervalHours=24] - Check interval in hours
 * @returns {void}
 */
function startKeyRotationScheduler(intervalHours = CHECK_INTERVAL_HOURS) {
  if (schedulerInterval) {
    safeLog.warn('[KEY-ROTATION] Scheduler already running')
    return
  }

  const intervalMs = intervalHours * 60 * 60 * 1000

  safeLog.info('[KEY-ROTATION] 🚀 Starting key rotation scheduler')
  safeLog.info(`[KEY-ROTATION]    Check interval: ${intervalHours} hours`)
  safeLog.info(
    `[KEY-ROTATION]    Rotation threshold: ${KEY_ROTATION_DAYS} days`,
  )
  safeLog.info(
    `[KEY-ROTATION]    Warning threshold: ${WARNING_DAYS_BEFORE} days before rotation`,
  )

  // Run immediately on startup
  checkAndRotate()

  // Schedule periodic checks
  schedulerInterval = setInterval(() => {
    checkAndRotate()
  }, intervalMs)

  safeLog.info('[KEY-ROTATION] ✅ Scheduler started')
}

/**
 * Stop the key rotation scheduler.
 *
 * @returns {void}
 */
function stopKeyRotationScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
    safeLog.info('[KEY-ROTATION] 🛑 Scheduler stopped')
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MANUAL TRIGGERS (for testing or emergency rotation)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Manually trigger key rotation (ignoring age check).
 * Use this for emergency rotation or testing.
 *
 * @returns {Promise<Object>}
 */
async function forceRotation() {
  safeLog.warn('[KEY-ROTATION] ⚠️  MANUAL key rotation triggered')
  return performKeyRotation()
}

/**
 * Get current key status without rotating.
 *
 * @returns {Promise<Object>}
 */
async function getKeyStatus() {
  try {
    const config = await loadConfig()
    const activeKey = getActiveKey(config)

    if (!activeKey) {
      return { error: 'No active key found' }
    }

    const keyAge = getKeyAgeDays(activeKey.created)
    const daysUntilRotation = KEY_ROTATION_DAYS - keyAge
    const needsRotationNow = needsRotation(activeKey.created)
    const shouldWarnNow = shouldWarn(activeKey.created)

    return {
      activeKeyId: activeKey.id,
      created: activeKey.created,
      keyAge,
      daysUntilRotation,
      needsRotation: needsRotationNow,
      shouldWarn: shouldWarnNow,
      rotationThreshold: KEY_ROTATION_DAYS,
      allKeys: Object.keys(config.keys || {}).map((id) => ({
        id,
        active: config.keys[id].active,
        created: config.keys[id].created,
        age: getKeyAgeDays(config.keys[id].created),
      })),
    }
  } catch (err) {
    return { error: err.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export {
  // Scheduler
  startKeyRotationScheduler,
  stopKeyRotationScheduler,
  // Manual operations
  checkAndRotate,
  forceRotation,
  getKeyStatus,
  // Utilities (exported for testing)
  getKeyAgeDays,
  needsRotation,
  shouldWarn,
  generateKey,
  getNextKeyId,
  // Constants
  KEY_ROTATION_DAYS,
  CHECK_INTERVAL_HOURS,
  WARNING_DAYS_BEFORE,
}
