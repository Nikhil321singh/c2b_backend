import UsersModel from '../../models/UsersModel.js'
import {
  PayoutBusinessError,
  ADMIN_ROLES,
  APPROVER_ROLES,
  ROLE_SUPER_ADMIN,
  ROLE_MANAGER,
  ROLE_ADMIN_MANAGER,
} from './validation.js'

const loadActor = async (actorId) => {
  const actor = await UsersModel.findById(actorId)
    .select('role companyId storeId assignedStores')
    .lean()
  if (!actor) {
    throw new PayoutBusinessError('User not found', 401)
  }
  return actor
}

const assertPayoutAccess = async (payout, actorId, options = {}) => {
  const actor = await loadActor(actorId)
  if (actor.role !== ROLE_SUPER_ADMIN) {
    if (String(actor.companyId) !== String(payout.companyId)) {
      throw new PayoutBusinessError('Access denied', 403)
    }
  }
  if (options.approver && !APPROVER_ROLES.has(actor.role)) {
    throw new PayoutBusinessError('Payout approval permission required', 403)
  }
  if (
    options.approver &&
    [ROLE_MANAGER, ROLE_ADMIN_MANAGER].includes(actor.role) &&
    String(actor.storeId || '') !== String(payout.storeId) &&
    !(actor.assignedStores || []).some(
      (storeId) => String(storeId) === String(payout.storeId),
    )
  ) {
    throw new PayoutBusinessError(
      'Managers can approve payouts only for their assigned stores',
      403,
    )
  }
  if (
    options.payer &&
    String(payout.initiatedBy) !== String(actorId) &&
    !ADMIN_ROLES.has(actor.role)
  ) {
    throw new PayoutBusinessError(
      'Only the lead generator or an administrator can make this payment',
      403,
    )
  }
  return actor
}

export { loadActor, assertPayoutAccess }
