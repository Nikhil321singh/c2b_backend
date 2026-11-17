// Focused payout-configuration service: a single-responsibility read/update
// surface for company buyback settings and store payout settings, so a config
// UI doesn't have to drive the full company/store CRUD endpoints. Validation is
// reused (store side) or mirrors the schema (company side); the Mongoose models
// remain the ultimate validators.
import usersModel from '../models/UsersModel.js'
import companyModel from '../models/companyModel.js'
import storeModel from '../models/storeModel.js'
import { ROLES } from '../middlewares/rbac.js'
import { normalizePayoutSettings } from '../controller/storeController.js'

// Only company owners/superadmins manage payout configuration.
const CONFIG_ROLES = new Set([ROLES.SUPER_ADMIN, ROLES.COMPANY_ADMIN])

export class PayoutConfigError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

const toId = (value) => String(value?._id || value || '')
const asObject = (value) =>
  value && typeof value.toObject === 'function' ? value.toObject() : value || {}

const resolveActor = async (actorId) => {
  const actor = await usersModel
    .findById(actorId)
    .select('role companyId')
    .lean()
  if (!actor) {
    throw new PayoutConfigError('User not found', 404)
  }
  if (!CONFIG_ROLES.has(actor.role)) {
    throw new PayoutConfigError(
      'Not authorised to manage payout configuration',
      403,
    )
  }
  return actor
}

// Super Admin may target any company; Company Admin is pinned to their own.
const resolveCompanyId = (actor, requestedCompanyId) => {
  if (actor.role === ROLES.SUPER_ADMIN) {
    const id = requestedCompanyId || toId(actor.companyId)
    if (!id) {
      throw new PayoutConfigError('companyId is required', 400)
    }
    return id
  }
  if (requestedCompanyId && toId(requestedCompanyId) !== toId(actor.companyId)) {
    throw new PayoutConfigError('Cannot access another company', 403)
  }
  return toId(actor.companyId)
}

const assertStoreAccess = (actor, store) => {
  if (actor.role === ROLES.SUPER_ADMIN) {
    return
  }
  if (toId(actor.companyId) !== toId(store.companyId)) {
    throw new PayoutConfigError('Cannot access a store outside your company', 403)
  }
}

/**
 * Validate + normalize company buyback settings. Pure. Mirrors the company
 * schema constraints (non-negative numbers; sell-limit count and window paired).
 */
export const normalizeBuybackPayoutSettings = (settings = {}) => {
  const normalized = {
    enabled: settings.enabled === true,
    deviceCooldownDays: Number(settings.deviceCooldownDays || 0),
    customerSellLimitCount: Number(settings.customerSellLimitCount || 0),
    customerSellLimitWindowDays: Number(
      settings.customerSellLimitWindowDays || 0,
    ),
  }
  for (const field of [
    'deviceCooldownDays',
    'customerSellLimitCount',
    'customerSellLimitWindowDays',
  ]) {
    if (!Number.isFinite(normalized[field]) || normalized[field] < 0) {
      throw new PayoutConfigError(
        `${field} must be zero or a positive number`,
      )
    }
  }
  const hasCount = normalized.customerSellLimitCount > 0
  const hasWindow = normalized.customerSellLimitWindowDays > 0
  if (hasCount !== hasWindow) {
    throw new PayoutConfigError(
      'customerSellLimitCount and customerSellLimitWindowDays must be set together',
    )
  }
  return normalized
}

export const getCompanyPayoutConfig = async ({ actorId, companyId }) => {
  const actor = await resolveActor(actorId)
  const id = resolveCompanyId(actor, companyId)
  const company = await companyModel
    .findById(id)
    .select('name buybackPayoutSettings')
    .lean()
  if (!company) {
    throw new PayoutConfigError('Company not found', 404)
  }
  return {
    companyId: id,
    companyName: company.name || '',
    buybackPayoutSettings: company.buybackPayoutSettings || {},
  }
}

export const updateCompanyPayoutConfig = async ({
  actorId,
  companyId,
  settings,
}) => {
  const actor = await resolveActor(actorId)
  const id = resolveCompanyId(actor, companyId)
  const company = await companyModel
    .findById(id)
    .select('name buybackPayoutSettings')
  if (!company) {
    throw new PayoutConfigError('Company not found', 404)
  }
  // Merge partial updates over the existing settings, then validate the whole.
  const merged = { ...asObject(company.buybackPayoutSettings), ...(settings || {}) }
  company.buybackPayoutSettings = normalizeBuybackPayoutSettings(merged)
  await company.save()
  return {
    companyId: id,
    companyName: company.name || '',
    buybackPayoutSettings: company.buybackPayoutSettings,
  }
}

export const getStorePayoutConfig = async ({ actorId, storeId }) => {
  const actor = await resolveActor(actorId)
  const store = await storeModel
    .findById(storeId)
    .select('storeName companyId payoutSettings')
    .lean()
  if (!store) {
    throw new PayoutConfigError('Store not found', 404)
  }
  assertStoreAccess(actor, store)
  return {
    storeId: toId(store),
    storeName: store.storeName || '',
    payoutSettings: store.payoutSettings || {},
  }
}

export const updateStorePayoutConfig = async ({ actorId, storeId, settings }) => {
  const actor = await resolveActor(actorId)
  const store = await storeModel
    .findById(storeId)
    .select('storeName companyId payoutSettings')
  if (!store) {
    throw new PayoutConfigError('Store not found', 404)
  }
  assertStoreAccess(actor, store)
  // Merge partial updates so a focused edit (e.g. only the ceiling) does not
  // reset the other fields, then reuse the store-side normalizer.
  const merged = { ...asObject(store.payoutSettings), ...(settings || {}) }
  try {
    store.payoutSettings = normalizePayoutSettings(merged)
  } catch (error) {
    throw new PayoutConfigError(
      error.message || 'Invalid payout configuration values',
      400,
    )
  }
  await store.save()
  return {
    storeId: toId(store),
    storeName: store.storeName || '',
    payoutSettings: store.payoutSettings,
  }
}
