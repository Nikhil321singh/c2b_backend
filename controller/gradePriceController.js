import gradeprice from '../models/gradePriceModel.js'
import { safeLog } from '../utils/piiMasking.js'
import csv from '../controller/questionnaireController.js'
import brandModel from '../models/brandsModel.js'
import {
  escapeRegExp,
  buildGrades,
  fetchModelIdMap,
  MODEL_DETAILS,
  A_WARRANTY,
  DB_TIMEOUT,
} from '../utils/priceControllerUtils.js'
import modelsModel from '../models/modelsModel.js'

/* -------------------- Constants -------------------- */
const SeriesColumn = 'Series'
const BATCH_SIZE = 100

const buildSearchQuery = (search) => {
  if (!search) {
    return {}
  }
  return { $or: [{ 'model.name': { $regex: search, $options: 'i' } }] }
}

const buildAggregationPipeline = (query, deviceType, limit, page) => [
  {
    $lookup: {
      from: 'models',
      localField: 'modelId',
      foreignField: '_id',
      as: 'model',
    },
  },
  { $unwind: '$model' },
  {
    $lookup: {
      from: 'categories',
      localField: 'type',
      foreignField: 'categoryCode',
      as: 'categoryInfo',
    },
  },
  { $unwind: { path: '$categoryInfo', preserveNullAndEmptyArrays: true } },
  { $match: query },
  { $match: { 'model.type': deviceType } },
  { $sort: { updatedAt: -1 } },
  { $skip: page * limit },
  { $limit: limit },
]

/* -------------------- Helper Functions -------------------- */
const extractRowData = (row) => ({
  brandName: row['Brand']?.toLowerCase(),
  modelName: row[MODEL_DETAILS]?.trim(),
  RAM: row['Ram']?.trim() || null,
  storage: row['Storage']?.trim(),
  series: row[SeriesColumn] || '',
  photos: {
    front: row['Front Photo'] || '',
    back: row['Back Photo'] || '',
    upFront: row['Up Front Photo'] || '',
    downFront: row['Down Front Photo'] || '',
  },
  rawData: row,
})

const validateRowData = (rowData, brandMap) => {
  return brandMap.get(rowData.brandName) && rowData.modelName
}

const createModelBulkOps = (rowData, brandId, category) => {
  const modelFilter = {
    name: new RegExp(`^${escapeRegExp(rowData.modelName)}$`, 'i'),
    brandId,
    type: category,
  }

  return [
    {
      updateOne: {
        filter: modelFilter,
        update: {
          $setOnInsert: {
            brandId,
            name: rowData.modelName,
            series: rowData.series,
            type: category,
            phonePhotos: rowData.photos,
            config: [],
          },
        },
        upsert: true,
      },
    },
    {
      updateOne: {
        filter: {
          ...modelFilter,
          'config.storage': rowData.storage,
          'config.RAM': rowData.RAM,
        },
        update: {
          $set: {
            'config.$.price': Number(rowData.rawData[A_WARRANTY]),
          },
        },
      },
    },
    {
      updateOne: {
        filter: {
          ...modelFilter,
          config: {
            $not: {
              $elemMatch: { storage: rowData.storage, RAM: rowData.RAM },
            },
          },
        },
        update: {
          $push: {
            config: {
              storage: rowData.storage,
              RAM: rowData.RAM,
              price: Number(rowData.rawData[A_WARRANTY]),
            },
          },
        },
      },
    },
  ]
}

const createPriceBulkOp = (rowData, modelId) => ({
  updateOne: {
    filter: {
      modelId,
      storage: rowData.storage,
      RAM: rowData.RAM,
      companyId: null,
    },
    update: {
      $set: {
        modelId,
        storage: rowData.storage,
        RAM: rowData.RAM,
        grades: buildGrades(rowData.rawData),
        companyId: null,
        isGlobalPrice: true,
      },
    },
    upsert: true,
  },
})

