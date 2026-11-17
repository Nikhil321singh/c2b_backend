import companyModel from '../models/companyModel.js'
import storeModel from '../models/storeModel.js'

// Vijay Sales company code
const VIJAY_SALES_COMPANY_CODE = 'COMPVSIPL7'

export const getVijaySalesStoreIds = async () => {
  const company = await companyModel
    .findOne({ companyCode: VIJAY_SALES_COMPANY_CODE, status: 'active' })
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

export const isVijaySalesStore = async (storeId) => {
  if (!storeId) {
    return false
  }

  const vijaySalesStoreIds = await getVijaySalesStoreIds()
  return vijaySalesStoreIds.includes(storeId.toString())
}

export default {
  getVijaySalesStoreIds,
  isVijaySalesStore,
}
