import mongoose from 'mongoose'
import devicesLotModel from '../models/devicesLotModel.js'
import leadsModel from '../models/leadsModel.js'
import usersModel from '../models/UsersModel.js'
import storeModel from '../models/storeModel.js'
import companyModel from '../models/companyModel.js'
import transporter from '../utils/transporter.js'
import { ROLES } from '../middlewares/rbac.js'
import { safeLog } from '../utils/piiMasking.js'
import { createPdfBuffer, uploadPdfToS3 } from '../utils/invoiceHelpers.js'
import {
  emitNotification,
  emitNotifications,
  NOTIFICATION_TYPES,
} from './notificationService.js'

export const STORE_PAYMENT_MODES = {
  COMPANY_ACCOUNTS: 'COMPANY_ACCOUNTS',
  MANAGER_FUNDS: 'MANAGER_FUNDS',
  PREPAID_DEFERRED: 'PREPAID_DEFERRED',
}

export const STORE_PAYMENT_STATUSES = {
  REQUESTED: 'PAYMENT_REQUESTED',
  FLAGGED: 'FLAGGED',
  DONE: 'PAYMENT_DONE',
}

const LOT_STATUS = {
  REQUESTED: 'Payment Requested',
  FLAGGED: 'Flagged',
  DONE: 'Payment Done',
}

const CLAIM_STATUS = 'PROCESSING'

const REQUEST_ROLES = new Set([
  ROLES.SUPER_ADMIN,
  ROLES.COMPANY_ADMIN,
  ROLES.STORE_ADMIN,
  ROLES.MANAGER,
  'Admin', // legacy store-admin role
])
const ELIGIBLE_LEAD_STATUSES = new Set([
  'Pending',
  'Picked Up',
  'Pickup Complete',
  'Available For Pickup',
])

export class StorePaymentError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

const toId = (value) => String(value?._id || value || '')
const uniqueIds = (values) => [...new Set((values || []).map(String))]
const escapeHtml = (value) =>
  String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')

const loadActor = async (actorId) => {
  if (!mongoose.Types.ObjectId.isValid(actorId)) {
    throw new StorePaymentError('Unauthorized', 401)
  }
  const actor = await usersModel.findById(actorId).lean()
  if (!actor || actor.status === false) {
    throw new StorePaymentError('User account is unavailable', 403)
  }
  return actor
}

const actorStoreIds = (actor) =>
  uniqueIds([actor.storeId, ...(actor.assignedStores || [])].filter(Boolean))

const assertRequestScope = (actor, leadStoreId, leadCompanyId) => {
  if (!REQUEST_ROLES.has(actor.role)) {
    throw new StorePaymentError(
      'Your role cannot raise a store payment request',
      403,
    )
  }
  if (actor.role === ROLES.SUPER_ADMIN) {
    return
  }
  if (toId(actor.companyId) !== toId(leadCompanyId)) {
    throw new StorePaymentError('Cannot request payment for another company', 403)
  }
  if (
    [ROLES.STORE_ADMIN, ROLES.MANAGER, 'Admin'].includes(actor.role) &&
    !actorStoreIds(actor).includes(toId(leadStoreId))
  ) {
    throw new StorePaymentError('Cannot request payment for this store', 403)
  }
}

const assertQueueScope = (actor, lot) => {
  if (actor.role === ROLES.SUPER_ADMIN) {
    return
  }
  if (toId(actor.companyId) !== toId(lot.companyId)) {
    throw new StorePaymentError('Cannot access another company payment', 403)
  }
  if (
    [ROLES.STORE_ADMIN, ROLES.MANAGER, 'Admin'].includes(actor.role) &&
    !actorStoreIds(actor).includes(toId(lot.storeId))
  ) {
    throw new StorePaymentError('Cannot access this store payment', 403)
  }
}

const calculateLeadAmount = (lead) =>
  Number(lead.price || 0) +
  Number(lead.bonusPrice || 0) +
  Number(lead.negotiatedAmount || 0) +
  Number(lead.couponDiscount || 0)

