import { expect } from 'chai'
import mongoose from 'mongoose'
import notificationModel from '../models/notificationModel.js'
import {
  NOTIFICATION_TYPES,
  NotificationError,
  isValidNotificationType,
  buildNotification,
  buildListFilter,
  emitNotifications,
} from '../services/notificationService.js'

const RECIPIENT = new mongoose.Types.ObjectId()

describe('notification model defaults', () => {
  it('creates unread notifications with empty optional fields', () => {
    const n = new notificationModel()
    expect(n.read).to.equal(false)
    expect(n.readAt).to.equal(null)
    expect(n.body).to.equal('')
    expect(n.entityType).to.equal('')
    expect(n.entityId).to.equal(null)
    expect(n.createdBy).to.equal(null)
  })
})

describe('notification types', () => {
  it('recognises the operational notification types', () => {
    expect(isValidNotificationType(NOTIFICATION_TYPES.LOGISTIC_ASSIGNMENT)).to.equal(true)
    expect(isValidNotificationType(NOTIFICATION_TYPES.STORE_PAYMENT_PAID)).to.equal(true)
    expect(isValidNotificationType(NOTIFICATION_TYPES.STORE_PAYMENT_FLAGGED)).to.equal(true)
    expect(isValidNotificationType(NOTIFICATION_TYPES.PAYMENT_REQUEST_CREATED)).to.equal(true)
    expect(isValidNotificationType(NOTIFICATION_TYPES.LEAD_DELIVERED)).to.equal(true)
    expect(isValidNotificationType(NOTIFICATION_TYPES.LEAD_CANCELLED)).to.equal(true)
    expect(isValidNotificationType(NOTIFICATION_TYPES.PAYOUT_APPROVAL_DECIDED)).to.equal(true)
  })

  it('rejects unknown types', () => {
    expect(isValidNotificationType('HSBC_PAYOUT')).to.equal(false)
    expect(isValidNotificationType(undefined)).to.equal(false)
  })

  it('keeps the type map frozen', () => {
    expect(Object.isFrozen(NOTIFICATION_TYPES)).to.equal(true)
  })
})

describe('buildNotification', () => {
  const valid = () => ({
    userId: RECIPIENT,
    type: NOTIFICATION_TYPES.LOGISTIC_ASSIGNMENT,
    title: 'New lead assigned to you',
    body: '  Lead ORD-1 is out for pickup.  ',
    entityType: 'lead',
    entityId: new mongoose.Types.ObjectId(),
  })

  it('normalises a valid notification and trims strings', () => {
    const built = buildNotification(valid())
    expect(built.userId).to.equal(RECIPIENT)
    expect(built.type).to.equal(NOTIFICATION_TYPES.LOGISTIC_ASSIGNMENT)
    expect(built.body).to.equal('Lead ORD-1 is out for pickup.')
    expect(built.companyId).to.equal(null)
    expect(built.createdBy).to.equal(null)
  })

  it('requires a recipient userId', () => {
    const input = valid()
    delete input.userId
    expect(() => buildNotification(input)).to.throw(NotificationError, /userId is required/)
  })

  it('requires a title', () => {
    const input = { ...valid(), title: '   ' }
    expect(() => buildNotification(input)).to.throw(NotificationError, /title is required/)
  })

  it('rejects an unknown type', () => {
    const input = { ...valid(), type: 'HSBC_PAYOUT' }
    expect(() => buildNotification(input)).to.throw(NotificationError, /Unknown notification type/)
  })
})

describe('emitNotifications (bulk)', () => {
  it('returns an empty array for empty or invalid input without touching the DB', async () => {
    expect(await emitNotifications([])).to.deep.equal([])
    expect(await emitNotifications(undefined)).to.deep.equal([])
  })
})

describe('buildListFilter', () => {
  it('scopes every query to the calling user', () => {
    const filter = buildListFilter({ actorId: RECIPIENT.toString() })
    expect(filter.userId.toString()).to.equal(RECIPIENT.toString())
    expect(filter).to.not.have.property('read')
  })

  it('adds an unread constraint when requested', () => {
    const filter = buildListFilter({ actorId: RECIPIENT.toString(), unreadOnly: true })
    expect(filter.read).to.equal(false)
  })
})