/* -------------------- CSV Upload (FIXED & SAFE) -------------------- */
const processModelBulkOps = async (batch, brandMap, category, rejected) => {
  const modelBulkOps = []

  for (const row of batch) {
    const rowData = extractRowData(row)

    if (!validateRowData(rowData, brandMap)) {
      rejected.push(row)
      continue
    }

    const brandId = brandMap.get(rowData.brandName)
    const ops = createModelBulkOps(rowData, brandId, category)
    modelBulkOps.push(...ops)
  }

  if (modelBulkOps.length === 0) {
    return { upsertedCount: 0, modifiedCount: 0 }
  }

  return modelsModel.bulkWrite(modelBulkOps, {
    ordered: false,
    maxTimeMS: DB_TIMEOUT,
  })
}

const processPriceBulkOps = async (batch, modelIdMap) => {
  const priceBulkOps = []

  for (const row of batch) {
    const rowData = extractRowData(row)
    const modelId = modelIdMap.get(rowData.modelName?.toLowerCase())

    if (!modelId) {
      continue
    }

    const priceOp = createPriceBulkOp(rowData, modelId)
    priceBulkOps.push(priceOp)
  }

  if (priceBulkOps.length === 0) {
    return
  }

  await gradeprice.bulkWrite(priceBulkOps, {
    ordered: false,
    maxTimeMS: DB_TIMEOUT,
  })
}

const addEditModelsAndPrice = async (req, res) => {
  try {
    const cs = csv.convertCsvToJson(req.file)
    const category = req.body.category

    let inserted = 0
    let updated = 0
    const rejected = []

    const brands = await brandModel
      .find({}, { name: 1 })
      .lean()
      .maxTimeMS(DB_TIMEOUT)

    const brandMap = new Map(brands.map((b) => [b.name.toLowerCase(), b._id]))

    for (let i = 0; i < cs.length; i += BATCH_SIZE) {
      const batch = cs.slice(i, i + BATCH_SIZE)

      const modelResult = await processModelBulkOps(
        batch,
        brandMap,
        category,
        rejected,
      )
      inserted += modelResult.upsertedCount || 0
      updated += modelResult.modifiedCount || 0

      const modelIdMap = await fetchModelIdMap(batch, category, MODEL_DETAILS)
      await processPriceBulkOps(batch, modelIdMap)
    }

    return res.status(200).json({
      rejected,
      message: `${inserted} models created, ${updated} configs updated, ${rejected.length} rejected.`,
    })
  } catch (error) {
    safeLog.info(error)
    return res.status(500).json({ message: error.message })
  }
}

/* -------------------- Listing APIs -------------------- */
const modelPriceList = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10
    const page = parseInt(req.query.page) || 0
    const search = req.query.search
    const deviceType = req.query.deviceType || 'CTG1'

    const query = buildSearchQuery(search)
    const pipeline = buildAggregationPipeline(query, deviceType, limit, page)

    const totalRecords = await gradeprice.aggregate([
      ...pipeline.slice(0, -3),
      { $count: 'total' },
    ])

    const result = await gradeprice.aggregate(pipeline)

    res.status(200).json({
      result,
      totalRecords: totalRecords[0]?.total || 0,
    })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

const getModelWisePrice = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10
    const page = parseInt(req.query.page) || 0

    const data = await gradeprice
      .find()
      .populate('modelId partnerId')
      .limit(limit)
      .skip(limit * page)
      .maxTimeMS(DB_TIMEOUT)

    const totalRecords = await gradeprice.countDocuments()

    res.status(200).json({
      data,
      totalRecords,
      message: 'Successfully Fetched models',
    })
  } catch (error) {
    safeLog.info(error)
    res.status(500).json({ message: error.message })
  }
}

/* -------------------- Export -------------------- */
export default {
  addEditModelsAndPrice,
  modelPriceList,
  getModelWisePrice,
}