export const assertLeadEligible = (lead, store) => {
  if (!ELIGIBLE_LEAD_STATUSES.has(lead.status)) {
    throw new StorePaymentError(
      `Lead ${lead.uniqueCode || lead._id} is not pending or picked up`,
    )
  }
  if (lead.storePaymentRequestId) {
    throw new StorePaymentError(
      `Lead ${lead.uniqueCode || lead._id} already has a payment request`,
      409,
    )
  }
  if (lead.payoutId && lead.payoutStatus !== 'SUCCESS') {
    throw new StorePaymentError(
      `Lead ${lead.uniqueCode || lead._id} cannot proceed until the customer payout succeeds`,
      409,
    )
  }
  if (lead.companyId && toId(lead.companyId) !== toId(store.companyId)) {
    throw new StorePaymentError('Lead company does not match its store')
  }
}

const loadPaymentContext = async (leadIds) => {
  const normalizedIds = uniqueIds(leadIds)
  if (
    normalizedIds.length === 0 ||
    normalizedIds.some((id) => !mongoose.Types.ObjectId.isValid(id))
  ) {
    throw new StorePaymentError('At least one valid lead ID is required')
  }
  const leadList = await leadsModel
    .find({ _id: { $in: normalizedIds } })
    .select(
      'status storeId companyId storePaymentRequestId payoutId payoutStatus price bonusPrice negotiatedAmount couponDiscount uniqueCode',
    )
    .lean()
  if (leadList.length !== normalizedIds.length) {
    throw new StorePaymentError('One or more leads were not found', 404)
  }
  const storeIds = uniqueIds(leadList.map((lead) => lead.storeId))
  if (storeIds.length !== 1 || !storeIds[0]) {
    throw new StorePaymentError('All selected leads must belong to one store')
  }
  const store = await storeModel
    .findById(storeIds[0])
    .populate('companyId', 'name storePaymentSettings')
    .lean()
  if (!store?.companyId) {
    throw new StorePaymentError('Store company configuration was not found')
  }
  for (const lead of leadList) {
    assertLeadEligible(lead, store)
  }
  return { leadList, store }
}

const lotPopulate = (query) =>
  query
    .populate('storeId', 'storeName storeId email region')
    .populate('companyId', 'name companyCode storePaymentSettings')
    .populate('userId', 'name firstName lastName email role')
    .populate('paidBy', 'name firstName lastName email role')
    .populate(
      'deviceList',
      'uniqueCode status storePaymentStatus price bonusPrice negotiatedAmount couponDiscount name emailId phoneNumber modelId',
    )

const createHistory = (action, actorId, fromStatus, toStatus, remarks = '') => ({
  action,
  performedBy: actorId,
  fromStatus,
  toStatus,
  remarks,
  timestamp: new Date(),
})

const paymentRequestFields = (isDeferred, now) =>
  isDeferred
    ? {
        status: LOT_STATUS.DONE,
        paymentStatus: STORE_PAYMENT_STATUSES.DONE,
        paidAt: now,
        notificationState: 'NOT_REQUIRED',
        historyAction: 'PREPAID_DEFERRED_HANDOFF',
        historyRemark: 'No payout action required under prepaid/deferred mode',
      }
    : {
        status: LOT_STATUS.REQUESTED,
        paymentStatus: STORE_PAYMENT_STATUSES.REQUESTED,
        paidAt: undefined,
        notificationState: 'NOT_SENT',
        historyAction: 'PAYMENT_REQUESTED',
        historyRemark: '',
      }

const rollbackPaymentRequest = async (lotId) => {
  await leadsModel.updateMany(
    { storePaymentRequestId: lotId },
    {
      $unset: {
        storePaymentRequestId: '',
        storePaymentStatus: '',
      },
    },
  )
  await devicesLotModel.deleteOne({ _id: lotId })
}

const notifyAccountsUsers = async ({ isDeferred, store, actor, lot }) => {
  if (isDeferred) {
    return
  }
  const accountsUsers = await usersModel
    .find({
      companyId: store.companyId._id,
      role: ROLES.ACCOUNTS_USER,
      status: true,
    })
    .select('_id')
    .lean()
  await emitNotifications(
    accountsUsers.map((accountsUser) => ({
      userId: accountsUser._id,
      companyId: store.companyId._id,
      type: NOTIFICATION_TYPES.PAYMENT_REQUEST_CREATED,
      title: 'New payment request',
      body: `Payment request ${lot.uniqueCode} is awaiting your action.`,
      entityType: 'storePayment',
      entityId: lot._id,
      createdBy: actor._id,
    })),
  )
}

