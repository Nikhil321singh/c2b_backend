import BonusSlabConfig from '../models/BonusSlabConfig.js'
import companyModel from '../models/companyModel.js'
import { safeLog } from '../utils/piiMasking.js'
import { getMaxNegotiationAmount, DEFAULT_NEGOTIATION_LIMIT } from '../utils/negotiationLimitUtils.js'
import xlsx from 'xlsx'

const REQUIRED_COMPANY_ID = 'Company ID is required'
const POPULATE_NAME_EMAIL = 'name email'

const validateSingleSlab = (sorted, i) => {
  const slab = sorted[i]
  const errors = []

  if (slab.minValue < 0) {
    errors.push(`Slab ${i + 1}: Min Value cannot be negative`)
  }

  if (slab.maxValue <= slab.minValue) {
    errors.push(`Slab ${i + 1}: Max Value (${slab.maxValue}) must be greater than Min Value (${slab.minValue})`)
  }

  if (slab.bonusAmount < 0) {
    errors.push(`Slab ${i + 1}: Bonus Amount cannot be negative`)
  }

  if (slab.bonusAmount > 100000) {
    errors.push(`Slab ${i + 1}: Bonus Amount (${slab.bonusAmount}) cannot exceed ₹1,00,000`)
  }

  if (slab.bonusAmount > slab.maxValue) {
    errors.push(`Slab ${i + 1}: Bonus Amount (${slab.bonusAmount}) cannot exceed Max Value (${slab.maxValue})`)
  }

  if (i > 0 && sorted[i - 1].maxValue >= slab.minValue) {
    errors.push(`Slab ${i} (${sorted[i - 1].minValue}-${sorted[i - 1].maxValue}) overlaps with Slab ${i + 1} (${slab.minValue}-${slab.maxValue})`)
  }

  if (i > 0 && sorted[i - 1].maxValue + 1 < slab.minValue) {
    errors.push(`Gap detected between Slab ${i} (max: ${sorted[i - 1].maxValue}) and Slab ${i + 1} (min: ${slab.minValue}). Slabs must be contiguous.`)
  }

  return errors
}

const validateSlabs = (slabs) => {
  const errors = []

  if (!slabs || !Array.isArray(slabs) || slabs.length === 0) {
    return { valid: false, errors: ['At least one slab is required'] }
  }

  if (slabs.length > 20) {
    return { valid: false, errors: ['Maximum 20 slabs allowed'] }
  }

  const sorted = [...slabs].sort((a, b) => a.minValue - b.minValue)

  for (let i = 0; i < sorted.length; i++) {
    errors.push(...validateSingleSlab(sorted, i))
  }

  return { valid: errors.length === 0, errors }
}

const matchSlabForValue = (slabs, exactValue) => {
  if (!slabs || slabs.length === 0 || exactValue == null) {
    return null
  }

  const sorted = [...slabs].sort((a, b) => a.minValue - b.minValue)

  for (const slab of sorted) {
    if (exactValue >= slab.minValue && exactValue <= slab.maxValue) {
      return slab
    }
  }

  if (exactValue < sorted[0].minValue) {
    return null
  }

  return sorted[sorted.length - 1]
}

const addAuditLog = (config, userId, action, changes = {}) => {
  config.auditLog.push({
    timestamp: new Date(),
    userId,
    action,
    changes
  })
}

const validateEffectiveDate = (effectiveFrom) => {
  if (!effectiveFrom) {
    return null
  }
  const effDate = new Date(effectiveFrom)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  effDate.setHours(0, 0, 0, 0)
  if (effDate < today) {
    return 'Effective From Date cannot be set in the past'
  }
  return null
}

const determineAction = (isEnabled, oldIsEnabled) => {
  if (isEnabled === undefined || isEnabled === oldIsEnabled) {
    return 'Updated'
  }
  return isEnabled ? 'FeatureEnabled' : 'FeatureDisabled'
}

const determineUpdateMessage = (isEnabled, oldIsEnabled) => {
  if (isEnabled !== undefined && isEnabled !== oldIsEnabled) {
    return `Dynamic Pricing ${isEnabled ? 'enabled' : 'disabled'} successfully`
  }
  return 'Bonus slab configuration updated successfully'
}

