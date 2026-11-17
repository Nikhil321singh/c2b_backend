import models from '../models/modelsModel.js'
import gradeprices from '../models/gradePriceModel.js'
import phoneCondition from '../models/phoneConditon.js'
import mongoose from 'mongoose'
import { safeLog } from './piiMasking.js'
import {
  CORE1,
  CORE2,
  DISPLAY1,
  DISPLAY2,
  DISPLAY3,
  FUNCTIONAL_MAJOR1,
  FUNCTIONAL_MAJOR2,
  FUNCTIONAL_MAJOR3,
  FUNCTIONAL_MINOR1,
  FUNCTIONAL_MINOR2,
  FUNCTIONAL_MINOR3,
  COSMETICS1,
  COSMETICS2,
  COSMETICS3,
  COSMETICS4,
  WARRANTY1,
  WARRANTY2,
} from '../const.js'
import {
  convertGrade,
  DisplayCodeUpd,
  FuncMajorUpd,
  FuncMinorUpd,
  CosmeticsUpd,
} from './questionnaireUtils.js'

// Grade hierarchy from best to worst for CORE2 lowest-grade lookup
const GRADE_ORDER = [
  'A_PLUS',
  'A',
  'A_MINUS',
  'A_MINUS_LIMITED',
  'B_PLUS',
  'B',
  'B_MINUS',
  'B_MINUS_LIMITED',
  'C_PLUS',
  'C',
  'C_MINUS',
  'C_MINUS_LIMITED',
  'D_PLUS',
  'D',
  'D_MINUS',
  'E',
]

/**
 * Build query object from QNA
 * @param {Object} QNA - Question and answer object
 * @returns {Object} - Query object
 */
export const buildQuery = (QNA) => {
  const query = {}
  if (
    QNA.Core?.some(
      (q) =>
        (Array.isArray(q?.selected) && q.selected[0] === true) ||
        q?.key === 'yes',
    )
  ) {
    query.coreCode = CORE2
  } else {
    query.coreCode = CORE1
  }
  if (QNA.Warranty?.length) {
    const warranty = QNA.Warranty.filter((e) => e.answer === WARRANTY1)
    query.warrentyCode = warranty.length ? WARRANTY1 : WARRANTY2
  }
  if (QNA.Display?.length) {
    DisplayCodeUpd(QNA, query, DISPLAY1, DISPLAY2, DISPLAY3)
  }
  if (QNA.Functional_major?.length) {
    FuncMajorUpd(
      QNA,
      query,
      FUNCTIONAL_MAJOR1,
      FUNCTIONAL_MAJOR2,
      FUNCTIONAL_MAJOR3,
    )
  }
  if (QNA.Functional_minor?.length) {
    FuncMinorUpd(
      QNA,
      query,
      FUNCTIONAL_MINOR1,
      FUNCTIONAL_MINOR2,
      FUNCTIONAL_MINOR3,
    )
  }
  if (QNA.Cosmetics?.length) {
    CosmeticsUpd(QNA, query, COSMETICS1, COSMETICS2, COSMETICS3, COSMETICS4)
  }
  return query
}

/**
 * Fetch grade data based on query
 * @param {Object} query - Query object
 * @returns {Promise<Object>} - Grade data
 */
export const fetchGradeData = async (query) => {
  if (query.coreCode !== CORE2) {
    safeLog.info({ query }, ' inside fetchGradeData')
    const { coreCode, ...filteredQuery } = query
    safeLog.info({ filteredQuery })
    return phoneCondition.findOne(filteredQuery).select('grade').lean()
  } else {
    safeLog.info('Returning default grade for CORE2')
    return { grade: 'E' }
  }
}

/**
 * Fetch price data from gradeprices or model config
 * @param {string} modelId - Model ID
 * @param {string} storage - Storage capacity
 * @param {string} ram - RAM capacity
 * @param {string|null} companyId - Company ID (optional)
 * @returns {Promise<Object>} - Price data
 */
