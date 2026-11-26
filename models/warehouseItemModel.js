import mongoose from 'mongoose'

const { Schema } = mongoose

// Logistics status of one device after its lot's payment is confirmed.
export const LOGISTICS_STATUS = Object.freeze({
  NOT_BOOKED: 'Not Booked',
  BOOKED: 'Booked',
  PICKUP_REGISTERED: 'Pickup Registered',
  OUT_FOR_PICKUP: 'Out For Pickup',
  PICKUP_COMPLETE: 'Pickup Complete',
  IN_TRANSIT: 'In Transit',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
})

export const BOOKING_MODE = Object.freeze({
  BLUEDART: 'Bluedart',
  MANUAL: 'Manual',
})

// Package defaults from the Warehouse requirements.
export const PACKAGE_DEFAULTS = Object.freeze({
  weight: 0.45,
  length: 12,
  width: 12,
  height: 12,
  quantity: 1,
})

const shipmentSchema = new Schema(
  {
    awbNo: { type: String, required: true },
    courierName: { type: String, default: '' },
    bookingMode: {
      type: String,
      enum: Object.values(BOOKING_MODE),
      required: true,
    },
    serviceType: { type: String, default: '' },
    serviceCode: { type: String, default: '' },
    // Shipping label in S3; served through short-lived signed links.
    labelKey: { type: String, default: '' },
    labelUrl: { type: String, default: '' },
    // Bluedart pickup registration, needed to cancel the pickup.
    pickupTokenNumber: { type: String, default: '' },
    // CreditReferenceNo sent to Bluedart for this booking.
    reference: { type: String, default: '' },
    pickupDate: { type: Date, default: null },
    edd: { type: Date, default: null },
    deliveryDate: { type: Date, default: null },
    // Latest Bluedart tracking scan, stored as Bluedart reports it.
    trackingStatus: { type: String, default: '' },
    trackingStatusType: { type: String, default: '' },
    trackingStatusAt: { type: String, default: '' },
    trackingError: { type: String, default: '' },
    trackedAt: { type: Date, default: null },
    bookedBy: { type: Schema.Types.ObjectId, ref: 'users', default: null },
    bookedAt: { type: Date, default: Date.now },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'users', default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '' },
  },
  { _id: true },
)

const historySchema = new Schema(
  {
    // AMOUNT_EDIT, PACKAGE_EDIT, BOOKED, STATUS_CHANGE, CANCELLED, RE_TRANSIT,
    // BOOKING_FAILED
    action: { type: String, required: true },
    field: { type: String, default: '' },
    oldValue: { type: Schema.Types.Mixed, default: null },
    newValue: { type: Schema.Types.Mixed, default: null },
    note: { type: String, default: '' },
    by: { type: Schema.Types.ObjectId, ref: 'users', default: null },
    byName: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
)

// Warehouse-side record for one lead. Created on the first warehouse action;
// until then the listing shows the defaults and the lead's own price.
const warehouseItemSchema = new Schema(
  {
    leadId: {
      type: Schema.Types.ObjectId,
      ref: 'leads',
      required: true,
      unique: true,
    },
    lotId: {
      type: Schema.Types.ObjectId,
      ref: 'devicesLot',
      required: true,
      index: true,
    },
    // Declared value override; null means "use the lead's final price".
    amount: { type: Number, default: null },
    quantity: { type: Number, default: PACKAGE_DEFAULTS.quantity },
    weight: { type: Number, default: PACKAGE_DEFAULTS.weight },
    dimensions: {
      length: { type: Number, default: PACKAGE_DEFAULTS.length },
      width: { type: Number, default: PACKAGE_DEFAULTS.width },
      height: { type: Number, default: PACKAGE_DEFAULTS.height },
    },
    logisticsStatus: {
      type: String,
      enum: Object.values(LOGISTICS_STATUS),
      default: LOGISTICS_STATUS.NOT_BOOKED,
      index: true,
    },
    // Number of bookings made after a cancellation.
    reTransitCount: { type: Number, default: 0 },
    // Set while a Bluedart booking call is in flight so a second click (or a
    // second user) cannot book the same item twice.
    bookingLock: {
      reference: { type: String, default: '' },
      at: { type: Date, default: null },
    },
    // Reference of an attempt whose outcome is unknown (timeout); a retry
    // reuses it so Bluedart can recognise the same shipment.
    pendingReference: { type: String, default: '' },
    bookingAttempts: { type: Number, default: 0 },
    // The active shipment; cancelled ones move to pastShipments.
    shipment: { type: shipmentSchema, default: null },
    pastShipments: { type: [shipmentSchema], default: [] },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true },
)

// An AWB may be used once across active and past shipments.
warehouseItemSchema.index({ 'shipment.awbNo': 1 }, { sparse: true })
warehouseItemSchema.index({ 'pastShipments.awbNo': 1 })

const warehouseItemModel = mongoose.model('warehouseItem', warehouseItemSchema)

export default warehouseItemModel
