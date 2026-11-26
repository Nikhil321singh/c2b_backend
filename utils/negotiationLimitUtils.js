import companyModel from '../models/companyModel.js'

// Maximum negotiation amount allowed for every company.
export const DEFAULT_NEGOTIATION_LIMIT = 2000

// Optional per-company overrides (companyCode -> limit).
const NEGOTIATION_LIMITS = {}

export const getMaxNegotiationAmount = async (companyId) => {
  if (!companyId) {
    return DEFAULT_NEGOTIATION_LIMIT
  }

  const company = await companyModel
    .findById(companyId)
    .select('companyCode')
    .lean()

  if (!company) {
    return DEFAULT_NEGOTIATION_LIMIT
  }

  return NEGOTIATION_LIMITS[company.companyCode] ?? DEFAULT_NEGOTIATION_LIMIT
}

export const negotiationLimitMessage = (maxNegotiationAmount) =>
  `Negotiation amount can be at most ₹${maxNegotiationAmount}. Please enter an amount of ₹${maxNegotiationAmount} or less to continue.`

export default {
  getMaxNegotiationAmount,
  negotiationLimitMessage,
  DEFAULT_NEGOTIATION_LIMIT,
}
