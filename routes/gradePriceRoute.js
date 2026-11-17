import express from 'express'
import gradePriceController from '../controller/gradePriceController.js'
import companyPriceController from '../controller/companyPriceController.js'
import multer from 'multer'

const gradePriceRoute = express.Router()

const upload = multer({ storage: multer.memoryStorage() })

gradePriceRoute
  .post(
    '/global/upload',
    upload.single('file'),
    gradePriceController.addEditModelsAndPrice,
  )
  .post(
    '/company/upload',
    upload.single('file'),
    companyPriceController.addEditCompanyModelsAndPrice,
  )
  .get('/modelPriceList', gradePriceController.modelPriceList)
  .get('/getModelWisePrice', gradePriceController.getModelWisePrice)

export default gradePriceRoute
