#!/usr/bin/env node

/**
 * Manual Key Rotation Script
 *
 * Usage:
 *   node src/scripts/rotateKeys.js [options]
 *
 * Options:
 *   --check         Check current key status without rotating
 *   --force         Force rotation even if key is not old enough
 *   --status        Show detailed status of all keys
 *
 * Examples:
 *   node scripts/rotateKeys.js --check
 *   node scripts/rotateKeys.js --force
 *   node scripts/rotateKeys.js --status
 *
 * This script can be run:
 *  - Manually when needed
 *  - Via cron job (e.g., weekly check)
 *  - Via CI/CD pipeline
 *  - As part of deployment process
 */

import {
  checkAndRotate,
  forceRotation,
  getKeyStatus,
  KEY_ROTATION_DAYS,
} from '../utils/keyRotationScheduler.js'
import { safeLog } from '../utils/piiMasking.js'

// ═══════════════════════════════════════════════════════════════════════════
// CLI ARGUMENT PARSING
// ═══════════════════════════════════════════════════════════════════════════

const args = process.argv.slice(2)
const hasFlag = (flag) => args.includes(flag)

const CHECK_ONLY = hasFlag('--check')
const FORCE_ROTATION = hasFlag('--force')
const SHOW_STATUS = hasFlag('--status')

// ═══════════════════════════════════════════════════════════════════════════
// OUTPUT FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

function printHeader(title) {
  safeLog.info('\n' + '='.repeat(70))
  safeLog.info(`  ${title}`)
  safeLog.info('='.repeat(70) + '\n')
}

function printStatus(status) {
  if (status.error) {
    safeLog.error('❌ Error:', status.error)
    return
  }

  safeLog.info('Current Key Status:')
  safeLog.info(`  Active Key ID:      ${status.activeKeyId}`)
  safeLog.info(`  Created:            ${status.created}`)
  safeLog.info(`  Age:                ${status.keyAge} days`)
  safeLog.info(`  Days Until Rotation: ${status.daysUntilRotation} days`)
  safeLog.info(`  Rotation Threshold:  ${status.rotationThreshold} days`)
  safeLog.info(
    `  Needs Rotation:      ${status.needsRotation ? '⚠️  YES' : '✅ No'}`,
  )
  safeLog.info(
    `  Should Warn:         ${status.shouldWarn ? '⚠️  YES' : '✅ No'}`,
  )

  if (status.allKeys && status.allKeys.length > 0) {
    safeLog.info('\nAll Keys:')
    status.allKeys.forEach((key) => {
      const activeLabel = key.active ? '[ACTIVE]' : '[INACTIVE]'
      const ageLabel = `${key.age} days old`
      safeLog.info(
        `  - ${key.id.padEnd(15)} ${activeLabel.padEnd(12)} ${ageLabel.padEnd(15)} (created: ${key.created})`,
      )
    })
  }
}

function printRotationResult(result) {
  if (!result.success) {
    safeLog.error('\n❌ Key rotation FAILED')
    safeLog.error(`   Error: ${result.error}`)
    process.exit(1)
  }

  safeLog.info('\n✅ Key rotation completed successfully!\n')
  safeLog.info('Details:')
  safeLog.info(`  Old Key ID:  ${result.oldKeyId} (now inactive)`)
  safeLog.info(`  New Key ID:  ${result.newKeyId} (now active)`)
  safeLog.info(`  New Key:     ${result.newKey.substring(0, 16)}... (64 chars)`)

  safeLog.info('\n⚠️  IMPORTANT NEXT STEPS:')
  safeLog.info('  1. ✅ Keys rotated successfully')
  safeLog.info('  2. 🔄 Restart your Node.js application to load new key')
  safeLog.info('  3. 💾 Back up the new encryption.config.js file securely')
  safeLog.info('  4. 🔐 Consider running data re-encryption migration:')
  safeLog.info('     node src/scripts/reencryptData.js')
  safeLog.info('  5. 🗑️  After migration, old key can be removed from config\n')
}

async function handleStatus() {
  printHeader('Encryption Key Status')
  const status = await getKeyStatus()
  printStatus(status)
}

