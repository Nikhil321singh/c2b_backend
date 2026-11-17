import companyModel from '../models/companyModel.js'
import BonusSlabConfig from '../models/BonusSlabConfig.js'
import { safeLog } from '../utils/piiMasking.js'
import csv from '../controller/questionnaireController.js'
import s3Controller from '../controller/s3.controller.js'
import {
  validateCompanyRegistration,
  validateEmailConfiguration,
  generateCompanyCode,
} from '../utils/validationUtils.js'
import { ROLES } from '../middlewares/rbac.js'
import {
  decryptPIIFieldsArray,
  PII_FIELDS_TO_ENCRYPT,
} from '../utils/kmsEncryption.js'

/**
 * Helper to parse and validate email configuration
 * @param {Object} body - Request body
 * @returns {Object|null} - Null if validation fails (response sent), parsed configuration otherwise
 */
const handleEmailConfiguration = (body, res) => {
  if (body.emailConfiguration && typeof body.emailConfiguration === 'string') {
    try {
      body.emailConfiguration = JSON.parse(body.emailConfiguration)
    } catch (error) {
      res.status(400).json({
        success: false,
        message: 'Invalid email configuration format',
        errors: ['emailConfiguration must be a valid JSON object']
      })
      return null
    }
  }

  if (body.emailConfiguration) {
    const emailValidation = validateEmailConfiguration(body.emailConfiguration)
    if (!emailValidation.isValid) {
      res.status(400).json({
        success: false,
        message: 'Invalid email configuration',
        errors: emailValidation.errors
      })
      return null
    }
  }

  return body.emailConfiguration
}

const handleBuybackPayoutSettings = (body, res) => {
  if (
    body.buybackPayoutSettings &&
    typeof body.buybackPayoutSettings === 'string'
  ) {
    try {
      body.buybackPayoutSettings = JSON.parse(body.buybackPayoutSettings)
    } catch {
      res.status(400).json({
        success: false,
        message: 'Invalid buyback payout configuration format',
      })
      return null
    }
  }
  if (!body.buybackPayoutSettings) {
    return undefined
  }
  const settings = body.buybackPayoutSettings
  const numericFields = [
    'deviceCooldownDays',
    'customerSellLimitCount',
    'customerSellLimitWindowDays',
  ]
  for (const field of numericFields) {
    const value = Number(settings[field] || 0)
    if (!Number.isFinite(value) || value < 0) {
      res.status(400).json({
        success: false,
        message: `${field} must be zero or a positive number`,
      })
      return null
    }
    settings[field] = value
  }
  const hasCustomerLimit = settings.customerSellLimitCount > 0
  const hasCustomerWindow = settings.customerSellLimitWindowDays > 0
  if (hasCustomerLimit !== hasCustomerWindow) {
    res.status(400).json({
      success: false,
      message:
        'Customer device limit and customer limit window must both be configured',
    })
    return null
  }
  settings.enabled = settings.enabled === true
  return settings
}

const handleStorePaymentSettings = (body, res) => {
  if (
    body.storePaymentSettings &&
    typeof body.storePaymentSettings === 'string'
  ) {
    try {
      body.storePaymentSettings = JSON.parse(body.storePaymentSettings)
    } catch {
      res.status(400).json({
        success: false,
        message: 'Invalid store payment configuration format',
      })
      return null
    }
  }
  if (!body.storePaymentSettings) {
    return undefined
  }
  const allowedModes = [
    'COMPANY_ACCOUNTS',
    'MANAGER_FUNDS',
    'PREPAID_DEFERRED',
  ]
  if (!allowedModes.includes(body.storePaymentSettings.mode)) {
    res.status(400).json({
      success: false,
      message: 'Invalid store payment permission mode',
    })
    return null
  }
  return { mode: body.storePaymentSettings.mode }
}

