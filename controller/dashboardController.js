import mongoose from 'mongoose'
import { safeLog } from '../utils/piiMasking.js'
import leads from '../models/leadsModel.js'
import models from '../models/modelsModel.js'
import quickview from '../models/quickviewModel.js'
import timeRangeCal from '../utils/timeRangeCal.js'
import brands from '../models/brandsModel.js'
import gradeprice from '../models/gradePriceModel.js'
import UsersModel from '../models/UsersModel.js'
import {
  decryptPIIFieldsArray,
  PII_FIELDS_TO_ENCRYPT,
} from '../utils/kmsEncryption.js'
const ISE = 'Interna Server Error'
const PRICE_CALC = { $add: ['$price', { $ifNull: ['$bonusPrice', 0] }, { $ifNull: ['$negotiatedAmount', 0] }, { $ifNull: ['$couponDiscount', 0] }] }

// 🔹 helper to map aggregation result -> models
async function fetchModelsFromResult(result) {
  const modelsArray = []
  for (let i = 0; i < result.length; i++) {
    const model = await models.findById(result[i]._id)
    if (model !== null) {
      modelsArray.push(model)
    }
  }
  return modelsArray
}

const Prospect = async (req, res) => {
  try {
    const userId = req.userId
    const count = await leads.countDocuments({
      userId: userId,
      is_selled: false,
    })
    return res.status(200).json({ success: true, count: count })
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message })
  }
}

export const leadPipe = [
  {
    $lookup: {
      from: 'stores',
      localField: 'storeId', //changed from userId.storeId to storeId
      foreignField: '_id',
      as: 'store',
    },
  },
  { $unwind: { path: '$store', preserveNullAndEmptyArrays: true } },
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
      localField: 'model.type',
      foreignField: 'categoryCode',
      as: 'categoryInfo',
    },
  },
  { $unwind: { path: '$categoryInfo', preserveNullAndEmptyArrays: true } },
]

//order complemeted
const saled = async (req, res) => {
  try {
    const userid = req.userId
    const { time, search, fromdate, todate, datareq } = req.query
    const { startDate, endDate } = timeRangeCal.timeRangeCal(
      time,
      fromdate,
      todate,
    )
    const aggregationPipeline = [
      {
        $match: {
          userId: new mongoose.Types.ObjectId(userid),
          is_selled: true,
          createdAt: { $gte: startDate.toDate(), $lte: endDate.toDate() },
        },
      },
      {
        $lookup: {
          from: 'documents',
          localField: 'documentId',
          foreignField: '_id',
          as: 'doc',
        },
      },
      { $unwind: '$doc' },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },
      //NEW: Lookup Company details using user.companyId
      {
        $lookup: {
          from: 'companies',
          localField: 'user.companyId',
          foreignField: '_id',
          as: 'companyData',
        },
      },
      // Preserve nulls so old users without company don't get filtered out
      { $unwind: { path: '$companyData', preserveNullAndEmptyArrays: true } },
      ...leadPipe,
      { $match: { 'model.type': datareq } },
      { $sort: { updatedAt: -1 } },
    ]
    if (search) {
      aggregationPipeline.push({
        $match: {
          $or: [
            { 'model.name': { $regex: '^' + search, $options: 'i' } },
            { uniqueCode: { $regex: '^' + search, $options: 'i' } },
          ],
        },
      })
    }
    aggregationPipeline.push({
      $project: {
        _id: 1,
        createdAt: 1,
        updatedAt: 1,
        'user.name': 1,
        'doc.IMEI': 1,
        'doc.signature': 1,
        'store.storeName': 1,
        'store.storeId': 1,
        'store.address': 1,
        name: 1,
        emailId: 1,
        phoneNumber: 1,
        aadharNumber: 1,
        uniqueCode: 1,
        storage: 1,
        ram: 1,
        price: PRICE_CALC,
        finalPrice: PRICE_CALC,
        exactValue: { $ifNull: ['$exactValue', '$price'] },
        slabBonusAmount: { $ifNull: ['$slabBonusAmount', 0] },
        negotiatedAmount: { $ifNull: ['$negotiatedAmount', 0] },
        couponDiscount: { $ifNull: ['$couponDiscount', 0] },
        couponCode: { $ifNull: ['$couponCode', ''] },
        slabApplied: { $ifNull: ['$slabApplied', ''] },
        model: 1,
        category: '$categoryInfo.categoryName',
        //NEW: Project the company settings (Default to false if missing)
        companyInfo: {
          showPrice: { $ifNull: ['$companyData.showPrice', false] },
          maskInfo: { $ifNull: ['$companyData.maskInfo', false] },
          name: { $ifNull: ['$companyData.name', ''] },
          gstNumber: { $ifNull: ['$companyData.gstNumber', ''] },
          address: { $ifNull: ['$companyData.address', ''] },
        },
      },
    })
    const leadss = await leads.aggregate(aggregationPipeline)

    // Decrypt all encrypted PII fields for all roles before applying field-level masking
    const decryptedLeads = await decryptPIIFieldsArray(
      leadss,
      PII_FIELDS_TO_ENCRYPT,
    )

    return res.status(200).json({
      success: true,
      count: decryptedLeads.length,
      Leads: decryptedLeads,
    })
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message })
  }
}

