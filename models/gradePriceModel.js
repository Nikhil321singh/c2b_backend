import mongoose from "mongoose";
const { Schema } = mongoose;

const gradePriceSchema = new Schema(
  {
    modelId: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "models"
    },
    grades: {
      A_PLUS: Number,
      A: Number,
      A_MINUS: Number, // New format
      A_MINUS_LIMITED: Number, // New format
      B_PLUS: Number, // New format
      B: Number,
      B_MINUS: Number,
      B_MINUS_LIMITED: Number, // New format
      C_PLUS: Number,
      C: Number,
      C_MINUS: Number,
      C_MINUS_LIMITED: Number, // New format
      D_PLUS: Number,
      D: Number,
      D_MINUS: Number,
      E: Number,
    },
    storage: {
      type: String,
      required: true,
    },
    RAM: {
      type: String,
    },
    price: {
      type: Number,
      default: 0
    },
    partnerId: {
      type: mongoose.Types.ObjectId,
      ref: "liquidators"
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: "company",
      default: null
    },
    isGlobalPrice: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
);

gradePriceSchema.index({ modelId: 1, storage: 1, RAM: 1, companyId: 1 });
gradePriceSchema.index({ companyId: 1 });
gradePriceSchema.index({ isGlobalPrice: 1 });

const gradePriceModel = mongoose.model("gradeprice", gradePriceSchema);

export default gradePriceModel;
