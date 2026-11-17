import mongoose from "mongoose";

const smsSchema = new mongoose.Schema({
  mobileNumber: { type: String, required: true, unique: true },
  otp: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

// TTL Index - Auto-delete SMS/OTP records after 10 minutes
// DPDP Act Compliance - Section 6.1 (Data Minimization)
// Documents are automatically removed 600 seconds (10 minutes) after createdAt timestamp
smsSchema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

export default mongoose.model("Sms", smsSchema);