const handleDocumentUploads = async (body, files, existingDocuments) => {
  body.attachedDocuments = existingDocuments || []
  if (files && files.length > 0) {
    for (const file of files) {
      const location = await s3Controller.uploadFile(file)
      if (location) {
        body.attachedDocuments.push({
          fileName: file.originalname,
          fileUrl: location,
          fileType: file.mimetype,
          uploadedAt: new Date(),
        })
      }
    }
  }
}

const create = async (req, res) => {
  const userId = req.userId

  try {
    // Validate company data
    const validation = validateCompanyRegistration(req.body)
    if (!validation.valid) {
      return res
        .status(400)
        .json({ success: false, message: 'Validation failed', errors: validation.errors })
    }

    // Handle email configuration
    if (handleEmailConfiguration(req.body, res) === null) {
      return res
    }
    if (handleBuybackPayoutSettings(req.body, res) === null) {
      return res
    }
    if (handleStorePaymentSettings(req.body, res) === null) {
      return res
    }
    if (
      (req.body.buybackPayoutSettings || req.body.storePaymentSettings) &&
      req.userRole !== ROLES.SUPER_ADMIN
    ) {
      return res.status(403).json({
        success: false,
        message:
          'Only the Super Admin can configure company payouts',
      })
    }

    // Check if GST number already exists
    const gstNumber = req.body.gstNumber
    const existingCompany = await companyModel.findOne({ gstNumber })
    if (existingCompany) {
      return res
        .status(400)
        .json({ success: false, message: 'Company with this GST number already exists' })
    }

    // Prepare company data
    const companyData = {
      name: req.body.name,
      contactNumber: req.body.contactNumber,
      address: req.body.address,
      gstNumber: gstNumber,
      panNumber: req.body.panNumber,
      remarks: req.body.remarks || '',
      showPrice: req.body.showPrice || false,
      maskInfo: req.body.maskInfo || false,
      aadharVerificationRequired: req.body.aadharVerificationRequired !== undefined ? req.body.aadharVerificationRequired : true,
      attachedDocuments: req.body.attachedDocuments || [],
      emailConfiguration: req.body.emailConfiguration,
      buybackPayoutSettings: req.body.buybackPayoutSettings,
      storePaymentSettings: req.body.storePaymentSettings,
      createdBy: userId,
    }

    // Save company first to get the ID
    const company = await companyModel(companyData).save()

    // Generate and update companyCode
    const companyCode = await generateCompanyCode(
      companyModel,
      companyData.name,
    )
    company.companyCode = companyCode
    await company.save()

    return res.status(201).json({
      message: 'Company created successfully',
      result: company,
    })
  } catch (error) {
    safeLog.error('Company creation error:', error)
    return res.status(500).json({ success: false, message: error.message })
  }
}

const update = async (req, res) => {
  const userId = req.userId
  req.body.updatedBy = userId
  delete req.body.createdBy
  delete req.body.companyCode // Prevent changing auto-generated code

  try {
    const exists = await companyModel.findById(req.body._id || req.body.id)

    if (!exists) {
      return res.status(404).json({ success: false, message: 'Company not found' })
    }

    // Check company scoping - only SuperAdmin can update other companies
    if (
      req.userRole !== ROLES.SUPER_ADMIN &&
      exists._id.toString() !== req.userCompanyId.toString()
    ) {
      return res
        .status(403)
        .json({ success: false, message: 'Forbidden: Cannot update another company' })
    }

    // Handle email configuration
    if (handleEmailConfiguration(req.body, res) === null) {
      return res
    }
    const buybackSettings = handleBuybackPayoutSettings(req.body, res)
    if (buybackSettings === null) {
      return res
    }
    const storePaymentSettings = handleStorePaymentSettings(req.body, res)
    if (storePaymentSettings === null) {
      return res
    }
    if (
      (buybackSettings !== undefined || storePaymentSettings !== undefined) &&
      req.userRole !== ROLES.SUPER_ADMIN
    ) {
      return res.status(403).json({
        success: false,
        message:
          'Only the Super Admin can change company payment configuration',
      })
    }

    // Handle document uploads
    await handleDocumentUploads(req.body, req.files, exists.attachedDocuments)

    const result = await companyModel.findByIdAndUpdate(
      req.body._id || req.body.id,
      req.body,
      { new: true, runValidators: true },
    )

    return res.status(200).json({
      message: 'Company updated successfully',
      result,
    })
  } catch (error) {
    safeLog.error('Company update error:', error)
    return res.status(500).json({ success: false, message: error.message })
  }
}

