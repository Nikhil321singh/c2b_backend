import leads from '../models/leadsModel.js'
import outstandingLot from '../models/outstandingLotModel.js'
import UsersModel from '../models/UsersModel.js'
import mongoose from 'mongoose'
import { safeLog } from '../utils/piiMasking.js'
import { ROLES } from '../middlewares/rbac.js'
import {
  createStorePaymentRequest,
  StorePaymentError,
} from '../services/storePaymentService.js'

const ISE = 'Internal Server Error, Failed To Create New Lot'
const CALC_PRICE = { $add: ['$price', { $ifNull: ['$bonusPrice', 0] }, { $ifNull: ['$negotiatedAmount', 0] }, { $ifNull: ['$couponDiscount', 0] }] }

/* ---------------------------------- PIPELINES ---------------------------------- */

const baseLookups = [
  {
    $lookup: {
      from: 'users',
      localField: 'userId',
      foreignField: '_id',
      as: 'userData',
    },
  },
  { $unwind: '$userData' },
  {
    $lookup: {
      from: 'models',
      localField: 'modelId',
      foreignField: '_id',
      as: 'modelData',
    },
  },
  { $unwind: '$modelData' },
  {
    $lookup: {
      from: 'categories',
      localField: 'modelData.type',
      foreignField: 'categoryCode',
      as: 'categoryInfo',
    },
  },
  { $unwind: { path: '$categoryInfo', preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: 'documents',
      localField: 'documentId',
      foreignField: '_id',
      as: 'docData',
    },
  },
  { $unwind: '$docData' },
  {
    $lookup: {
      from: 'stores',
      localField: 'storeId',
      foreignField: '_id',
      as: 'storeData',
    },
  },
  {
    $unwind: {
      path: '$storeData',
      preserveNullAndEmptyArrays: true,
    },
  },
  { $sort: { updatedAt: -1 } },
]

const getProjectionPipeline = (page = 0, limit = 1000) => {
  const skip = page * limit

  return [
    {
      $project: {
        is_selled: 1,
        status: 1,
        modelId: 1,
        storage: 1,
        ram: 1,
        price: CALC_PRICE,
        finalPrice: CALC_PRICE,
        createdAt: 1,
        updatedAt: 1,
        modelName: '$modelData.name',
        ramConfig: '$modelData.config',
        location: '$storeData.region',
        imei: '$docData.IMEI',
        reason: 1,
        category: '$categoryInfo.categoryName',
        QNA: 1,
        storeDetails: {
          storeId: '$storeData._id',
          storeName: '$storeData.storeName',
          region: '$storeData.region',
          address: '$storeData.address',
          phone: '$storeData.phone',
        },
      },
    },
    {
      $facet: {
        metadata: [
          { $count: 'totalCount' },
          {
            $addFields: {
              page: page,
              limit: limit,
            },
          },
        ],
        documents: [{ $skip: skip }, { $limit: limit }],
      },
    },
    {
      $project: {
        documents: 1,
        count: { $arrayElemAt: ['$metadata.totalCount', 0] },
        page: { $arrayElemAt: ['$metadata.page', 0] },
        limit: { $arrayElemAt: ['$metadata.limit', 0] },
      },
    },
  ]
}

/* ---------------------------------- HELPERS ---------------------------------- */

const buildEarlyMatch = (user, req, extra = {}) => {
  const earlyMatch = {
    is_selled: true,
    status: {
      $nin: [
        'Pending',
        'Completed',
        'Payment Requested',
        'Flagged',
        'Payment Done',
      ],
    },
    documentId: { $exists: true, $ne: null },
    storeId: { $exists: true, $ne: null },
  }

  if (user.role === ROLES.COMPANY_ADMIN && req.companyStoreIds?.length) {
    earlyMatch.storeId = {
      $in: req.companyStoreIds.map((id) => new mongoose.Types.ObjectId(id)),
    }
  }

  if (user.role === ROLES.SUPER_ADMIN) {
    const { region, storeName } = req.query

    if (!region && !storeName && !extra.search) {
      const date = new Date()
      date.setDate(date.getDate() - 30)
      earlyMatch.createdAt = { $gte: date }
    }
  }

  return earlyMatch
}