export const createStorePaymentRequest = async ({ actorId, leadIds }) => {
  const [actor, context] = await Promise.all([
    loadActor(actorId),
    loadPaymentContext(leadIds),
  ])
  const { leadList, store } = context
  assertRequestScope(actor, store._id, store.companyId._id)

  const paymentMode =
    store.companyId.storePaymentSettings?.mode ||
    STORE_PAYMENT_MODES.COMPANY_ACCOUNTS
  const isDeferred = paymentMode === STORE_PAYMENT_MODES.PREPAID_DEFERRED
  const now = new Date()
  const fields = paymentRequestFields(isDeferred, now)
  const lot = await devicesLotModel.create({
    status: fields.status,
    paymentStatus: fields.paymentStatus,
    paymentMode,
    paidAt: fields.paidAt,
    totalDevice: leadList.length,
    totalAmount: leadList.reduce(
      (total, lead) => total + calculateLeadAmount(lead),
      0,
    ),
    deviceList: leadList.map((lead) => lead._id),
    userId: actor._id,
    storeId: store._id,
    companyId: store.companyId._id,
    uniqueCode: `PAY-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 7)
      .toUpperCase()}`,
    requestedAt: now,
    notification: {
      state: fields.notificationState,
      attempts: 0,
    },
    history: [
      createHistory(
        fields.historyAction,
        actor._id,
        leadList[0].status,
        fields.status,
        fields.historyRemark,
      ),
    ],
  })

  const claimResult = await leadsModel.updateMany(
    {
      _id: { $in: leadList.map((lead) => lead._id) },
      status: { $in: [...ELIGIBLE_LEAD_STATUSES] },
      $or: [
        { storePaymentRequestId: { $exists: false } },
        { storePaymentRequestId: null },
      ],
    },
    {
      $set: {
        storePaymentRequestId: lot._id,
        storePaymentStatus: fields.paymentStatus,
        companyId: store.companyId._id,
      },
    },
  )
  if (claimResult.modifiedCount !== leadList.length) {
    await rollbackPaymentRequest(lot._id)
    throw new StorePaymentError(
      'A selected lead was changed or requested by another user. Refresh and retry.',
      409,
    )
  }
  await leadsModel.updateMany(
    { storePaymentRequestId: lot._id },
    {
      $set: {
        status: fields.status,
      },
      $push: {
        history: createHistory(
          fields.historyAction,
          actor._id,
          '',
          fields.status,
        ),
      },
    },
  )
  await notifyAccountsUsers({ isDeferred, store, actor, lot })
  return lotPopulate(devicesLotModel.findById(lot._id)).lean()
}

const buildListScope = (actor, query) => {
  const filter = {}
  if (actor.role !== ROLES.SUPER_ADMIN) {
    filter.companyId = actor.companyId
  }
  if ([ROLES.STORE_ADMIN, ROLES.MANAGER, 'Admin'].includes(actor.role)) {
    filter.storeId = { $in: actorStoreIds(actor) }
  }
  if (query.status) {
    filter.paymentStatus = query.status
  }
  if (query.storeId) {
    if (!mongoose.Types.ObjectId.isValid(query.storeId)) {
      throw new StorePaymentError('Invalid store ID')
    }
    if (
      [ROLES.STORE_ADMIN, ROLES.MANAGER, 'Admin'].includes(actor.role) &&
      !actorStoreIds(actor).includes(String(query.storeId))
    ) {
      throw new StorePaymentError('Cannot filter another store', 403)
    }
    filter.storeId = query.storeId
  }
  return filter
}

export const listStorePayments = async ({ actorId, query = {} }) => {
  const actor = await loadActor(actorId)
  const allowedViewRoles = new Set([...REQUEST_ROLES, ROLES.ACCOUNTS_USER])
  if (!allowedViewRoles.has(actor.role)) {
    throw new StorePaymentError('Your role cannot view store payments', 403)
  }
  const page = Math.max(Number(query.page) || 0, 0)
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100)
  const filter = buildListScope(actor, query)
  const [items, total] = await Promise.all([
    lotPopulate(
      devicesLotModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(page * limit)
        .limit(limit),
    ).lean(),
    devicesLotModel.countDocuments(filter),
  ])
  return { items, total, page, limit }
}