const handleUpdate = async (config, userId, isEnabled, slabs, effectiveFrom, notes, res) => {
  const dateError = validateEffectiveDate(effectiveFrom)
  if (dateError) {
    return res.status(400).json({ success: false, message: dateError })
  }

  const oldConfig = {
    isEnabled: config.isEnabled,
    slabs: JSON.parse(JSON.stringify(config.slabs)),
    effectiveFrom: config.effectiveFrom,
    notes: config.notes
  }

  config.isEnabled = isEnabled !== undefined ? isEnabled : config.isEnabled
  if (slabs) {
    config.slabs = slabs
  }
  if (effectiveFrom) {
    config.effectiveFrom = new Date(effectiveFrom)
  }
  if (notes !== undefined) {
    config.notes = notes
  }
  config.updatedBy = userId

  const action = determineAction(isEnabled, oldConfig.isEnabled)

  addAuditLog(config, userId, action, {
    before: oldConfig,
    after: {
      isEnabled: config.isEnabled,
      slabs: JSON.parse(JSON.stringify(config.slabs)),
      effectiveFrom: config.effectiveFrom,
      notes: config.notes
    }
  })

  await config.save()

  return res.status(200).json({
    success: true,
    message: determineUpdateMessage(isEnabled, oldConfig.isEnabled),
    data: config
  })
}

const handleCreate = async (companyId, userId, isEnabled, slabs, effectiveFrom, notes, res) => {
  if (isEnabled && (!slabs || slabs.length === 0)) {
    return res.status(400).json({
      success: false,
      message: 'Please add at least one pricing slab when enabling the feature'
    })
  }

  const config = new BonusSlabConfig({
    companyId,
    isEnabled: isEnabled || false,
    slabs: slabs || [],
    effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
    notes: notes || '',
    createdBy: userId,
    updatedBy: userId
  })

  addAuditLog(config, userId, 'Created', {
    isEnabled: config.isEnabled,
    slabs: JSON.parse(JSON.stringify(config.slabs)),
    effectiveFrom: config.effectiveFrom
  })

  await config.save()

  return res.status(201).json({
    success: true,
    message: 'Bonus slab configuration created successfully',
    data: config
  })
}

const createOrUpdate = async (req, res) => {
  try {
    const userId = req.userId
    const { companyId, isEnabled, slabs, effectiveFrom, notes } = req.body

    if (!companyId) {
      return res.status(400).json({ success: false, message: REQUIRED_COMPANY_ID })
    }

    const company = await companyModel.findById(companyId)
    if (!company) {
      return res.status(404).json({ success: false, message: 'Company not found' })
    }

    if (isEnabled) {
      if (!slabs || slabs.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Please add at least one pricing slab when feature is enabled'
        })
      }

      const validation = validateSlabs(slabs)
      if (!validation.valid) {
        return res.status(400).json({ success: false, message: 'Slab validation failed', errors: validation.errors })
      }

      const dateError = validateEffectiveDate(effectiveFrom)
      if (dateError) {
        return res.status(400).json({ success: false, message: dateError })
      }
    }

    const config = await BonusSlabConfig.findOne({ companyId })

    if (config) {
      return handleUpdate(config, userId, isEnabled, slabs, effectiveFrom, notes, res)
    }

    return handleCreate(companyId, userId, isEnabled, slabs, effectiveFrom, notes, res)
  } catch (error) {
    safeLog.error('BonusSlab createOrUpdate error:', error)
    return res.status(500).json({ success: false, message: error.message })
  }
}

const getByCompanyId = async (req, res) => {
  try {
    const { companyId } = req.params

    if (!companyId) {
      return res.status(400).json({ success: false, message: REQUIRED_COMPANY_ID })
    }

    const config = await BonusSlabConfig.findOne({ companyId })
      .populate('createdBy', POPULATE_NAME_EMAIL)
      .populate('updatedBy', POPULATE_NAME_EMAIL)

    return res.status(200).json({
      success: true,
      data: config || {
        companyId,
        isEnabled: false,
        slabs: [],
        effectiveFrom: null,
        notes: ''
      }
    })
  } catch (error) {
    safeLog.error('BonusSlab getByCompanyId error:', error)
    return res.status(500).json({ success: false, message: error.message })
  }
}

const getAll = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 0
    const limit = parseInt(req.query.limit) || 20
    const status = req.query.status

    const query = {}
    if (status === 'enabled') {
      query.isEnabled = true
    } else if (status === 'disabled') {
      query.isEnabled = false
    } else if (status === 'pending') {
      query.isEnabled = true
      query.$or = [
        { slabs: { $exists: false } },
        { slabs: { $size: 0 } }
      ]
    }

    const configs = await BonusSlabConfig.find(query)
      .populate('companyId', 'name companyCode')
      .populate('createdBy', POPULATE_NAME_EMAIL)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .skip(page * limit)
      .lean()

    const totalRecords = await BonusSlabConfig.countDocuments(query)

    return res.status(200).json({
      success: true,
      data: configs,
      totalRecords,
      currentPage: page,
      totalPages: Math.ceil(totalRecords / limit)
    })
  } catch (error) {
    safeLog.error('BonusSlab getAll error:', error)
    return res.status(500).json({ success: false, message: error.message })
  }
}

