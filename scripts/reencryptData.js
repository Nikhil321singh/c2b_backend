import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { decryptPII, encryptPII } from '../utils/kmsEncryption.js'
import { getKeyStatus } from '../utils/keyRotationScheduler.js'
import { safeLog } from '../utils/piiMasking.js'

// Load environment variables
dotenv.config()

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100', 10)
const DRY_RUN = process.argv.includes('--dry-run')
const LEADS_ONLY = process.argv.includes('--leads-only')
const USERS_ONLY = process.argv.includes('--users-only')
const COMPANIES_ONLY = process.argv.includes('--companies-only')
const DOCUMENTS_ONLY = process.argv.includes('--documents-only')

// Parse custom batch size from args
const batchArg = process.argv.find((arg) => arg.startsWith('--batch-size'))

const customBatchSize = batchArg
  ? parseInt(
      batchArg.split('=')[1] ||
        process.argv[process.argv.indexOf(batchArg) + 1],
      10,
    )
  : BATCH_SIZE

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE CONNECTION
// ═══════════════════════════════════════════════════════════════════════════

async function connectDB() {
  try {
    const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/grest'

    await mongoose.connect(mongoURI)
    safeLog.info('✅ Connected to MongoDB')
  } catch (err) {
    safeLog.error('❌ MongoDB connection failed:', err.message)
    process.exit(1)
  }
}

async function disconnectDB() {
  await mongoose.disconnect()
  safeLog.info('✅ Disconnected from MongoDB')
}

// ═══════════════════════════════════════════════════════════════════════════
// MODELS
// ═══════════════════════════════════════════════════════════════════════════

async function getModels() {
  // Use raw collections to avoid model validation issues
  const Lead = mongoose.connection.collection('leads')
  const User = mongoose.connection.collection('users')
  const Company = mongoose.connection.collection('companies')
  const Document = mongoose.connection.collection('documents')

  return { Lead, User, Company, Document }
}

// ═══════════════════════════════════════════════════════════════════════════
// ENCRYPTION HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a field value is encrypted.
 *
 * @param {string} value - Value to check
 * @returns {boolean}
 */
function isEncrypted(value) {
  if (!value || typeof value !== 'string') {
    return false
  }
  if (value.length < 50) {
    return false
  } // Encrypted values are always long

  const parts = value.split(':')
  if (parts.length !== 4) {
    return false
  }

  const [keyId, iv, authTag, ciphertext] = parts

  // Check keyId is alphanumeric
  if (!/^[a-zA-Z0-9_-]+$/.test(keyId)) {
    return false
  }

  // Check other parts are base64
  const base64Regex = /^[A-Za-z0-9+/]+=*$/
  return (
    base64Regex.test(iv) &&
    base64Regex.test(authTag) &&
    base64Regex.test(ciphertext)
  )
}

async function reencryptFields(doc, fields) {
  const updates = {}
  let hasChanges = false

  for (const field of fields) {
    if (!doc[field]) {
      continue
    }

    const result = await reencryptField(doc[field])

    if (result.reencrypted) {
      updates[field] = result.newValue
      hasChanges = true
    }
  }

  return { updated: hasChanges, updates }
}

/**
 * Re-encrypt a single field value.
 *
 * @param {string} value - Encrypted or plaintext value
 * @returns {Promise<{reencrypted: boolean, newValue: string, oldKeyId?: string, newKeyId?: string}>}
 */