export const getStorePayment = async ({ actorId, paymentId }) => {
  const actor = await loadActor(actorId)
  if (!mongoose.Types.ObjectId.isValid(paymentId)) {
    throw new StorePaymentError('Invalid payment request ID')
  }
  const lot = await devicesLotModel.findById(paymentId)
  if (!lot) {
    throw new StorePaymentError('Payment request not found', 404)
  }
  assertQueueScope(actor, lot)
  lot.viewLog.push({ viewedBy: actor._id, viewedAt: new Date() })
  lot.history.push(createHistory('VIEWED', actor._id, lot.status, lot.status))
  await lot.save()
  return lotPopulate(devicesLotModel.findById(lot._id)).lean()
}

const loadActionContext = async (actorId, paymentId) => {
  const actor = await loadActor(actorId)
  if (!mongoose.Types.ObjectId.isValid(paymentId)) {
    throw new StorePaymentError('Invalid payment request ID')
  }
  const lot = await devicesLotModel.findById(paymentId)
  if (!lot) {
    throw new StorePaymentError('Payment request not found', 404)
  }
  assertQueueScope(actor, lot)
  return { actor, lot }
}

const assertAccountsAction = (actor) => {
  if (![ROLES.ACCOUNTS_USER, ROLES.SUPER_ADMIN].includes(actor.role)) {
    throw new StorePaymentError(
      'Only an Accounts User can perform this action',
      403,
    )
  }
}

const sendWithRetries = async (mailOptions, maxAttempts = 3) => {
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const info = await transporter.sendMail(mailOptions)
      return { delivered: true, attempts: attempt, messageId: info.messageId }
    } catch (error) {
      lastError = error
      safeLog.error(`Store payment email attempt ${attempt} failed`, error)
    }
  }
  return {
    delivered: false,
    attempts: maxAttempts,
    error: lastError?.message || 'Email delivery failed',
  }
}

const resolvePaidRecipients = async (lot) => {
  const [store, company, managers, companyAdmins] =
    await Promise.all([
      storeModel.findById(lot.storeId).lean(),
      companyModel.findById(lot.companyId).lean(),
      usersModel
        .find({
          companyId: lot.companyId,
          role: ROLES.MANAGER,
          status: true,
          $or: [{ storeId: lot.storeId }, { assignedStores: lot.storeId }],
        })
        .select('email')
        .lean(),
      usersModel
        .find({
          companyId: lot.companyId,
          role: ROLES.COMPANY_ADMIN,
          status: true,
        })
        .select('email')
        .lean(),
    ])
  const managerEmails = managers.map((user) => user.email)
  const recipients =
    lot.paymentMode === STORE_PAYMENT_MODES.MANAGER_FUNDS
      ? managerEmails
      : [
          store?.email,
          ...managerEmails,
          ...companyAdmins.map((user) => user.email),
        ]
  return {
    recipients: [
      ...new Set(recipients.map((email) => String(email || '').trim()).filter(Boolean)),
    ],
    store,
    company,
  }
}

const sendPaidNotification = async (lot) => {
  const { recipients, store, company } = await resolvePaidRecipients(lot)
  if (recipients.length === 0) {
    return { delivered: false, attempts: 0, error: 'No recipients configured', recipients }
  }
  const modeText =
    lot.paymentMode === STORE_PAYMENT_MODES.MANAGER_FUNDS
      ? 'paid by the account manager and recorded for reimbursement'
      : 'processed through company accounts'
  const delivery = await sendWithRetries({
    from: process.env.MAIL,
    to: recipients,
    subject: `GREST store payment completed - ${lot.uniqueCode}`,
    html: `
      <p>Store payment <strong>${escapeHtml(lot.uniqueCode)}</strong> has been ${modeText}.</p>
      <p>Company: <strong>${escapeHtml(company?.name)}</strong></p>
      <p>Store: <strong>${escapeHtml(store?.storeName)}</strong></p>
      <p>Devices: <strong>${Number(lot.totalDevice)}</strong></p>
      <p>Amount: <strong>₹${Number(lot.totalAmount).toFixed(2)}</strong></p>
      <p>Reference: <strong>${escapeHtml(lot.paymentReference || 'Not provided')}</strong></p>
      ${lot.paymentReceipt ? `<p><a href="${escapeHtml(lot.paymentReceipt)}">View receipt</a></p>` : ''}
    `,
  })
  return { ...delivery, recipients }
}

