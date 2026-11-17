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
    paymentMode: {
      type: String,
      enum: ["COMPANY_ACCOUNTS", "MANAGER_FUNDS", "PREPAID_DEFERRED"],
      default: "COMPANY_ACCOUNTS",
    },
    paymentStatus: {
      type: String,
      enum: ["PAYMENT_REQUESTED", "FLAGGED", "PROCESSING", "PAYMENT_DONE"],
      default: "PAYMENT_REQUESTED",
      index: true,
    },
    requestedAt: { type: Date },
    paidAt: { type: Date },
    paidBy: { type: mongoose.Types.ObjectId, ref: "users" },
    paymentReference: { type: String, trim: true },
    warehouseStatus: {
      type: String,
      enum: ["NOT_READY", "IN_WAREHOUSE"],
      default: "NOT_READY",
      index: true,
    },
    warehouseTransferredAt: { type: Date },
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
devicesLotSchema.index({ warehouseStatus: 1, companyId: 1, updatedAt: -1 });

const devicesLotModel = mongoose.model("devicesLot", devicesLotSchema);

export default devicesLotModel;
