import gradeprice from '../models/gradePriceModel.js'
import csv from '../controller/questionnaireController.js'
import companyModel from '../models/companyModel.js'
import s3Controller from './s3.controller.js'
import mongoose from 'mongoose'
import {
  buildGrades,
  fetchModelIdMap,
  MODEL_DETAILS,
  DB_TIMEOUT,
} from '../utils/priceControllerUtils.js'
import { safeLog } from '../utils/piiMasking.js'

/* -------------------- Constants -------------------- */
const BATCH_SIZE = 100

/* -------------------- Helper Functions -------------------- */

const extractPriceData = (row) => ({
  modelName: row[MODEL_DETAILS]?.trim(),
  RAM: row['Ram']?.trim() || null,
  storage: row['Storage']?.trim(),
  rawData: row,
})

const createCompanyPriceBulkOp = (priceData, modelId, companyId) => ({
  updateOne: {
    filter: {
      modelId,
      storage: priceData.storage,
      RAM: priceData.RAM,
      companyId: new mongoose.Types.ObjectId(companyId),
    },
    update: {
      $set: {
        modelId,
        storage: priceData.storage,
        RAM: priceData.RAM,
        grades: buildGrades(priceData.rawData),
        companyId: new mongoose.Types.ObjectId(companyId),
        isGlobalPrice: false,
      },
    },
    upsert: true,
  },
})

const processCompanyPriceBulkOps = async (
  batch,
  modelIdMap,
  companyId,
  rejected,
) => {
  const priceBulkOps = []
  let updated = 0

  for (const row of batch) {
    const priceData = extractPriceData(row)
    const modelId = modelIdMap.get(priceData.modelName?.toLowerCase())

    if (!modelId) {
      rejected.push({
        ...row,
        reason: 'Model not found. Upload global pricing first to create model.',
      })
      continue
    }

    const priceOp = createCompanyPriceBulkOp(priceData, modelId, companyId)
    priceBulkOps.push(priceOp)
    updated++
  }

  if (priceBulkOps.length > 0) {
    await gradeprice.bulkWrite(priceBulkOps, {
      ordered: false,
      maxTimeMS: DB_TIMEOUT,
    })
  }

  return updated
}

/* -------------------- Company Price Upload -------------------- */
const addEditCompanyModelsAndPrice = async (req, res) => {
  try {
    const { companyId, category } = req.body

    if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) {
      return res.status(400).json({ message: 'Valid companyId is required' })
    }

    if (!req.file) {
      return res.status(400).json({ message: 'File is required' })
    }

    const fileName = req.file.originalname
    const fileUrl = await s3Controller.uploadFileBuffer(req.file, fileName)

    await companyModel.findByIdAndUpdate(companyId, {
      $push: {
        priceSheets: {
          fileName,
          fileUrl,
          category,
          uploadedAt: new Date(),
        },
      },
    })

    const cs = csv.convertCsvToJson(req.file)
    let updated = 0
    const rejected = []

    for (let i = 0; i < cs.length; i += BATCH_SIZE) {
      const batch = cs.slice(i, i + BATCH_SIZE)
      const modelIdMap = await fetchModelIdMap(batch, category, MODEL_DETAILS)
      const batchUpdated = await processCompanyPriceBulkOps(
        batch,
        modelIdMap,
        companyId,
        rejected,
      )
      updated += batchUpdated
    }

    return res.status(200).json({
      rejected,
      message: `${updated} company prices upserted, ${rejected.length} rejected.`,
    })
  } catch (error) {
    safeLog.error(error)
    return res.status(500).json({ message: error.message })
  }
}

/* -------------------- Export -------------------- */
export default {
  addEditCompanyModelsAndPrice,
}
