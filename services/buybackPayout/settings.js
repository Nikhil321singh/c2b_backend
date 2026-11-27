import leads from '../../models/leadsModel.js'
import storeModel from '../../models/storeModel.js'
import {
  PayoutBusinessError,
  resolveStorePayoutCeiling,
  assertWithinPayoutCeiling,
  identityHash,
  SUPPORTED_HSBC_MODES,
  LEAD_PAYMENT_PENDING_STATUS,
} from './validation.js'

// A pending HSBC payout is not a sale yet, but it must still count towards
// the device cooldown and customer limits, or pending links would bypass them.
export const SOLD_OR_PAYMENT_PENDING = {
  $or: [{ is_selled: true }, { status: LEAD_PAYMENT_PENDING_STATUS }],
}

const getStorePayoutSettings = async (storeId) => {
  const store = await storeModel
    .findById(storeId)
    .select('payoutSettings companyId storeName')
    .populate('companyId', 'buybackPayoutSettings')
  if (!store) {
    throw new PayoutBusinessError('Store not found', 404)
  }

  const forceDevelopmentPayout =
    process.env.NODE_ENV !== 'production' &&
    process.env.PAYOUT_FORCE_HSBC_IN_DEVELOPMENT === 'true'

  const companySettings = store.companyId?.buybackPayoutSettings || {}

  return {
    companyEnabled:
      forceDevelopmentPayout || companySettings.enabled === true,
    enabled:
      forceDevelopmentPayout || store.payoutSettings?.enabled === true,
    mode: forceDevelopmentPayout
      ? 'HSBC_UPI'
      : store.payoutSettings?.mode || 'MANUAL',
    approvalEnabled: store.payoutSettings?.approvalEnabled === true,
    approvalThreshold: Number(
      store.payoutSettings?.approvalThreshold || 0,
    ),
    payoutCeiling: resolveStorePayoutCeiling(
      store.payoutSettings?.payoutCeiling,
    ),
    customerLinkExpiryMinutes: Number(
      store.payoutSettings?.customerLinkExpiryMinutes || 30,
    ),
    deviceCooldownDays: Number(companySettings.deviceCooldownDays || 0),
    customerSellLimitCount: Number(
      companySettings.customerSellLimitCount || 0,
    ),
    customerSellLimitWindowDays: Number(
      companySettings.customerSellLimitWindowDays || 0,
    ),
  }
}

const requiresApproval = (settings, amount) =>
  settings.approvalEnabled &&
  (settings.approvalThreshold <= 0 || amount >= settings.approvalThreshold)

export const getPayoutModeForStore = async (storeId) => {
  if (!storeId) {
    return {
      mode: 'MANUAL',
      settings: {
        enabled: false,
        mode: 'MANUAL',
        approvalEnabled: false,
        approvalThreshold: 0,
        customerLinkExpiryMinutes: 30,
      },
    }
  }
  const settings = await getStorePayoutSettings(storeId)
  return (
    settings.companyEnabled &&
    settings.enabled &&
    SUPPORTED_HSBC_MODES.includes(settings.mode)
  )
    ? { mode: settings.mode, settings }
    : { mode: 'MANUAL', settings }
}

const assertDeviceCooldown = async ({
  lead,
  deviceIdentityHash,
  cooldownDays,
}) => {
  if (cooldownDays <= 0) {
    return
  }
  const cooldownStart = new Date(
    Date.now() - cooldownDays * 24 * 60 * 60 * 1000,
  )
  const previousDeviceSale = await leads
    .findOne({
      _id: { $ne: lead._id },
      deviceIdentityHash,
      $and: [
        SOLD_OR_PAYMENT_PENDING,
        {
          $or: [
            { soldAt: { $gte: cooldownStart } },
            {
              soldAt: { $exists: false },
              updatedAt: { $gte: cooldownStart },
            },
          ],
        },
      ],
    })
    .select('_id uniqueCode updatedAt')
    .lean()
  if (previousDeviceSale) {
    throw new PayoutBusinessError(
      `Device cooldown validation failed. This device was sold within the last ${cooldownDays} days`,
      409,
    )
  }
}

const assertCustomerSellLimit = async ({
  lead,
  customerIdentityHash,
  settings,
}) => {
  if (
    settings.customerSellLimitCount <= 0 ||
    settings.customerSellLimitWindowDays <= 0
  ) {
    return
  }
  const windowStart = new Date(
    Date.now() -
      settings.customerSellLimitWindowDays * 24 * 60 * 60 * 1000,
  )
  const previousSales = await leads.countDocuments({
    _id: { $ne: lead._id },
    customerIdentityHash,
    $and: [
      SOLD_OR_PAYMENT_PENDING,
      {
        $or: [
          { soldAt: { $gte: windowStart } },
          {
            soldAt: { $exists: false },
            createdAt: { $gte: windowStart },
          },
        ],
      },
    ],
  })
  if (previousSales >= settings.customerSellLimitCount) {
    throw new PayoutBusinessError(
      `Customer selling limit reached: ${settings.customerSellLimitCount} device(s) in ${settings.customerSellLimitWindowDays} days`,
      409,
    )
  }
}

export const validatePayoutEligibility = async ({
  lead,
  amount,
  settings,
}) => {
  assertWithinPayoutCeiling(amount, settings.payoutCeiling)

  const customerIdentity = String(lead.phoneNumber || '').replace(/\D/g, '')
  const deviceIdentity = String(lead.documentId?.IMEI || '').trim()
  const customerIdentityHash = customerIdentity
    ? identityHash(customerIdentity)
    : ''
  const deviceIdentityHash = deviceIdentity
    ? identityHash(deviceIdentity)
    : ''

  if (settings.deviceCooldownDays > 0 && !deviceIdentityHash) {
    throw new PayoutBusinessError(
      'Device IMEI is required for the configured cooldown validation',
      409,
    )
  }
  if (
    settings.customerSellLimitCount > 0 &&
    settings.customerSellLimitWindowDays > 0 &&
    !customerIdentityHash
  ) {
    throw new PayoutBusinessError(
      'Customer phone number is required for the configured selling limit',
      409,
    )
  }

  await leads.findByIdAndUpdate(lead._id, {
    ...(deviceIdentityHash ? { deviceIdentityHash } : {}),
    ...(customerIdentityHash ? { customerIdentityHash } : {}),
  })

  await assertDeviceCooldown({
    lead,
    deviceIdentityHash,
    cooldownDays: settings.deviceCooldownDays,
  })
  await assertCustomerSellLimit({ lead, customerIdentityHash, settings })
}

export { getStorePayoutSettings, requiresApproval }
