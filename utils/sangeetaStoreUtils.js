import companyModel from '../models/companyModel.js'
import storeModel from '../models/storeModel.js'

// Sangeeta company code
const SANGEETA_COMPANY_CODE = 'COMPSMPL2'

export const getSangeetaStoreIds = async () => {
  const company = await companyModel
    .findOne({ companyCode: SANGEETA_COMPANY_CODE, status: 'active' })
    .select('_id')
    .lean()

  if (!company) {
    return []
  }

  const stores = await storeModel
    .find({ companyId: company._id })
    .select('_id')
    .lean()

  return stores.map((store) => store._id.toString())
}

export const isSangeetaStore = async (storeId) => {
  if (!storeId) {
    return false
  }

  const sangeetaStoreIds = await getSangeetaStoreIds()
  return sangeetaStoreIds.includes(storeId.toString())
}

export default {
  getSangeetaStoreIds,
  isSangeetaStore,
}
