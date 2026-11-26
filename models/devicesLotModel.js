import mongoose from "mongoose";

const devicesLotSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      required: true,
    },
    totalDevice: {
      type: Number,
      required: true,
      default: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
      default: 0,
    },
    deviceList: [
      {
        type: mongoose.Types.ObjectId,
        required: true,
        ref: "leads",
      },
    ],
    userId: {
      type: mongoose.Types.ObjectId,
      required: true,
      ref: "users", // referencing the 'users' collection
    },
    storeId: {
      type: mongoose.Types.ObjectId,
      required: true,
      ref: "store", // referencing the 'store' collection
    },
    companyId: {
      type: mongoose.Types.ObjectId,
      ref: "company",
      index: true,
    },
    uniqueCode: {
      type: String,
      required: true,
    },
    paymentReceipt: {
      type: String,
    },
    remarks: {
      type: String,
    },
    // Where the lot came from. MANUAL: raised from the store / pickup flow
    // (older lots have no value and count as MANUAL). PAYOUT: the customer
    // was already paid through HSBC and the lead was sent to logistics from
    // Customer Payouts.
    source: {
      type: String,
      enum: ["MANUAL", "PAYOUT"],
    },
    buybackPayoutId: {
      type: mongoose.Types.ObjectId,
      ref: "buybackPayout",
    },
    // Store-payment fields only apply to store-raised lots; payout lots are
    // already settled with the customer and must not enter that workflow.
    paymentMode: {
      type: String,
      enum: ["COMPANY_ACCOUNTS", "MANAGER_FUNDS", "PREPAID_DEFERRED"],
      default: function () {
        return this.source === "PAYOUT" ? undefined : "COMPANY_ACCOUNTS";
      },
    },
    paymentStatus: {
      type: String,
      enum: ["PAYMENT_REQUESTED", "FLAGGED", "PROCESSING", "PAYMENT_DONE"],
      default: function () {
        return this.source === "PAYOUT" ? undefined : "PAYMENT_REQUESTED";
      },
      index: true,
    },
    requestedAt: { type: Date },
    paidAt: { type: Date },
    paidBy: { type: mongoose.Types.ObjectId, ref: "users" },
    paymentReference: { type: String, trim: true },
    flag: {
      reason: { type: String, trim: true },
      flaggedBy: { type: mongoose.Types.ObjectId, ref: "users" },
      flaggedAt: { type: Date },
      resolvedBy: { type: mongoose.Types.ObjectId, ref: "users" },
      resolvedAt: { type: Date },
      resolution: { type: String, trim: true },
    },
    notification: {
      state: {
        type: String,
        enum: ["NOT_SENT", "DELIVERED", "FAILED", "NOT_REQUIRED"],
        default: "NOT_SENT",
      },
      attempts: { type: Number, default: 0 },
      recipients: [{ type: String }],
      lastError: { type: String },
      lastAttemptAt: { type: Date },
    },
    history: [{
      action: { type: String, required: true },
      fromStatus: { type: String },
      toStatus: { type: String },
      performedBy: { type: mongoose.Types.ObjectId, ref: "users" },
      remarks: { type: String },
      timestamp: { type: Date, default: Date.now },
    }],
    viewLog: [{
      viewedBy: { type: mongoose.Types.ObjectId, ref: "users" },
      viewedAt: { type: Date, default: Date.now },
    }],
  },
  { timestamps: true }
);

// Performance optimization indexes for pickup devices queries
devicesLotSchema.index({ status: 1, updatedAt: -1 });
devicesLotSchema.index({ storeId: 1, status: 1 });
devicesLotSchema.index({ uniqueCode: 1 });
devicesLotSchema.index({ userId: 1 });
devicesLotSchema.index({ createdAt: -1 });
devicesLotSchema.index({ companyId: 1, paymentStatus: 1, createdAt: -1 });
// One logistics lot per customer payout, enforced by the database.
devicesLotSchema.index(
  { buybackPayoutId: 1 },
  { unique: true, partialFilterExpression: { buybackPayoutId: { $exists: true } } }
);
devicesLotSchema.index({ source: 1, status: 1 });

const devicesLotModel = mongoose.model("devicesLot", devicesLotSchema);

export default devicesLotModel;