const generateStorePaymentReceipt = async (lot) => {
  const [store, company] = await Promise.all([
    storeModel.findById(lot.storeId).lean(),
    companyModel.findById(lot.companyId).lean(),
  ])
  const html = `
    <!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Store Payment Receipt</title></head>
      <body style="font-family: Arial, sans-serif; padding: 32px; color: #222">
        <h1 style="color: #ed174c">GREST Store Payment Receipt</h1>
        <p>Request: <strong>${escapeHtml(lot.uniqueCode)}</strong></p>
        <p>Company: <strong>${escapeHtml(company?.name)}</strong></p>
        <p>Store: <strong>${escapeHtml(store?.storeName)}</strong></p>
        <p>Devices: <strong>${Number(lot.totalDevice)}</strong></p>
        <p>Amount: <strong>₹${Number(lot.totalAmount).toFixed(2)}</strong></p>
        <p>Payment mode: <strong>${escapeHtml(lot.paymentMode)}</strong></p>
        <p>Payment reference: <strong>${escapeHtml(lot.paymentReference || 'Not provided')}</strong></p>
        <p>Paid at: <strong>${new Date(lot.paidAt).toISOString()}</strong></p>
        <p>This receipt was generated automatically by GREST.</p>
      </body>
    </html>
  `
  const pdfBuffer = await createPdfBuffer(html)
  return uploadPdfToS3(pdfBuffer, `store-payment-${lot.uniqueCode}`)
}

export const flagStorePayment = async ({
  actorId,
  paymentId,
  reason,
}) => {
  if (!String(reason || '').trim()) {
    throw new StorePaymentError('A flag reason is required')
  }
  const { actor, lot } = await loadActionContext(actorId, paymentId)
  assertAccountsAction(actor)
  if (lot.paymentStatus !== STORE_PAYMENT_STATUSES.REQUESTED) {
    throw new StorePaymentError('Only a requested payment can be flagged', 409)
  }
  const flagClaim = await devicesLotModel.updateOne(
    {
      _id: lot._id,
      paymentStatus: STORE_PAYMENT_STATUSES.REQUESTED,
    },
    { $set: { paymentStatus: STORE_PAYMENT_STATUSES.FLAGGED } },
  )
  if (flagClaim.modifiedCount !== 1) {
    throw new StorePaymentError(
      'This payment was changed by another user. Refresh and retry.',
      409,
    )
  }
  lot.paymentStatus = STORE_PAYMENT_STATUSES.FLAGGED
  lot.status = LOT_STATUS.FLAGGED
  lot.flag = {
    reason: String(reason).trim(),
    flaggedBy: actor._id,
    flaggedAt: new Date(),
  }
  lot.history.push(
    createHistory(
      'FLAGGED',
      actor._id,
      LOT_STATUS.REQUESTED,
      LOT_STATUS.FLAGGED,
      reason,
    ),
  )
  try {
    await lot.save()
  } catch (error) {
    await devicesLotModel.updateOne(
      { _id: lot._id, paymentStatus: STORE_PAYMENT_STATUSES.FLAGGED },
      { $set: { paymentStatus: STORE_PAYMENT_STATUSES.REQUESTED } },
    )
    throw error
  }
  await leadsModel.updateMany(
    { storePaymentRequestId: lot._id },
    {
      $set: { storePaymentStatus: 'FLAGGED', status: LOT_STATUS.FLAGGED },
      $push: {
        history: createHistory(
          'STORE_PAYMENT_FLAGGED',
          actor._id,
          LOT_STATUS.REQUESTED,
          LOT_STATUS.FLAGGED,
          reason,
        ),
      },
    },
  )
  const requester = await usersModel.findById(lot.userId).select('email').lean()
  if (requester?.email) {
    await sendWithRetries({
      from: process.env.MAIL,
      to: requester.email,
      subject: `GREST payment request flagged - ${lot.uniqueCode}`,
      html: `<p>Your payment request was flagged for clarification.</p><p>Reason: <strong>${escapeHtml(reason)}</strong></p>`,
    })
  }
  // In-app alert to the requester alongside the email (side-effect only).
  await emitNotification({
    userId: lot.userId,
    companyId: lot.companyId,
    type: NOTIFICATION_TYPES.STORE_PAYMENT_FLAGGED,
    title: 'Payment request flagged',
    body: `Payment request ${lot.uniqueCode} was flagged: ${reason}`,
    entityType: 'storePayment',
    entityId: lot._id,
    createdBy: actor._id,
  })
  return lotPopulate(devicesLotModel.findById(lot._id)).lean()
}

