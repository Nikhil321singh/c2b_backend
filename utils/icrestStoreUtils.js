import companyModel from '../models/companyModel.js'
import storeModel from '../models/storeModel.js'

// iCrest company code
const ICREST_COMPANY_CODE = 'COMPMNTL5'

export const getIcrestStoreIds = async () => {
  const company = await companyModel
    .findOne({ companyCode: ICREST_COMPANY_CODE, status: 'active' })
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

export const isIcrestStore = async (storeId) => {
  if (!storeId) {
    return false
  }

  const icrestStoreIds = await getIcrestStoreIds()
  return icrestStoreIds.includes(storeId.toString())
}

export default {
  getIcrestStoreIds,
  isIcrestStore,
}
