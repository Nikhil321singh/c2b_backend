import express from 'express'
import questionnaireController from '../controller/questionnaireController.js'
import multer from 'multer'
import verifyToken from '../middlewares/authJwt.js'
import {
  encryptRequestPII,
  decryptResponsePII,
} from '../middlewares/piiEncryptionMiddleware.js'

const questionnaireRoute = express.Router()

const upload = multer({ storage: multer.memoryStorage() })

var storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'upload')
  },
  filename: function (req, file, cb) {
    cb(null, `${Date.now()}-${file.originalname}`)
  },
})

const uploads = multer({ storage: storage })

// Apply decryptResponsePII globally to all GET routes
questionnaireRoute.use(decryptResponsePII)

questionnaireRoute
  .post('/add', verifyToken, questionnaireController.create)
  .post(
    '/add-many',
    verifyToken,
    upload.single('file'),
    questionnaireController.insertMany,
  )
  .get('/findAll', verifyToken, questionnaireController.findAll)
  .post(
    '/calculatePrice',
    verifyToken,
    encryptRequestPII,
    questionnaireController.calculatePrice,
  )
  .post(
    '/item-purchased',
    verifyToken,
    upload.single('file'),
    questionnaireController.itemPurchased,
  )
  .post(
    '/upload-documents',
    verifyToken,
    upload.fields([
      { name: 'adharFront' },
      { name: 'adharBack' },
      { name: 'phoneBill' },
      { name: 'phoneFront' },
      { name: 'phoneBack' },
      { name: 'phoneUp' },
      { name: 'phoneDown' },
      { name: 'phoneLeft' },
      { name: 'phoneRight' },
      { name: 'signature' },
    ]),
    encryptRequestPII,
    questionnaireController.uploadDocuments,
  )
  .post(
    '/getSubmitedData',
    verifyToken,
    decryptResponsePII,
    questionnaireController.getSubmitedData,
  )
  .get('/getDocuments', verifyToken, questionnaireController.getDocuments)
  .get(
    '/questionnaireList',
    verifyToken,
    questionnaireController.questionnaireList,
  )
  .put('/edit', verifyToken, questionnaireController.update)
  .delete('/deleteById', verifyToken, questionnaireController.deleteById)
  .post(
    '/calculatePriceWatch',
    verifyToken,
    encryptRequestPII,
    questionnaireController.calculatePriceWatch,
  )
  .post(
    '/customerDetail',
    encryptRequestPII,
    questionnaireController.customerDetail,
  )

export default questionnaireRoute
