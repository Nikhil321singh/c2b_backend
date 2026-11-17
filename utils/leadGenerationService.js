import leads from '../models/leadsModel.js'
import UsersModel from '../models/UsersModel.js'
import counterModel from '../models/counterModel.js'
import {
  generateStorePrefix,
  extractCodeNumber,
  prepareLeadDefaults,
  shouldRetry,
  escapeRegex,
} from './questionnaireUtils.js'
import { safeLog } from './piiMasking.js'

/**
 * Assign store ID to lead based on user
 * @param {string} userId - User ID
 * @returns {Promise<string|undefined>} - Store ID
 */
async function assignStoreId(userId) {
  const currentUser = await UsersModel.findById(userId).select('storeId')
  return currentUser?.storeId || undefined
}

/**
 * Initialize counter for unique code generation
 * @param {string} counterId - Counter ID
 * @param {string} prefix - Prefix for unique code
 * @returns {Promise<Object>} - Counter object
 */
async function initializeCounter(counterId, prefix) {
  let counter = await counterModel.findById(counterId)
  if (!counter) {
    const envPrefix = process.env.UNIQUE_CODE_SUB || ''
    const fullPrefix = `${envPrefix}${prefix}`

    const allLeads = await leads
      .find({
        uniqueCode: {
          $regex: `^${escapeRegex(fullPrefix)}\\d+$`,
        },
      })
      .select('uniqueCode')
      .lean()

    let maxNumber = 0
    allLeads.forEach((doc) => {
      const num = extractCodeNumber(doc.uniqueCode)
      if (num > maxNumber) {
        maxNumber = num
      }
    })

    counter = await counterModel.findByIdAndUpdate(
      counterId,
      { sequence: maxNumber },
      { new: true, upsert: true },
    )
  }
  return counter
}

/**
 * Generate unique code for lead
 * @param {string} prefix - Prefix for unique code
 * @returns {Promise<string>} - Generated unique code
 */
async function generateUniqueCode(prefix) {
  const counterId = `uniqueCode_${prefix}`
  await initializeCounter(counterId, prefix)

  let attempts = 0
  const maxAttempts = 10

  while (attempts < maxAttempts) {
    const counter = await counterModel.findByIdAndUpdate(
      counterId,
      { $inc: { sequence: 1 } },
      { new: true },
    )

    const uniqueCode = `${process.env.UNIQUE_CODE_SUB}${prefix}${counter.sequence}`

    const existingLead = await leads.findOne({ uniqueCode }).select('_id')
    if (!existingLead) {
      return uniqueCode
    }

    safeLog.warn(`Duplicate uniqueCode detected: ${uniqueCode}, retrying...`)
    attempts++
  }

  throw new Error(
    `Failed to generate unique code after ${maxAttempts} attempts`,
  )
}

/**
 * Update existing lead
 * @param {Object} doc - Existing lead document
 * @param {Object} obj - Update object
 * @returns {Promise<Object>} - Updated lead and unique code
 */
async function updateExistingLead(doc, obj) {
  obj.createdAt = new Date()
  obj.updatedAt = new Date()
  const lead = await leads.findByIdAndUpdate(
    { _id: doc._id },
    { $set: obj },
    {
      new: true,
      timestamps: false,
      strict: false,
      overwriteImmutable: true,
    },
  )
  return { lead, uniqueCode: obj.uniqueCode }
}

/**
 * Create new lead
 * @param {Object} obj - Lead object
 * @param {string} prefix - Store prefix
 * @returns {Promise<Object>} - Created lead and unique code
 */
async function createNewLead(obj, prefix) {
  prepareLeadDefaults(obj)

  let retries = 3
  while (retries > 0) {
    retries--
    try {
      const lead = await leads.create(obj)
      return { lead, uniqueCode: obj.uniqueCode }
    } catch (error) {
      if (shouldRetry(error, retries)) {
        obj.uniqueCode = await generateUniqueCode(prefix)
        continue
      }
      throw error
    }
  }
  throw new Error('Failed to create lead after maximum retries')
}

/**
 * Generate lead and update or create
 * @param {Object} req - Request object
 * @param {Object} obj - Lead object
 * @param {Object} queryParam - Query parameters
 * @returns {Promise<Object>} - Lead and unique code
 */
export async function generateLeadAndUpdateOrCreate(req, obj, queryParam) {
  const doc = await leads.findOne(queryParam).select('uniqueCode')
  const storePrefix = generateStorePrefix(req)

  obj.storeId = await assignStoreId(req.userId)
  obj.uniqueCode = await generateUniqueCode(storePrefix)

  return doc ? updateExistingLead(doc, obj) : createNewLead(obj, storePrefix)
}

export default {
  generateLeadAndUpdateOrCreate,
  assignStoreId,
  initializeCounter,
  generateUniqueCode,
  updateExistingLead,
  createNewLead,
}
