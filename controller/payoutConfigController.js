import { safeLog } from '../utils/piiMasking.js'
import {
  PayoutConfigError,
  getCompanyPayoutConfig,
  updateCompanyPayoutConfig,
  getStorePayoutConfig,
  updateStorePayoutConfig,
} from '../services/payoutConfigService.js'

const handleError = (res, error, fallbackMessage) => {
  if (error instanceof PayoutConfigError) {
    return res
      .status(error.statusCode)
      .json({ success: false, message: error.message })
  }
  safeLog.error(fallbackMessage, error)
  return res.status(500).json({ success: false, message: fallbackMessage })
}

const getCompany = async (req, res) => {
  try {
    const data = await getCompanyPayoutConfig({
      actorId: req.userId,
      companyId: req.query.companyId,
    })
    return res.status(200).json({ success: true, data })
  } catch (error) {
    return handleError(res, error, 'Unable to load company payout configuration')
  }
}

const updateCompany = async (req, res) => {
  try {
    const data = await updateCompanyPayoutConfig({
      actorId: req.userId,
      companyId: req.body.companyId,
      settings: req.body.buybackPayoutSettings || req.body.settings || req.body,
    })
    return res.status(200).json({ success: true, data })
  } catch (error) {
    return handleError(res, error, 'Unable to update company payout configuration')
  }
}

const getStore = async (req, res) => {
  try {
    const data = await getStorePayoutConfig({
      actorId: req.userId,
      storeId: req.params.storeId,
    })
    return res.status(200).json({ success: true, data })
  } catch (error) {
    return handleError(res, error, 'Unable to load store payout configuration')
  }
}

const updateStore = async (req, res) => {
  try {
    const data = await updateStorePayoutConfig({
      actorId: req.userId,
      storeId: req.params.storeId,
      settings: req.body.payoutSettings || req.body.settings || req.body,
    })
    return res.status(200).json({ success: true, data })
  } catch (error) {
    return handleError(res, error, 'Unable to update store payout configuration')
  }
}

export default { getCompany, updateCompany, getStore, updateStore }