const remove = async (req, res) => {
  try {
    const userId = req.userId
    const { companyId } = req.params

    if (!companyId) {
      return res.status(400).json({ success: false, message: REQUIRED_COMPANY_ID })
    }

    const config = await BonusSlabConfig.findOne({ companyId })
    if (!config) {
      return res.status(404).json({ success: false, message: 'Configuration not found' })
    }

    addAuditLog(config, userId, 'Deleted', {
      previousConfig: {
        isEnabled: config.isEnabled,
        slabs: JSON.parse(JSON.stringify(config.slabs))
      }
    })

    await BonusSlabConfig.deleteOne({ companyId })

    return res.status(200).json({
      success: true,
      message: 'Bonus slab configuration deleted successfully'
    })
  } catch (error) {
    safeLog.error('BonusSlab remove error:', error)
    return res.status(500).json({ success: false, message: error.message })
  }
}

function buildBonusData(exactValue, opts = {}) {
  const {
    slabBonusAmount = 0,
    negotiatedAmount = 0,
    couponDiscount = 0,
    quotedPrice,
    slabApplied = null,
    isDynamicPricingEnabled = false,
    maxNegotiationAmount = DEFAULT_NEGOTIATION_LIMIT,
    ...extra
  } = opts

  return {
    success: true,
    data: {
      exactValue,
      slabBonusAmount,
      negotiatedAmount,
      couponDiscount,
      quotedPrice: quotedPrice < 0 ? 0 : quotedPrice,
      slabApplied,
      isDynamicPricingEnabled,
      maxNegotiationAmount,
      ...extra,
    }
  }
}

const calculateBonus = async (req, res) => {
  try {
    const { companyId, exactValue, applyNegotiatedAmount, negotiatedAmount, couponDiscount } = req.body

    if (exactValue == null) {
      return res.status(400).json({ success: false, message: 'Exact Value is required' })
    }

    const na = negotiatedAmount || 0
    const cd = couponDiscount || 0
    const maxNegotiationAmount = await getMaxNegotiationAmount(companyId)
    const noPricingData = { slabBonusAmount: 0, negotiatedAmount: na, couponDiscount: cd, slabApplied: null, maxNegotiationAmount }

    if (applyNegotiatedAmount && na > maxNegotiationAmount) {
      return res.status(400).json({
        success: false,
        message: `Negotiated amount cannot exceed ₹${maxNegotiationAmount}`,
      })
    }

    if (!companyId) {
      return res.status(200).json(buildBonusData(exactValue, { ...noPricingData, quotedPrice: exactValue + na + cd, isDynamicPricingEnabled: false }))
    }

    const config = await BonusSlabConfig.findOne({ companyId, isEnabled: true })

    if (!config) {
      return res.status(200).json(buildBonusData(exactValue, { ...noPricingData, quotedPrice: exactValue + na + cd, isDynamicPricingEnabled: false }))
    }

    const effectiveFrom = config.effectiveFrom ? new Date(config.effectiveFrom) : null
    const today = new Date()
    if (effectiveFrom && effectiveFrom > today) {
      return res.status(200).json(buildBonusData(exactValue, {
        ...noPricingData,
        quotedPrice: exactValue + na + cd,
        isDynamicPricingEnabled: true,
        effectiveFrom: config.effectiveFrom,
        message: 'Dynamic pricing is not yet effective',
      }))
    }

    const matchedSlab = matchSlabForValue(config.slabs, exactValue)
    const slabBonusAmount = matchedSlab ? matchedSlab.bonusAmount : 0
    const finalNa = applyNegotiatedAmount ? na : 0
    const quotedPrice = exactValue - slabBonusAmount + finalNa + cd

    return res.status(200).json(buildBonusData(exactValue, {
      slabBonusAmount,
      negotiatedAmount: finalNa,
      couponDiscount: cd,
      quotedPrice,
      slabApplied: matchedSlab ? `${matchedSlab.minValue} - ${matchedSlab.maxValue}` : null,
      slabDetail: matchedSlab,
      isDynamicPricingEnabled: true,
      maxNegotiationAmount,
    }))
  } catch (error) {
    safeLog.error('BonusSlab calculateBonus error:', error)
    return res.status(500).json({ success: false, message: error.message })
  }
}