export const unflagStorePayment = async ({
  actorId,
  paymentId,
  resolution,
}) => {
  const { actor, lot } = await loadActionContext(actorId, paymentId)
  assertAccountsAction(actor)
  if (lot.paymentStatus !== STORE_PAYMENT_STATUSES.FLAGGED) {
    throw new StorePaymentError('Only a flagged payment can be resumed', 409)
  }
  const unflagClaim = await devicesLotModel.updateOne(
    {
      _id: lot._id,
      paymentStatus: STORE_PAYMENT_STATUSES.FLAGGED,
    },
    { $set: { paymentStatus: CLAIM_STATUS } },
  )
  if (unflagClaim.modifiedCount !== 1) {
    throw new StorePaymentError(
      'This payment was changed by another user. Refresh and retry.',
      409,
    )
  }
  lot.paymentStatus = STORE_PAYMENT_STATUSES.REQUESTED
  lot.status = LOT_STATUS.REQUESTED
  lot.flag.resolvedBy = actor._id
  lot.flag.resolvedAt = new Date()
  lot.flag.resolution = String(resolution || '').trim()
  lot.history.push(
    createHistory(
      'UNFLAGGED',
      actor._id,
      LOT_STATUS.FLAGGED,
      LOT_STATUS.REQUESTED,
      resolution,
    ),
  )
  try {
    await lot.save()
  } catch (error) {
    await devicesLotModel.updateOne(
      { _id: lot._id, paymentStatus: CLAIM_STATUS },
      { $set: { paymentStatus: STORE_PAYMENT_STATUSES.FLAGGED } },
    )
    throw error
  }
  await leadsModel.updateMany(
    { storePaymentRequestId: lot._id },
    {
      $set: {
        storePaymentStatus: STORE_PAYMENT_STATUSES.REQUESTED,
        status: LOT_STATUS.REQUESTED,
      },
      $push: {
        history: createHistory(
          'STORE_PAYMENT_UNFLAGGED',
          actor._id,
          LOT_STATUS.FLAGGED,
          LOT_STATUS.REQUESTED,
          resolution,
        ),
      },
    },
  )
  return lotPopulate(devicesLotModel.findById(lot._id)).lean()
}

const assertPaymentActor = (actor, lot) => {
  if (actor.role === ROLES.SUPER_ADMIN) {
    return
  }
  if (
    lot.paymentMode === STORE_PAYMENT_MODES.COMPANY_ACCOUNTS &&
    actor.role === ROLES.ACCOUNTS_USER
  ) {
    return
  }
  if (
    lot.paymentMode === STORE_PAYMENT_MODES.MANAGER_FUNDS &&
    actor.role === ROLES.MANAGER &&
    actorStoreIds(actor).includes(toId(lot.storeId))
  ) {
    return
  }
  throw new StorePaymentError(
    lot.paymentMode === STORE_PAYMENT_MODES.MANAGER_FUNDS
      ? 'Only the assigned Manager can mark this payment as paid'
      : 'Only an Accounts User can mark this payment as paid',
    403,
  )
}

