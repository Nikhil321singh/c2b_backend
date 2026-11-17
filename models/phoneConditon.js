import mongoose from "mongoose";
const { Schema } = mongoose;

const condtionCodesSchema = new Schema(
  {
    warrentyCode: { type: String },
    coreCode: { type: String },
    displayCode: { type: String },
    functionalMajorCode: { type: String },
    functionalMinorCode: { type: String },
    cosmeticsCode: { type: String },
    functionalCode: { type: String },
    accessoriesCode: { type: String },
    coreCondition: { type: String },
    displayCondition: { type: String },
    functionalMajorCondition: { type: String },
    functionalMinorCondition: { type: String },
    cosmeticsCondition: { type: String },
    functionalCondition: { type: String },
    accessoriesCondition: { type: String },
    grade: { type: String },
    deviceType: { type: String },
    warrentyCondition: { type: String },
  },
  { timestamps: true }
);

// Performance optimization indexes for price calculation queries
// Compound index covering common query patterns
condtionCodesSchema.index({
  warrentyCode: 1,
  displayCode: 1,
  functionalMajorCode: 1,
  functionalMinorCode: 1,
  cosmeticsCode: 1,
});

condtionCodesSchema.index({ deviceType: 1 });
condtionCodesSchema.index({ grade: 1 });

const phoneConditon = mongoose.model("condtioncodes", condtionCodesSchema);

export default phoneConditon;
