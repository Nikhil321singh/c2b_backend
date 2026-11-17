import mongoose from 'mongoose'
import { safeLog } from '../utils/piiMasking.js'
import brands from '../models/brandsModel.js'
import modelsModel from '../models/modelsModel.js'
import s3Controller from './s3.controller.js'
const categoryInfo = '$categoryInfo'

const create = async (req, res) => {
  try {
    const brandName = req.body.brandName
    const { brandImage } = req.files
    const logo = brandImage ? await s3Controller.uploadFile(brandImage[0]) : ''
    let brand = await brands.findOne({ name: brandName })
    if (brand) {
      await brands.findOneAndUpdate(
        { name: brandName },
        { $set: { logo: logo } },
        { new: true },
      )
    } else {
      brand = await brands.create({
        name: brandName,
        logo: logo,
        deviceTypes: ['CTG3'],
      })
    }

    res
      .status(200)
      .json({ data: brand, message: 'brand created successfully.' })
  } catch (error) {
    safeLog.info(error)
    res.status(500).json({ message: error.message })
  }
}

const updateBrand = async (req, res) => {
  try {
    const brandName = req.body.brandName
    const { brandImage } = req?.files
    const brandUpd = JSON.parse(req.body.brandUpd)

    const brand = await brands.findOne({ name: brandName })
    const logo = brandImage
      ? await s3Controller.uploadFile(brandImage[0])
      : brand.logo
    brandUpd.logo = logo
    await brands.findOneAndUpdate(
      { name: brandName },
      { $set: brandUpd },
      { new: true },
    )

    res
      .status(200)
      .json({ data: brandUpd, message: 'brand updated successfully.' })
  } catch (error) {
    safeLog.info(error)
    res.status(500).json({ message: error.message })
  }
}

