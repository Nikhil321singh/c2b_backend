import categoryModel from "../models/categoryModel.js";
import { safeLog } from '../utils/piiMasking.js';


const getCategory = async (req, res) => {
  try {
    const data = await categoryModel.find().sort({ viewOn: 1 });
    res.status(200).json({ data, message: "categories fetched successfully." });
  } catch (error) {
    safeLog.error('Error fetching categories:', error);
    res.status(500).json({ message: error.message });
  }
};

export default {
  getCategory,
};