const deleteById = async (req, res) => {
  try {
    const result = await companyModel.findByIdAndDelete({
      _id: req.query._id || req.query.id,
    })
    return res.status(200).json({ result })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

const findById = async (req, res) => {
  try {
    const result = await companyModel.findById({
      _id: req.query._id || req.query.id,
    })
    const pricingConfig = await BonusSlabConfig.findOne({ companyId: result._id }).lean()
    let dynamicPricingStatus = 'OFF'
    if (pricingConfig && pricingConfig.isEnabled) {
      dynamicPricingStatus = pricingConfig.slabs && pricingConfig.slabs.length > 0 ? 'ON' : 'Config Pending'
    }
    return res.status(200).json({
      result: {
        ...result.toObject(),
        dynamicPricingStatus,
        isDynamicPricingEnabled: pricingConfig?.isEnabled || false
      }
    })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

const getPricingStatus = (config) => {
  if (!config.isEnabled) {
    return 'OFF'
  }
  return config.slabs && config.slabs.length > 0 ? 'ON' : 'Config Pending'
}

const buildPricingMap = (pricingConfigs) => {
  const pricingMap = {}
  for (const config of pricingConfigs) {
    pricingMap[config.companyId.toString()] = {
      dynamicPricingStatus: getPricingStatus(config),
      isEnabled: config.isEnabled,
      slabCount: config.slabs ? config.slabs.length : 0
    }
  }
  return pricingMap
}

const buildPricingStatusFilter = async (pricingStatus, existingQueryId) => {
  if (pricingStatus !== 'enabled' && pricingStatus !== 'disabled') {
    return null
  }

  const enabledConfigs = await BonusSlabConfig.find({ isEnabled: true }).select('companyId').lean()
  const enabledIds = enabledConfigs.map(c => c.companyId.toString())

  if (!existingQueryId) {
    if (pricingStatus === 'enabled') {
      return { $in: enabledConfigs.map(c => c.companyId) }
    }
    return { $nin: enabledIds }
  }

  const isInEnabled = enabledIds.includes(existingQueryId.toString())
  const matchesStatus = pricingStatus === 'enabled' ? isInEnabled : !isInEnabled

  if (matchesStatus) {
    return existingQueryId
  }
  return { $in: [] }
}

const findAll = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10
    const page = parseInt(req.query.page) || 0
    const query = {}

    if (req.userRole !== ROLES.SUPER_ADMIN) {
      query._id = req.userCompanyId
    }

    const search = req.query.search || ''
    if (search) {
      query['$or'] = [
        { name: { $regex: search, $options: 'i' } },
        { companyCode: { $regex: search, $options: 'i' } },
        { contactNumber: { $regex: search, $options: 'i' } },
        { address: { $regex: search, $options: 'i' } },
        { gstNumber: { $regex: search, $options: 'i' } },
        { panNumber: { $regex: search, $options: 'i' } },
      ]
    }

    if (req.query.status) {
      query.status = req.query.status
    }

    const pricingFilter = await buildPricingStatusFilter(req.query.pricing_status, query._id)
    if (pricingFilter) {
      query._id = pricingFilter
    }

    const result = await companyModel
      .find(query)
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(limit * page)
      .lean()

    const companyIds = result.map(c => c._id)
    const pricingConfigs = await BonusSlabConfig.find({ companyId: { $in: companyIds } }).lean()
    const pricingMap = buildPricingMap(pricingConfigs)

    const enrichedResult = result.map(c => ({
      ...c,
      dynamicPricingStatus: pricingMap[c._id.toString()]?.dynamicPricingStatus || 'OFF',
      isDynamicPricingEnabled: pricingMap[c._id.toString()]?.isEnabled || false
    }))

    const decryptedResult = await decryptPIIFieldsArray(enrichedResult, PII_FIELDS_TO_ENCRYPT)

    const totalRecords = await companyModel.countDocuments(query)

    return res.status(200).json({
      result: decryptedResult,
      totalRecords,
      currentPage: page,
      totalPages: Math.ceil(totalRecords / limit),
    })
  } catch (error) {
    safeLog.error('Find all companies error:', error)
    return res.status(500).json({ success: false, message: error.message })
  }
}

const bulkToggleAadharVerification = async (req, res) => {
  try {
    const { companyIds, aadharVerificationRequired } = req.body

    if (!companyIds || !Array.isArray(companyIds) || companyIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Please select at least one company to update' })
    }

    if (typeof aadharVerificationRequired !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Invalid request. Please try again.' })
    }

    const result = await companyModel.updateMany(
      { _id: { $in: companyIds } },
      {
        $set: {
          aadharVerificationRequired,
          updatedBy: req.userId,
        }
      }
    )

    return res.status(200).json({
      success: true,
      message: `Aadhaar verification ${aadharVerificationRequired ? 'enabled' : 'disabled'}` +
        ` successfully for ${result.modifiedCount} ${result.modifiedCount === 1 ? 'company' : 'companies'}`,
      data: { modifiedCount: result.modifiedCount }
    })
  } catch (error) {
    safeLog.error('Bulk toggle Aadhaar verification error:', error)
    return res.status(500).json({ success: false, message: error.message })
  }
}

const bulkToggleBuybackPayout = async (req, res) => {
  try {
    const { companyIds, enabled } = req.body

    if (req.user?.role !== ROLES.SUPER_ADMIN) {
      return res.status(403).json({
        success: false,
        message: 'Only the Super Admin can enable or disable company payouts',
      })
    }

    if (!companyIds || !Array.isArray(companyIds) || companyIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Please select at least one company to update' })
    }

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Invalid request. Please try again.' })
    }

    const result = await companyModel.updateMany(
      { _id: { $in: companyIds } },
      {
        $set: {
          'buybackPayoutSettings.enabled': enabled,
          updatedBy: req.userId,
        }
      }
    )

    return res.status(200).json({
      success: true,
      message: `HSBC UPI payout ${enabled ? 'enabled' : 'disabled'}` +
        ` successfully for ${result.modifiedCount} ${result.modifiedCount === 1 ? 'company' : 'companies'}`,
      data: { modifiedCount: result.modifiedCount }
    })
  } catch (error) {
    safeLog.error('Bulk toggle buyback payout error:', error)
    return res.status(500).json({ success: false, message: error.message })
  }
}

const uploadData = async (req, res) => {
  try {
    const updated = []
    const inserted = []
    const data = csv.convertCsvToJson(req.file.buffer.toString().split('\n'))
    for (let i = 0; i < data.length; i++) {
      const exists = await companyModel.findOne({
        gstNumber: data[i].gstNumber,
      })
      if (exists) {
        const up = await companyModel.findByIdAndUpdate(
          { _id: exists._id },
          data[i],
        )
        updated.push(up)
      } else {
        const saved = await companyModel(data[i]).save()
        inserted.push(saved)
      }
    }
    return res.status(200).json({ updated, inserted })
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message })
  }
}

export default { create, update, deleteById, findById, findAll, uploadData, bulkToggleAadharVerification, bulkToggleBuybackPayout }