const createModel = async (req, res) => {
  try {
    const modal = await modelsModel.create(req.body)
    res
      .status(200)
      .json({ data: modal, message: 'brand created successfully.' })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

const getBrands = async (req, res) => {
  try {
    const deviceType = req.query.deviceType
    let query = {}

    if (deviceType) {
      if (deviceType === 'more') {
        // For "mothen", exclude CTG1, CTG2, CTG5
        query = { deviceTypes: { $nin: ['CTG1', 'CTG2', 'CTG5'] } }
      } else {
        query = { deviceTypes: deviceType }
      }
    }

    const data = await brands.find(query).sort({ viewOn: 1 })
    res.status(200).json({ data, message: 'brands fetched successfully.' })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

const getAllBrandsModels = async (req, res) => {
  const deviceType = req.query.type || 'CTG1'

  try {
    const data = await modelsModel.aggregate([
      {
        $match: {
          type: deviceType,
        },
      },
      {
        $lookup: {
          from: 'brands',
          localField: 'brandId',
          foreignField: '_id',
          as: 'brandInfo',
        },
      },
      {
        $unwind: '$brandInfo',
      },
      {
        $lookup: {
          from: 'categories',
          localField: 'type',
          foreignField: 'categoryCode',
          as: 'categoryInfo',
        },
      },
      {
        $unwind: categoryInfo,
      },
      {
        $group: {
          _id: '$brandId',
          brand: { $first: '$brandInfo' },
          models: {
            $push: {
              _id: '$_id',
              name: '$name',
              core: '$core',
              config: '$config',
              chipset: '$chipset',
              back_camera: '$back_camera',
              front_camera: '$front_camera',
              type: '$type',
              categoryName: '$categoryInfo.categoryName',
            },
          },
        },
      },
    ])
    res.status(200).json({ data, message: 'data fetched successfully.' })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

//slecetd brnad all modelsModel

const SelectedBrandModels = async (req, res) => {
  try {
    const deviceType = req.body.deviceType || 'CTG1'
    const brandIdRaw =
      req.body.brandId ||
      req.body.brandid || // backward compatibility
      req.body.brandID

    const search = req.body.search || ''
    const series = req.body.series || ''
    const companyIdRaw = req.body.companyId || null

    /* ---------------- VALIDATION ---------------- */
    if (!brandIdRaw || !mongoose.Types.ObjectId.isValid(brandIdRaw)) {
      return res.status(400).json({ message: 'Invalid or missing brandId' })
    }

    const brandId = new mongoose.Types.ObjectId(brandIdRaw)
    const companyId =
      companyIdRaw && mongoose.Types.ObjectId.isValid(companyIdRaw)
        ? new mongoose.Types.ObjectId(companyIdRaw)
        : null

    /* ---------------- MODEL MATCH ---------------- */
    const modelMatch = {
      brandId,
      type: deviceType,
      name: { $regex: search, $options: 'i' },
    }

    if (series) {
      modelMatch.series = { $regex: series, $options: 'i' }
    }

    /* ---------------- PRICE LOOKUP PIPELINE ---------------- */
    const $modelId = '$modelId'
    const companyIdField = '$companyId'
    const priceLookupPipeline = companyId
      ? [
          // company price first, fallback to global
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: [$modelId, '$$modelId'] },
                  {
                    $or: [
                      { $eq: [companyIdField, companyId] },
                      {
                        $and: [
                          { $eq: ['$isGlobalPrice', true] },
                          {
                            $or: [
                              { $eq: [companyIdField, null] },
                              { $eq: [{ $type: companyIdField }, 'missing'] },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
          {
            $addFields: {
              priority: {
                $cond: [{ $eq: [companyIdField, companyId] }, 1, 2],
              },
            },
          },
          { $sort: { priority: 1, updatedAt: -1 } },
          {
            $group: {
              _id: { storage: '$storage', RAM: '$RAM' },
              priceDoc: { $first: '$$ROOT' },
            },
          },
          { $replaceRoot: { newRoot: '$priceDoc' } },
        ]
      : [
          // only global price
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: [$modelId, '$$modelId'] },
                  { $eq: ['$isGlobalPrice', true] },
                  {
                    $or: [
                      { $eq: [companyIdField, null] },
                      { $eq: [{ $type: companyIdField }, 'missing'] },
                    ],
                  },
                ],
              },
            },
          },
        ]

    /* ---------------- AGGREGATION ---------------- */
    const documents = await modelsModel.aggregate([
      { $match: modelMatch },

      {
        $lookup: {
          from: 'gradeprices',
          let: { modelId: '$_id' },
          pipeline: priceLookupPipeline,
          as: 'priceDocs',
        },
      },

      /* -------- Merge A_PLUS into config.price -------- */
      {
        $addFields: {
          config: {
            $map: {
              input: '$config',
              as: 'cfg',
              in: {
                $let: {
                  vars: {
                    matchedPrice: {
                      $first: {
                        $filter: {
                          input: '$priceDocs',
                          as: 'p',
                          cond: {
                            $and: [
                              { $eq: ['$$p.storage', '$$cfg.storage'] },
                              { $eq: ['$$p.RAM', '$$cfg.RAM'] },
                            ],
                          },
                        },
                      },
                    },
                  },
                  in: {
                    $mergeObjects: [
                      '$$cfg',
                      {
                        price: {
                          $ifNull: [
                            '$$matchedPrice.grades.A_PLUS',
                            '$$cfg.price',
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },

      /* -------- Remove priceDocs -------- */
      {
        $project: {
          priceDocs: 0,
        },
      },

      /* -------- Category -------- */
      {
        $lookup: {
          from: 'categories',
          localField: 'type',
          foreignField: 'categoryCode',
          as: 'categoryInfo',
        },
      },
      {
        $unwind: {
          path: '$categoryInfo',
          preserveNullAndEmptyArrays: true,
        },
      },
    ])

    /* ---------------- SERIES LIST ---------------- */
    const seriesList = await modelsModel.aggregate([
      { $match: { brandId, type: deviceType } },
      { $group: { _id: '$series' } },
      { $sort: { _id: 1 } },
    ])

    let uniqueSeriesList = seriesList
      .filter((item) => item._id)
      .map((item) => ({ name: item._id, seriesKey: item._id }))

    uniqueSeriesList = [{ name: 'All', seriesKey: '' }, ...uniqueSeriesList]

    return res.status(200).json({
      seriesList: uniqueSeriesList,
      models: documents,
    })
  } catch (error) {
    safeLog.info('SelectedBrandModels error:', error)
    return res.status(500).json({ message: error.message })
  }
}

export default {
  create,
  updateBrand,
  createModel,
  getBrands,
  getAllBrandsModels,
  SelectedBrandModels,
}