const escapeRegex = (str) => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const getCommonFilters = (req) => {
  const conditions = []
  if (req.query.region) {
    conditions.push({
      'storeData.region': new RegExp(
        `^${escapeRegex(req.query.region.trim())}$`,
        'i',
      ),
    })
  }
  if (req.query.storeName) {
    conditions.push({
      'storeData.storeName': new RegExp(
        `^${escapeRegex(req.query.storeName.trim())}$`,
        'i',
      ),
    })
  }
  return conditions
}

const getStoreConditions = (user) => {
  if (
    (user.role === ROLES.ADMIN_MANAGER ||
      user.role === ROLES.MANAGER ||
      user.role === ROLES.TECHNICIAN) &&
    user.assignedStores?.length
  ) {
    return [
      {
        'storeData._id': {
          $in: user.assignedStores.map((id) => new mongoose.Types.ObjectId(id)),
        },
      },
    ]
  }

  if (user.storeId) {
    return [{ 'storeData._id': user.storeId }]
  }

  return null
}

const buildMatchConditions = (user, req) => {
  const conditions = []

  if (user.role === ROLES.SUPER_ADMIN) {
    conditions.push(...getCommonFilters(req))
    return conditions.length > 0 ? { $and: conditions } : {}
  }

  if (user.role === ROLES.COMPANY_ADMIN && req.companyStoreIds) {
    conditions.push({
      'storeData._id': {
        $in: req.companyStoreIds.map((id) => new mongoose.Types.ObjectId(id)),
      },
    })
    conditions.push(...getCommonFilters(req))
    return conditions.length > 0 ? { $and: conditions } : {}
  }

  const storeConditions = getStoreConditions(user)
  if (!storeConditions) {
    return null
  }

  conditions.push(...storeConditions)
  return conditions.length > 0 ? { $and: conditions } : {}
}

const executeAggregation = async ({
  earlyMatch,
  matchConditions,
  extraStages = [],
  page = 0,
  limit = 1000,
}) => {
  const pipeline = [
    { $match: earlyMatch },
    ...baseLookups,
    ...extraStages,
    ...(matchConditions ? [{ $match: matchConditions }] : []),
    ...getProjectionPipeline(page, limit),
  ]

  return leads.aggregate(pipeline).allowDiskUse(true).exec()
}

const calcPriceAggregation = (ids) =>
  leads.aggregate([
    { $match: { _id: { $in: ids } } },
    {
      $addFields: {
        price: CALC_PRICE,
        finalPrice: CALC_PRICE,
      },
    },
    {
      $group: {
        _id: null,
        totalSum: { $sum: '$finalPrice' },
        count: { $sum: 1 },
      },
    },
  ])

/* ---------------------------------- CONTROLLERS ---------------------------------- */

const allDevices = async (req, res) => {
  try {
    const user = await UsersModel.findById(req.userId).select(
      'role storeId companyId assignedStores',
    )

    if (!user) {
      return res.status(403).json({ msg: 'User not found' })
    }

    const page = parseInt(req.query.page) || 0
    const limit = parseInt(req.query.limit) || 1000

    const earlyMatch = buildEarlyMatch(user, req)
    const matchConditions = buildMatchConditions(user, req)

    if (matchConditions === null) {
      return res.status(200).json({ data: [], message: 'No store assigned' })
    }

    const data = await executeAggregation({
      earlyMatch,
      matchConditions,
      page,
      limit,
    })

    return res.status(200).json({
      data,
      message: 'Devices fetched successfully',
    })
  } catch (err) {
    safeLog.error(err)
    return res.status(500).json({ msg: 'Internal Server Error' })
  }
}

