import mongoose from 'mongoose'
import { safeLog } from '../utils/piiMasking.js'

/**
 * Build store filter based on user role
 */
export function buildStoreFilter(user, req) {
  const isSuperAdmin = user.role === 'Super Admin'
  const isCompanyAdmin = user.role === 'Company Admin'

  // Super Admin - optional filters
  if (isSuperAdmin) {
    const filters = {}
    const qregion = req.query.region?.trim()
    const qstoreName = req.query.storeName?.trim()

    if (qregion) {
      filters['storeData.region'] = qregion
    }
    if (qstoreName) {
      filters['storeData.storeName'] = qstoreName
    }
    return filters
  }

  // Company Admin - company stores only
  if (isCompanyAdmin && req.companyStoreIds) {
    const storeObjectIds = req.companyStoreIds.map(
      (id) => new mongoose.Types.ObjectId(id),
    )
    safeLog.info(
      `🏢 Company Admin ${user._id} restricted to company stores.`,
      storeObjectIds,
    )
    return { 'storeData._id': { $in: storeObjectIds } }
  }

  // Admin Manager / Technician - assigned stores
  if (
    (user.role === 'Admin Manager' || user.role === 'Technician') &&
    user.assignedStores &&
    user.assignedStores.length > 0
  ) {
    const storeObjectIds = user.assignedStores.map(
      (id) => new mongoose.Types.ObjectId(id),
    )
    safeLog.info(
      `🏪 ${user.role} ${user._id} restricted to assigned stores.`,
      storeObjectIds,
    )
    return { 'storeData._id': { $in: storeObjectIds } }
  }

  // Regular user - single store
  if (!user.storeId) {
    safeLog.info(`📭 User ${user._id} has no store. Returning empty list.`)
    return null
  }

  safeLog.info(`🔒 User ${user._id} restricted to store ${user.storeId}.`)
  return { 'storeData._id': user.storeId }
}

/**
 * Build match conditions for aggregation pipeline
 */
export function buildMatchConditions(storeFilter) {
  if (storeFilter === null) {
    return null
  }

  const matchConditions = { $and: [] }

  if (Object.keys(storeFilter).length > 0) {
    matchConditions.$and.push(storeFilter)
  }

  if (matchConditions.$and.length === 0) {
    delete matchConditions.$and
  }

  return matchConditions
}

/**
 * Build search conditions with store filter
 */
export function buildSearchConditions(storeFilter, rid, date, status) {
  if (storeFilter === null) {
    return null
  }

  const searchConditions = [
    {
      $or: [
        { tempId: { $regex: '^' + rid, $options: 'i' } },
        { 'modelData.name': { $regex: rid, $options: 'i' } },
        { 'docData.IMEI': { $regex: rid, $options: 'i' } },
      ],
    },
    { tempDate: { $regex: '^' + date, $options: 'i' } },
    { status: { $regex: '^' + status, $options: 'i' } },
  ]

  if (Object.keys(storeFilter).length > 0) {
    searchConditions.push(storeFilter)
  }

  return searchConditions
}

/**
 * Build pagination stages for aggregation pipeline
 */
export function buildPaginationStages(page, limit, projectStage) {
  const skip = (page - 1) * limit

  return [
    projectStage, // $project stage
    {
      // Use $facet to get both total count and paginated results
      $facet: {
        metadata: [
          {
            $group: {
              _id: null,
              totalPrice: { $sum: '$price' },
              count: { $sum: 1 },
            },
          },
        ],
        documents: [{ $skip: skip }, { $limit: limit }],
      },
    },
    {
      // Reshape the result to match original format
      $project: {
        _id: 0,
        totalPrices: {
          $ifNull: [{ $arrayElemAt: ['$metadata.totalPrice', 0] }, 0],
        },
        count: { $ifNull: [{ $arrayElemAt: ['$metadata.count', 0] }, 0] },
        documents: '$documents',
      },
    },
  ]
}

/**
 * Build JSON response for device list
 */
export function buildDeviceListResponse(deviceList, page, limit, message) {
  return {
    data: [deviceList], // Wrap in array to maintain backward compatibility
    pagination: {
      page,
      limit,
      total: deviceList.count,
      totalPages: Math.ceil(deviceList.count / limit),
    },
    message,
  }
}