async function handleCheckOnly() {
  printHeader('Key Rotation Check (No Rotation)')

  const rotationResult = await checkAndRotate()

  safeLog.info('Check Result:')
  safeLog.info(`  Checked:     ${rotationResult.checked ? '✅ Yes' : '❌ No'}`)
  safeLog.info(`  Rotated:     ${rotationResult.rotated ? '✅ Yes' : '❌ No'}`)

  if (rotationResult.warning) {
    safeLog.info(
      `  Warning:     ⚠️  Key will expire in ${rotationResult.daysUntilRotation} days`,
    )
  }

  if (rotationResult.error) {
    safeLog.error(`  Error:       ❌ ${rotationResult.error}`)
    process.exit(1)
  }

  if (rotationResult.rotated) {
    printRotationResult(rotationResult)
  } else if (rotationResult.keyAge !== undefined) {
    safeLog.info(
      `\n✅ Key is ${rotationResult.keyAge} days old (${rotationResult.daysUntilRotation} days until rotation)`,
    )
  }
}

async function handleForceRotation() {
  printHeader('Force Key Rotation')
  safeLog.info('⚠️  Forcing rotation (ignoring age check)...\n')

  const rotationResult = await forceRotation()
  printRotationResult(rotationResult)
}

async function handleAutoRotation() {
  printHeader('Automatic Key Rotation Check')

  safeLog.info(
    `Keys will be rotated if they are ${KEY_ROTATION_DAYS} days or older\n`,
  )

  const rotationResult = await checkAndRotate()

  if (rotationResult.error) {
    safeLog.error(`\n❌ Error: ${rotationResult.error}`)
    process.exit(1)
  }

  if (rotationResult.rotated) {
    printRotationResult(rotationResult)
  } else {
    safeLog.info(
      `\n✅ No rotation needed (key is ${rotationResult.keyAge} days old)`,
    )
    safeLog.info(
      `   Next rotation will occur in ${rotationResult.daysUntilRotation} days\n`,
    )
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  try {
    if (SHOW_STATUS) {
      await handleStatus()
      process.exit(0)
    }

    if (CHECK_ONLY) {
      await handleCheckOnly()
      process.exit(0)
    }

    if (FORCE_ROTATION) {
      await handleForceRotation()
      process.exit(0)
    }

    // Default behaviour
    await handleAutoRotation()
    process.exit(0)
  } catch (err) {
    safeLog.error('\n❌ Unexpected error:', err.message)
    safeLog.error(err.stack)
    process.exit(1)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELP TEXT
// ═══════════════════════════════════════════════════════════════════════════

if (hasFlag('--help') || hasFlag('-h')) {
  safeLog.info(`
Key Rotation Script
===================

This script manages automatic rotation of encryption keys.

USAGE:
  node src/scripts/rotateKeys.js [options]

OPTIONS:
  --check         Check current key status and rotate if needed (safe)
  --force         Force rotation immediately (ignores age check)
  --status        Show detailed status of all keys (read-only)
  --help, -h      Show this help message

EXAMPLES:
  # Check if rotation is needed and rotate if necessary
  node src/scripts/rotateKeys.js --check

  # Show current key status without rotating
  node src/scripts/rotateKeys.js --status

  # Force rotation immediately (for emergencies)
  node src/scripts/rotateKeys.js --force

AUTOMATION:
  You can automate this script with cron or a task scheduler.

  Example cron (check daily at 2 AM):
    0 2 * * * cd /path/to/app && node src/scripts/rotateKeys.js --check

  Example Windows Task Scheduler:
    - Trigger: Daily at 2:00 AM
    - Action: node.exe
    - Arguments: src/scripts/rotateKeys.js --check
    - Start in: C:\\path\\to\\app

ROTATION POLICY:
  - Keys rotate every ${KEY_ROTATION_DAYS} days
  - Old keys are kept for decrypting legacy data
  - Only one key is active at a time
  - Rotation creates a new key and deactivates the old one

AFTER ROTATION:
  1. Restart your application to load the new key
  2. Run data re-encryption migration (optional but recommended)
  3. Back up the updated encryption.config.js file

For more information, see documentation.
`)
  process.exit(0)
}

// Run the script
main()