export const markStorePaymentPaid = async ({
  actorId,
  paymentId,
  paymentReference,
  paymentReceipt,
  remarks,
}) => {
  const { actor, lot } = await loadActionContext(actorId, paymentId)
  assertPaymentActor(actor, lot)
  if (lot.paymentStatus === STORE_PAYMENT_STATUSES.DONE) {
    throw new StorePaymentError('This payment is already completed', 409)
  }
  if (lot.paymentStatus !== STORE_PAYMENT_STATUSES.REQUESTED) {
    throw new StorePaymentError('Resolve the flag before marking payment paid', 409)
  }
  const claim = await devicesLotModel.updateOne(
    {
      _id: lot._id,
      paymentStatus: STORE_PAYMENT_STATUSES.REQUESTED,
    },
    { $set: { paymentStatus: CLAIM_STATUS } },
  )
  if (claim.modifiedCount !== 1) {
    throw new StorePaymentError(
      'This payment is already being processed by another user',
      409,
    )
  }
  const previousReceipt = lot.paymentReceipt
  const previousRemarks = lot.remarks
  const now = new Date()
  lot.paymentStatus = STORE_PAYMENT_STATUSES.DONE
  lot.status = LOT_STATUS.DONE
  lot.paidAt = now
  lot.paidBy = actor._id
  lot.paymentReference = String(paymentReference || '').trim()
  lot.paymentReceipt = String(paymentReceipt || lot.paymentReceipt || '').trim()
  lot.remarks = String(remarks || lot.remarks || '').trim()
  lot.history.push(
    createHistory(
      'MARKED_PAID',
      actor._id,
      LOT_STATUS.REQUESTED,
      LOT_STATUS.DONE,
      remarks,
    ),
  )
  try {
    await lot.save()
  } catch (error) {
    await devicesLotModel.updateOne(
      { _id: lot._id, paymentStatus: CLAIM_STATUS },
      { $set: { paymentStatus: STORE_PAYMENT_STATUSES.REQUESTED } },
    )
    throw error
  }
  try {
    const leadUpdate = await leadsModel.updateMany(
      { storePaymentRequestId: lot._id },
      {
        $set: {
          storePaymentStatus: STORE_PAYMENT_STATUSES.DONE,
          status: LOT_STATUS.DONE,
        },
        $push: {
          history: createHistory(
            'STORE_PAYMENT_MARKED_PAID',
            actor._id,
            LOT_STATUS.REQUESTED,
            LOT_STATUS.DONE,
            remarks,
          ),
        },
      },
    )
    if (leadUpdate.matchedCount !== lot.totalDevice) {
      throw new Error(
        `Expected ${lot.totalDevice} leads but found ${leadUpdate.matchedCount}`,
      )
    }
  } catch (error) {
    await leadsModel.updateMany(
      { storePaymentRequestId: lot._id },
      {
        $set: {
          storePaymentStatus: STORE_PAYMENT_STATUSES.REQUESTED,
          status: LOT_STATUS.REQUESTED,
        },
      },
    )
    lot.paymentStatus = STORE_PAYMENT_STATUSES.REQUESTED
    lot.status = LOT_STATUS.REQUESTED
    lot.paidAt = undefined
    lot.paidBy = undefined
    lot.paymentReference = ''
    lot.paymentReceipt = previousReceipt
    lot.remarks = previousRemarks
    lot.history.push(
      createHistory(
        'MARK_PAID_ROLLED_BACK',
        actor._id,
        LOT_STATUS.DONE,
        LOT_STATUS.REQUESTED,
        error.message,
      ),
    )
    await lot.save()
    throw new StorePaymentError(
      'Payment state could not be applied to every lead; no payment completion was recorded',
      500,
    )
  }
  // Notify the requester that their payment request is paid.
  await emitNotification({
    userId: lot.userId,
    companyId: lot.companyId,
    type: NOTIFICATION_TYPES.STORE_PAYMENT_PAID,
    title: 'Payment request marked paid',
    body: `Payment request ${lot.uniqueCode} was marked paid.`,
    entityType: 'storePayment',
    entityId: lot._id,
    createdBy: actor._id,
  })

  let receiptError = ''
  if (!lot.paymentReceipt) {
    try {
      lot.paymentReceipt = await generateStorePaymentReceipt(lot)
      lot.history.push(
        createHistory(
          'PAYMENT_RECEIPT_GENERATED',
          actor._id,
          LOT_STATUS.DONE,
          LOT_STATUS.DONE,
        ),
      )
      await lot.save()
    } catch (error) {
      receiptError = `Receipt generation failed: ${error.message}`
      safeLog.error('Store payment receipt generation failed', error)
      lot.history.push(
        createHistory(
          'PAYMENT_RECEIPT_FAILED',
          actor._id,
          LOT_STATUS.DONE,
          LOT_STATUS.DONE,
          receiptError,
        ),
      )
      await lot.save()
    }
  }
  const delivery = await sendPaidNotification(lot)
  const notificationFailed = !delivery.delivered || Boolean(receiptError)
  lot.notification = {
    state: notificationFailed ? 'FAILED' : 'DELIVERED',
    attempts: delivery.attempts,
    recipients: delivery.recipients,
    lastError: [receiptError, delivery.error].filter(Boolean).join('; '),
    lastAttemptAt: new Date(),
  }
  lot.history.push(
    createHistory(
      delivery.delivered ? 'PAYMENT_EMAIL_DELIVERED' : 'PAYMENT_EMAIL_FAILED',
      actor._id,
      LOT_STATUS.DONE,
      LOT_STATUS.DONE,
      [receiptError, delivery.error].filter(Boolean).join('; '),
    ),
  )
  await lot.save()
  return lotPopulate(devicesLotModel.findById(lot._id)).lean()
}
