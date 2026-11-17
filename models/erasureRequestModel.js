import mongoose from "mongoose";

// DPDP Act 2023 - Section 5.2: Right to Erasure
// Tracks user data deletion requests with 30-day grace period
const erasureRequestSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    userEmail: {
      type: String,
      required: true,
    },
    userPhone: {
      type: String,
      required: false,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true, // User who made the request (could be self or admin)
    },
    requestDate: {
      type: Date,
      default: Date.now,
      required: true,
    },
    scheduledDeletionDate: {
      type: Date,
      required: true,
      index: true, // Index for scheduled job queries
    },
    status: {
      type: String,
      enum: ["PENDING", "CANCELLED", "COMPLETED"],
      default: "PENDING",
      required: true,
    },
    reason: {
      type: String,
      maxlength: 500,
      required: false,
    },
    ipAddress: {
      type: String,
      required: false,
    },
    userAgent: {
      type: String,
      required: false,
    },
    cancellationDate: {
      type: Date,
      required: false,
    },
    cancellationReason: {
      type: String,
      maxlength: 500,
      required: false,
    },
    completionDate: {
      type: Date,
      required: false,
    },
    deletedData: {
      // Summary of what was deleted
      leads: { type: Number, default: 0 },
      pickupDevices: { type: Number, default: 0 },
      pendingDevices: { type: Number, default: 0 },
      quoteLogs: { type: Number, default: 0 },
      user: { type: Boolean, default: false },
    },
  },
  {
    timestamps: true,
  }
);

// TTL index: Auto-delete completed/cancelled requests after 2 years (compliance record retention)
erasureRequestSchema.index(
  { updatedAt: 1 },
  {
    expireAfterSeconds: 2 * 365 * 24 * 60 * 60, // 2 years
    partialFilterExpression: { status: { $in: ["COMPLETED", "CANCELLED"] } },
  }
);

// Index for finding pending requests by user
erasureRequestSchema.index({ userId: 1, status: 1 });

const erasureRequestModel = mongoose.model("ErasureRequest", erasureRequestSchema);

export default erasureRequestModel;
