import companyModel from '../models/companyModel.js'

export const DEFAULT_NEGOTIATION_LIMIT = 10000

const NEGOTIATION_LIMITS = {
  COMPSMPL2: 500, // SANGEETHA MOBILES PRIVATE LIMITED
}

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

export default {
  getMaxNegotiationAmount,
  DEFAULT_NEGOTIATION_LIMIT,
}