const searchDevice = async (req, res) => {
  const { rid = '', date = '', status = '' } = req.query

  try {
    const user = await UsersModel.findById(req.userId).select(
      'role storeId companyId assignedStores',
    )

    if (!user) {
      return res.status(403).json({ msg: 'User not found' })
    }

    const page = parseInt(req.query.page) || 0
    const limit = parseInt(req.query.limit) || 1000

    const earlyMatch = buildEarlyMatch(user, req, { search: true })
    const matchConditions = buildMatchConditions(user, req)

    safeLog.info('Search Debug:', {
      query: req.query,
      earlyMatch,
      matchConditions,
      userRole: user.role,
    })

    if (matchConditions === null) {
      return res.status(200).json({ data: [] })
    }

    const searchConditions = []

    // Only add rid search if provided
    if (rid && rid.trim()) {
      searchConditions.push({
        $or: [
          { tempId: { $regex: '^' + rid.trim(), $options: 'i' } },
          { 'modelData.name': { $regex: rid.trim(), $options: 'i' } },
          { 'docData.IMEI': { $regex: rid.trim(), $options: 'i' } },
        ],
      })
    }

    // Only add date search if provided
    if (date && date.trim()) {
      searchConditions.push({
        tempDate: { $regex: '^' + date.trim(), $options: 'i' },
      })
    }

    // Only add status search if provided
    if (status && status.trim()) {
      searchConditions.push({
        status: { $regex: '^' + status.trim(), $options: 'i' },
      })
    }

    const extraStages = [
      {
        $addFields: {
          tempId: { $toString: '$_id' },
          tempDate: {
            $dateToString: {
              format: '%d/%m/%Y',
              date: '$createdAt',
            },
          },
        },
      },
    ]

    // Only add search conditions if there are any
    if (searchConditions.length > 0) {
      extraStages.push({ $match: { $and: searchConditions } })
    }

    const data = await executeAggregation({
      earlyMatch,
      matchConditions,
      extraStages,
      page,
      limit,
    })

    safeLog.info('Search Result:', {
      dataLength: data?.length || 0,
      hasData: data && data.length > 0,
      firstResult: data?.[0]
        ? {
            count: data[0].count,
            documentsCount: data[0].documents?.length,
          }
        : null,
    })

    return res.status(200).json({
      data,
      message: 'Search successful',
    })
  } catch (err) {
    safeLog.error(err)
    return res.status(500).json({ msg: 'Search failed' })
  }
}

/* ---------------------------------- SIMPLE ACTIONS ---------------------------------- */

const updateStatus = async (req, res) => {
  try {
    const { deviceIDs, newStatus, reason } = req.body

    const result = await leads.updateMany(
      {
        _id: { $in: deviceIDs },
        storePaymentStatus: {
          $nin: ['PAYMENT_REQUESTED', 'FLAGGED', 'PAYMENT_DONE'],
        },
      },
      { $set: { status: newStatus, reason } },
    )

    return res.status(200).json({
      data: result,
      message: 'Status updated',
    })
  } catch {
    return res.status(500).json({ msg: 'Update failed' })
  }
}

const updateRequest = async (req, res) => {
  try {
    const ids = req.body.deviceIDs.map((id) => new mongoose.Types.ObjectId(id))

    const eligibleIds = await leads.distinct('_id', {
      _id: { $in: ids },
      storePaymentStatus: {
        $nin: ['PAYMENT_REQUESTED', 'FLAGGED', 'PAYMENT_DONE'],
      },
    })
    if (eligibleIds.length !== ids.length) {
      return res.status(409).json({
        msg: 'A selected lead is already in the store payment workflow',
      })
    }

    const [calc] = await calcPriceAggregation(eligibleIds)

    const lot = await new outstandingLot({
      status: 'Pending Payroll Approval',
      request: req.body.newStatus,
      totalDevice: calc.count,
      totalAmount: calc.totalSum,
      deviceList: eligibleIds,
    }).save()

    await leads.updateMany(
      { _id: { $in: eligibleIds } },
      { $set: { status: req.body.newStatus } },
    )

    return res.status(200).json({ data: lot })
  } catch {
    return res.status(500).json({ msg: ISE })
  }
}

const pickupRequest = async (req, res) => {
  try {
    const lot = await createStorePaymentRequest({
      actorId: req.userId,
      leadIds: req.body.deviceIDs,
    })
    return res.status(200).json({ data: lot })
  } catch (err) {
    if (err instanceof StorePaymentError) {
      return res.status(err.statusCode).json({ msg: err.message })
    }
    safeLog.error(err)
    return res.status(500).json({ msg: ISE })
  }
}

/* ---------------------------------- EXPORT ---------------------------------- */

export default {
  allDevices,
  searchDevice,
  updateStatus,
  updateRequest,
  pickupRequest,
}