export const fetchPriceData = async (
  modelId,
  storage,
  ram,
  companyId = null,
) => {
  const companyObjectId =
    companyId && mongoose.Types.ObjectId.isValid(companyId)
      ? new mongoose.Types.ObjectId(companyId)
      : null

  safeLog.info('fetchPriceData - Input params:', {
    modelId,
    storage,
    ram,
    companyId,
    companyObjectId,
  })

  const query = {
    modelId,
    $and: [
      {
        $or: [
          { storage, RAM: ram },
          { storage, RAM: { $exists: false } },
          { storage: { $exists: false }, RAM: ram },
          { storage: { $exists: false }, RAM: { $exists: false } },
        ],
      },
      {
        $or: companyObjectId
          ? [
              { companyId: companyObjectId },
              {
                $or: [{ companyId: null }, { companyId: { $exists: false } }],
              },
            ]
          : [
              {
                $or: [{ companyId: null }, { companyId: { $exists: false } }],
              },
            ],
      },
    ],
  }

  safeLog.info('fetchPriceData - MongoDB query:', JSON.stringify(query))
  // OPTIMIZATION: Try exact match first (most common case, uses index efficiently)
  let priceFromGrades = await gradeprices
    .findOne({
      modelId,
      storage,
      RAM: ram,
      ...(companyObjectId
        ? { companyId: companyObjectId }
        : {
            $or: [{ companyId: null }, { companyId: { $exists: false } }],
          }),
    })
    .select('grades')
    .lean()

  // If exact match not found, fall back to complex query
  if (!priceFromGrades) {
    priceFromGrades = await gradeprices
      .findOne(
        {
          modelId,
          $and: [
            {
              $or: [
                { storage, RAM: ram },
                { storage, RAM: { $exists: false } },
                { storage: { $exists: false }, RAM: ram },
                { storage: { $exists: false }, RAM: { $exists: false } },
              ],
            },
            {
              $or: companyObjectId
                ? [
                    { companyId: companyObjectId },
                    {
                      $or: [
                        { companyId: null },
                        { companyId: { $exists: false } },
                      ],
                    },
                  ]
                : [
                    {
                      $or: [
                        { companyId: null },
                        { companyId: { $exists: false } },
                      ],
                    },
                  ],
            },
          ],
        },
        null,
        {
          sort: {
            companyId: companyObjectId ? -1 : 0,
            updatedAt: -1,
          },
        },
      )
      .select('grades')
      .lean()
  }

  if (priceFromGrades) {
    safeLog.info('fetchPriceData - Found price in gradeprices:', {
      companyId: priceFromGrades.companyId,
      hasGrades: !!priceFromGrades.grades,
    })
    return priceFromGrades
  }

  safeLog.info(
    'fetchPriceData - No price found in gradeprices, checking model config',
  )

  const modelData = await models.findOne({ _id: modelId }).select('config')

  if (!modelData || !modelData.config || modelData.config.length === 0) {
    throw new Error('No price data found for this model')
  }

  const matchingConfig = modelData.config.find(
    (cfg) => cfg.storage === storage && cfg.RAM === ram,
  )

  if (!matchingConfig || !matchingConfig.price) {
    throw new Error(`No price found for storage: ${storage}, RAM: ${ram}`)
  }

  return {
    grades: {},
    flatPrice: matchingConfig.price,
  }
}

/**
 * Calculate price from grade data and price data
 * @param {Object} priceData - Price data object
 * @param {Object} gradeData - Grade data object
 * @param {Object} query - Query object
 * @returns {number} - Calculated price
 */
export const calculatePriceFromGrades = (priceData, gradeData, query) => {
  if (priceData.flatPrice) {
    return priceData.flatPrice
  }

  const lowestGrade = GRADE_ORDER.slice()
    .reverse()
    .find((g) => priceData.grades[g])

  if (query.coreCode && query.coreCode === CORE2) {
    return priceData.grades[lowestGrade] || 0
  }

  const gradeKey = convertGrade(gradeData.grade)

  if (priceData.grades[gradeKey]) {
    return priceData.grades[gradeKey]
  }

  let fallbackPrice = null

  const gradeFallbacks = {
    A_MINUS: ['A', 'A_PLUS'],
    A_MINUS_LIMITED: ['A_MINUS', 'A', 'A_PLUS'],
    B_PLUS: ['B', 'A'],
    B_MINUS_LIMITED: ['B_MINUS', 'B', 'C_PLUS'],
    C_MINUS_LIMITED: ['C_MINUS', 'C', 'D_PLUS'],
  }

  if (gradeFallbacks[gradeKey]) {
    for (const fallbackGrade of gradeFallbacks[gradeKey]) {
      if (priceData.grades[fallbackGrade]) {
        fallbackPrice = priceData.grades[fallbackGrade]
        break
      }
    }
  }

  return fallbackPrice || priceData.grades[lowestGrade] || 0
}

/**
 * Build lead object from user details and model details
 * @param {Object} req - Request object
 * @param {Object} userDetails - User details
 * @param {Object} modelDetails - Model details
 * @param {Object} gradeData - Grade data
 * @param {number} price - Calculated price
 * @returns {Object} - Lead object
 */
export const buildLeadObject = (
  req,
  userDetails,
  modelDetails,
  gradeData,
  price,
) => {
  const { QNA, phoneNumber, aadharNumber, name } = userDetails
  const { modelId, brandId, storage, ram } = modelDetails

  return {
    QNA,
    phoneNumber,
    aadharNumber: aadharNumber || '',
    name,
    modelId,
    brandId,
    userId: req.userId,
    price,
    ...(storage && { storage }),
    ...(ram && { ram }),
    gradeId: gradeData._id,
    actualPrice: price,
    conversionFee: process.env.CONVERSION_FEE || 10,
    uniqueCode: process.env.UNIQUE_CODE,
  }
}

/**
 * Build query parameters for lead search
 * @param {string} phoneNumber - Phone number
 * @param {string} modelId - Model ID
 * @param {string} storage - Storage capacity
 * @param {string} ram - RAM capacity
 * @param {string} userId - User ID
 * @returns {Object} - Query parameters
 */
export const buildQueryParam = (phoneNumber, modelId, storage, ram, userId) => {
  return {
    phoneNumber,
    modelId,
    userId,
    ...(storage && { storage }),
    ...(ram && { ram }),
    is_selled: false,
  }
}

export default {
  buildQuery,
  fetchGradeData,
  fetchPriceData,
  calculatePriceFromGrades,
  buildLeadObject,
  buildQueryParam,
}