const bulkToggle = async (req, res) => {
  try {
    const userId = req.userId
    const { companyIds, isEnabled } = req.body

    if (!companyIds || !Array.isArray(companyIds) || companyIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Company IDs array is required' })
    }

    if (typeof isEnabled !== 'boolean') {
      return res.status(400).json({ success: false, message: 'isEnabled must be a boolean' })
    }

    const companies = await companyModel.find({ _id: { $in: companyIds } })
    if (companies.length !== companyIds.length) {
      return res.status(400).json({ success: false, message: 'One or more companies not found' })
    }

    const results = []
    for (const companyId of companyIds) {
      const config = await BonusSlabConfig.findOne({ companyId })

      if (config) {
        const oldEnabled = config.isEnabled
        config.isEnabled = isEnabled
        config.updatedBy = userId

        addAuditLog(config, userId, isEnabled ? 'FeatureEnabled' : 'FeatureDisabled', {
          before: { isEnabled: oldEnabled },
          after: { isEnabled }
        })

        await config.save()
        results.push({ companyId, status: 'updated', previousState: oldEnabled, newState: isEnabled })
      } else if (isEnabled) {
        results.push({ companyId, status: 'skipped', reason: 'No configuration exists; enable via company edit first' })
      } else {
        results.push({ companyId, status: 'skipped', reason: 'No configuration exists' })
      }
    }

    return res.status(200).json({
      success: true,
      message: `Bulk ${isEnabled ? 'enable' : 'disable'} completed for ${results.filter(r => r.status === 'updated').length} company(ies)`,
      data: { results }
    })
  } catch (error) {
    safeLog.error('BonusSlab bulkToggle error:', error)
    return res.status(500).json({ success: false, message: error.message })
  }
}

function buildExcelRow(config) {
  const companyName = config.companyId?.name || 'Unknown'
  const companyCode = config.companyId?.companyCode || 'N/A'

  let slabsText = ''
  if (config.slabs && config.slabs.length > 0) {
    slabsText = config.slabs
      .map(s => `${s.minValue}-${s.maxValue}: Rs.${s.bonusAmount}`)
      .join(', ')
  }

  return {
    'Company Name': companyName,
    'Company Code': companyCode,
    'Dynamic Pricing': config.isEnabled ? 'ON' : 'OFF',
    'Slabs': slabsText || (config.isEnabled ? 'Config Pending' : '-'),
    'Effective From': config.effectiveFrom ? new Date(config.effectiveFrom).toISOString().split('T')[0] : '',
    'Notes': config.notes || ''
  }
}

const exportConfig = async (req, res) => {
  try {
    const configs = await BonusSlabConfig.find({})
      .populate('companyId', 'name companyCode')
      .lean()

    const rows = configs.map(buildExcelRow)

    if (rows.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No pricing configurations found',
        data: []
      })
    }

    const wb = xlsx.utils.book_new()
    const ws = xlsx.utils.json_to_sheet(rows)
    xlsx.utils.book_append_sheet(wb, ws, 'Pricing Config')
    const buffer = xlsx.write(wb, { bookType: 'xlsx', type: 'buffer' })

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="dynamic_pricing_config.xlsx"')
    return res.status(200).send(buffer)
  } catch (error) {
    safeLog.error('BonusSlab exportConfig error:', error)
    return res.status(500).json({ success: false, message: error.message })
  }
}

const getConfigStatus = async (req, res) => {
  try {
    const { companyId } = req.params

    if (!companyId) {
      return res.status(400).json({ success: false, message: REQUIRED_COMPANY_ID })
    }

    const config = await BonusSlabConfig.findOne({ companyId })

    let status = 'OFF'
    if (config && config.isEnabled) {
      if (config.slabs && config.slabs.length > 0) {
        status = 'ON'
      } else {
        status = 'Config Pending'
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        companyId,
        status,
        isEnabled: config ? config.isEnabled : false,
        slabCount: config ? config.slabs.length : 0
      }
    })
  } catch (error) {
    safeLog.error('BonusSlab getConfigStatus error:', error)
    return res.status(500).json({ success: false, message: error.message })
  }
}

export default {
  createOrUpdate,
  getByCompanyId,
  getAll,
  remove,
  calculateBonus,
  bulkToggle,
  exportConfig,
  getConfigStatus,
  validateSlabs,
  matchSlabForValue
}