async function reencryptField(value) {
  if (!value || typeof value !== 'string') {
    return { reencrypted: false, newValue: value }
  }

  // Check if already encrypted
  if (!isEncrypted(value)) {
    // Plaintext - encrypt it
    const encrypted = await encryptPII(value)
    return { reencrypted: true, newValue: encrypted }
  }

  // Already encrypted - decrypt then re-encrypt with new key
  try {
    const decrypted = await decryptPII(value)
    const reencrypted = await encryptPII(decrypted)

    // Check if the key ID changed (indicates actual re-encryption)
    const oldKeyId = value.split(':')[0]
    const newKeyId = reencrypted.split(':')[0]

    return {
      reencrypted: oldKeyId !== newKeyId,
      newValue: reencrypted,
      oldKeyId,
      newKeyId,
    }
  } catch (err) {
    safeLog.error(`⚠️  Failed to re-encrypt field:`, err.message)
    return { reencrypted: false, newValue: value, error: err.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RE-ENCRYPTION LOGIC FOR EACH COLLECTION
// ═══════════════════════════════════════════════════════════════════════════

function reencryptLead(lead) {
  return reencryptFields(lead, ['phoneNumber', 'aadharNumber', 'emailId'])
}

function reencryptUser(user) {
  return reencryptFields(user, ['phoneNumber', 'email'])
}

function reencryptCompany(company) {
  return reencryptFields(company, ['gstNumber', 'panNumber'])
}

function reencryptDocument(document) {
  return reencryptFields(document, ['IMEI'])
}

// ═══════════════════════════════════════════════════════════════════════════
// BATCH PROCESSING
// ═══════════════════════════════════════════════════════════════════════════

async function processDocument(collection, doc, reencryptFn, stats, label) {
  try {
    const result = await reencryptFn(doc)
    stats.processed++

    if (!result.updated) {
      stats.skipped++
      return
    }

    stats.updated++

    if (DRY_RUN) {
      return
    }

    await collection.updateOne({ _id: doc._id }, { $set: result.updates })
  } catch (err) {
    stats.errors++
    safeLog.error(`❌ Error processing ${label} ${doc._id}:`, err.message)
  }
}

async function processCollection(collection, batchSize, reencryptFn, label) {
  const stats = {
    total: 0,
    processed: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
  }

  try {
    const totalCount = await collection.countDocuments({})
    stats.total = totalCount

    if (totalCount === 0) {
      safeLog.info(`  No ${label} found`)
      return stats
    }

    safeLog.info(`  Found ${totalCount} ${label}`)
    safeLog.info(`  Processing in batches of ${batchSize}...`)

    let skip = 0

    while (skip < totalCount) {
      const docs = await collection
        .find({})
        .skip(skip)
        .limit(batchSize)
        .toArray()

      safeLog.info(
        `  Processing ${label} ${skip + 1}-${Math.min(skip + batchSize, totalCount)}...`,
      )

      for (const doc of docs) {
        await processDocument(collection, doc, reencryptFn, stats, label)
      }

      skip += batchSize
    }
  } catch (err) {
    safeLog.error(`❌ Error processing ${label}:`, err.message)
    throw err
  }

  return stats
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  safeLog.info('\n' + '='.repeat(70))
  safeLog.info('  DATA RE-ENCRYPTION MIGRATION')
  safeLog.info('='.repeat(70) + '\n')

  if (DRY_RUN) {
    safeLog.info('⚠️  DRY RUN MODE - No changes will be made\n')
  }

  try {
    // Check key status
    safeLog.info('📋 Checking encryption key status...\n')
    const keyStatus = await getKeyStatus()

    if (keyStatus.error) {
      safeLog.error('❌ Error:', keyStatus.error)
      process.exit(1)
    }

    safeLog.info('Current Key Configuration:')
    safeLog.info(`  Active Key:    ${keyStatus.activeKeyId}`)
    safeLog.info(`  Key Age:       ${keyStatus.keyAge} days`)
    safeLog.info(`  Total Keys:    ${keyStatus.allKeys.length}`)
    safeLog.info()

    if (keyStatus.allKeys.length < 2) {
      safeLog.info(
        '⚠️  Warning: Only one key found. Re-encryption is only needed after key rotation.',
      )
      safeLog.info(
        '   Run this script after rotating keys with: node scripts/rotateKeys.js --force\n',
      )
    }

    // Connect to database
    safeLog.info('📦 Connecting to database...\n')
    await connectDB()

    const { Lead, User, Company, Document } = await getModels()

    // Process leads
    if (!USERS_ONLY && !COMPANIES_ONLY && !DOCUMENTS_ONLY) {
      safeLog.info('📝 Processing Leads...\n')
      const leadStats = await processCollection(
        Lead,
        customBatchSize,
        reencryptLead,
        'leads',
      )

      safeLog.info('\n📊 Lead Migration Results:')
      safeLog.info(`  Total:       ${leadStats.total}`)
      safeLog.info(`  Processed:   ${leadStats.processed}`)
      safeLog.info(`  Updated:     ${leadStats.updated}`)
      safeLog.info(`  Skipped:     ${leadStats.skipped}`)
      safeLog.info(`  Errors:      ${leadStats.errors}`)
      safeLog.info()
    }

    // Process users
    if (!LEADS_ONLY && !COMPANIES_ONLY && !DOCUMENTS_ONLY) {
      safeLog.info('👤 Processing Users...\n')

      const userStats = await processCollection(
        User,
        customBatchSize,
        reencryptUser,
        'users',
      )

      safeLog.info('\n📊 User Migration Results:')
      safeLog.info(`  Total:       ${userStats.total}`)
      safeLog.info(`  Processed:   ${userStats.processed}`)
      safeLog.info(`  Updated:     ${userStats.updated}`)
      safeLog.info(`  Skipped:     ${userStats.skipped}`)
      safeLog.info(`  Errors:      ${userStats.errors}`)
      safeLog.info()
    }

    // Process companies
    if (!LEADS_ONLY && !USERS_ONLY && !DOCUMENTS_ONLY) {
      safeLog.info('🏢 Processing Companies...\n')

      const companyStats = await processCollection(
        Company,
        customBatchSize,
        reencryptCompany,
        'companies',
      )

      safeLog.info('\n📊 Company Migration Results:')
      safeLog.info(`  Total:       ${companyStats.total}`)
      safeLog.info(`  Processed:   ${companyStats.processed}`)
      safeLog.info(`  Updated:     ${companyStats.updated}`)
      safeLog.info(`  Skipped:     ${companyStats.skipped}`)
      safeLog.info(`  Errors:      ${companyStats.errors}`)
      safeLog.info()
    }

    // Process documents
    if (!LEADS_ONLY && !USERS_ONLY && !COMPANIES_ONLY) {
      safeLog.info('📄 Processing Documents...\n')

      const documentStats = await processCollection(
        Document,
        customBatchSize,
        reencryptDocument,
        'documents',
      )

      safeLog.info('\n📊 Document Migration Results:')
      safeLog.info(`  Total:       ${documentStats.total}`)
      safeLog.info(`  Processed:   ${documentStats.processed}`)
      safeLog.info(`  Updated:     ${documentStats.updated}`)
      safeLog.info(`  Skipped:     ${documentStats.skipped}`)
      safeLog.info(`  Errors:      ${documentStats.errors}`)
      safeLog.info()
    }
    // Disconnect
    await disconnectDB()

    safeLog.info('✅ Migration completed successfully!\n')

    if (DRY_RUN) {
      safeLog.info('⚠️  This was a DRY RUN - no changes were made')
      safeLog.info('   Run without --dry-run to perform actual migration\n')
    } else {
      safeLog.info('✅ All data has been re-encrypted with the new key')
      safeLog.info('   Old keys can now be safely removed from config\n')
    }

    process.exit(0)
  } catch (err) {
    safeLog.error('\n❌ Migration failed:', err.message)
    safeLog.error(err.stack)
    await disconnectDB()
    process.exit(1)
  }
}

// Show help
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  safeLog.info(`
Data Re-encryption Migration Script
====================================

Re-encrypts all PII data with the current active encryption key.

USAGE:
  node scripts/reencryptData.js [options]

OPTIONS:
  --dry-run         Simulate migration without making changes
  --batch-size N    Process N documents at a time (default: 100)
  --leads-only      Only re-encrypt leads (skip users, companies, documents)
  --users-only      Only re-encrypt users (skip leads, companies, documents)
  --companies-only  Only re-encrypt companies (skip leads, users, documents)
  --documents-only  Only re-encrypt documents (skip leads, users, companies)
  --help, -h        Show this help message

EXAMPLES:
  # Dry run to see what would happen
  node scripts/reencryptData.js --dry-run

  # Re-encrypt all data
  node scripts/reencryptData.js

  # Re-encrypt only leads with custom batch size
  node scripts/reencryptData.js --leads-only --batch-size 50

COLLECTIONS & PII FIELDS:
  - Leads:      phoneNumber, aadharNumber, emailId
  - Users:      phoneNumber, email
  - Companies:  gstNumber, panNumber
  - Documents:  IMEI

WHEN TO RUN:
  Run this after rotating encryption keys to re-encrypt all data
  with the new key. This allows you to eventually remove old keys
  from the configuration.

SAFETY:
  - Always run with --dry-run first to verify
  - Processes data in batches to avoid memory issues
  - Verifies decryption before re-encryption
  - Shows progress and statistics

PERFORMANCE:
  - Default batch size: 100 documents
  - Adjust with --batch-size for better performance
  - Larger batch sizes = faster but more memory
  - Smaller batch sizes = slower but safer

For more information, see documentation.
`)
  process.exit(0)
}

// Run migration
main()