const addViewedPhone = async (req, res) => {
  const userId = req.userId
  const { modelId } = req.body
  try {
    const addView = new quickview({ userId, modelId })
    await addView.save()
    res.status(200).json({ message: 'Data saved successfully' })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

const getViewedPhone = async (req, res) => {
  const userId = req.userId
  try {
    const countQuickview = await quickview.countDocuments({ userId })
    const views = await quickview
      .find({ userId })
      .populate('modelId')
      .sort('-viewedAt')
    const viewModelsData = views.map((viewItem) => viewItem.modelId)

    res.status(200).json({ countQuickview, viewModelsData })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

//top seeling models /phones
async function topSelling(req, res) {
  try {
    const USERid = new mongoose.Types.ObjectId(req.userId)
    const deviceType = req.query.deviceType || 'CTG1'
    const result = await leads.aggregate([
      { $match: { is_selled: true, userId: USERid } },
      {
        $lookup: {
          from: 'models',
          localField: 'modelId',
          foreignField: '_id',
          as: 'modelsData',
        },
      },
      { $unwind: '$modelsData' },
      {
        $lookup: {
          from: 'categories',
          localField: 'modelsData.type',
          foreignField: 'categoryCode',
          as: 'categoryInfo',
        },
      },
      { $unwind: { path: '$categoryInfo', preserveNullAndEmptyArrays: true } },
      { $match: { 'modelsData.type': deviceType } },
      { $group: { _id: '$modelId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])

    const modelsSlice = await fetchModelsFromResult(result)
    res.status(200).json(modelsSlice.slice(0, 7))
  } catch (err) {
    safeLog.error(err)
    res.status(500).json({ message: ISE })
  }
}

async function resolveCompanyId(userId) {
  if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
    return null
  }
  const user = await UsersModel.findById(userId).select('companyId').lean()
  return user?.companyId || null
}

function buildPriceQuery(modelIds, companyId) {
  const base = { modelId: { $in: modelIds } }
  const noCompanyFilter = [{ companyId: null }, { companyId: { $exists: false } }]
  if (companyId) {
    return { ...base, $or: [{ companyId }, { isGlobalPrice: true, $or: noCompanyFilter }] }
  }
  return { ...base, isGlobalPrice: true, $or: noCompanyFilter }
}

function pickCompanyPrices(priceDocs, companyId) {
  const priceByKey = new Map()
  for (const p of priceDocs) {
    const key = `${p.modelId}|${p.storage}|${p.RAM}`
    const isCompanyMatch = companyId && String(p.companyId) === String(companyId)
    if (isCompanyMatch || !priceByKey.has(key)) {
      priceByKey.set(key, p)
    }
  }
  return priceByKey
}

function enrichWithPrices(matchingPhones, priceByKey) {
  return matchingPhones.map((phone) => ({
    ...phone,
    config: (phone.config || []).map((cfg) => {
      const key = `${phone._id}|${cfg.storage}|${cfg.RAM}`
      const priceDoc = priceByKey.get(key)
      const livePrice = priceDoc?.grades?.A_PLUS
      return livePrice !== undefined ? { ...cfg, price: livePrice } : cfg
    }),
  }))
}

async function searchPhone(req, res) {
  try {
    let phoneName = req.body.name
    const deviceType = req.body.deviceType
    const origin = req.headers.origin
    const allowedDomain = 'https://buyback.grest.in'

    const query = {}
    if (deviceType) {
      query.type = deviceType
    }

    if (origin === allowedDomain) {
      const appleBrand = await brands.findOne({ name: 'Apple' }).select('_id')
      if (appleBrand) {
        query.brandId = appleBrand._id
      }
    }

    const phones = await models.find(query).lean()
    phoneName = phoneName.replace(/\s/g, '')
    const regex = new RegExp(phoneName, 'i')

    const matchingPhones = phones.filter((phone) => {
      const comparableName = phone.name.replace(/\s/g, '')
      return regex.test(comparableName)
    })

    if (matchingPhones.length === 0) {
      return res.status(404).json({ message: 'No phones found' })
    }

    const companyId = await resolveCompanyId(req.userId)
    const modelIds = matchingPhones.map((phone) => phone._id)
    const priceQuery = buildPriceQuery(modelIds, companyId)

    const priceDocs = await gradeprice
      .find(priceQuery)
      .select('modelId storage RAM grades companyId')
      .lean()

    const priceByKey = pickCompanyPrices(priceDocs, companyId)
    const matchingPhonesWithLivePrice = enrichWithPrices(matchingPhones, priceByKey)

    return res.status(200).json(matchingPhonesWithLivePrice)
  } catch (err) {
    safeLog.error(err)
    return res.status(500).json({ message: 'Internal server error' })
  }
}

//for admin selling top
async function adminSelingget(req, res) {
  try {
    const result = await leads.aggregate([
      { $match: { is_selled: true } },
      { $group: { _id: '$modelId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])

    const modelsArray = await fetchModelsFromResult(result)
    res.status(200).json(modelsArray.slice(0, 10))
  } catch (err) {
    safeLog.error(err)
    res.status(500).json({ message: ISE })
  }
}

export default {
  Prospect,
  saled,
  addViewedPhone,
  getViewedPhone,
  topSelling,
  searchPhone,
  adminSelingget,
}
