import questionnaire from '../models/questionnaireModel.js'
import { safeLog } from '../utils/piiMasking.js'
import leads from '../models/leadsModel.js'
import models from '../models/modelsModel.js'
import documents from '../models/documents.model.js'
import XLSX from 'xlsx'
import fs from 'fs'
import { fileURLToPath } from 'url'
import path, { dirname } from 'path'
import leadsController from './leadsController.js'
import {
  validateLeadAndUser,
  FunctionalUpd,
  PhysicalUpd,
  AccessoriesUpd,
} from '../utils/questionnaireUtils.js'

const fileName = fileURLToPath(import.meta.url)
const dirName = dirname(fileName)

const PURCHASE_RECEIPT_TEMPLATE_PATH = '../templates/purchase_receipt.html'
const INVOICE_TEMPLATE_PATH = '../templates/invoice.html'

import {
  WARRANTY1,
  WARRANTY2,
  FUNCTIONAL_MAJOR1,
  FUNCTIONAL_MAJOR1_1,
  COSMETICS1,
  COSMETICS2,
  COSMETICS3,
  COSMETICS4,
  ACCESSORIES1,
  ACCESSORIES2,
  ACCESSORIES3,
} from '../const.js'
import condtionCodesWatch from '../models/conditionCodesWatchModel.js'
import { tncContent } from '../utils/termsAndConditions.js'
import companyModel from '../models/companyModel.js'
import {
  decryptPII,
  decryptPIIFields,
  PII_FIELDS_TO_ENCRYPT,
} from '../utils/kmsEncryption.js'
import { isSangeetaStore } from '../utils/sangeetaStoreUtils.js'
import { getMaxNegotiationAmount, negotiationLimitMessage } from '../utils/negotiationLimitUtils.js'

import {
  generateInvoiceHtml,
  createPdfBuffer,
  uploadPdfToS3,
  getSignatureBase64,
  sendConfirmationEmail,
  sendStoreInvoiceEmail,
} from '../utils/invoiceHelpers.js'
import { generateLeadAndUpdateOrCreate } from '../utils/leadGenerationService.js'
import {
  buildQuery,
  fetchGradeData,
  fetchPriceData,
  calculatePriceFromGrades,
  buildLeadObject,
  buildQueryParam,
} from '../utils/priceCalculationService.js'
import { buildToUpdate } from './questionnaireHelpers.js'
import {
  PayoutBusinessError,
  createPayoutForPurchase,
  getPayoutModeForStore,
  validatePayoutEligibility,
} from '../services/buybackPayoutService.js'

const create = async (req, res) => {
  try {
    const { group, yes, no, quetion } = req.body
    if (!group || !yes || !no || !quetion || !req.body.default) {
      return res.status(400).json({ message: 'All fields are required' })
    }
    const data = await questionnaire.create(req.body)
    return res
      .status(200)
      .json({ data, message: 'questionnaires created successfully.' })
  } catch (error) {
    safeLog.info(error)
    return res.status(500).json({ message: error.message })
  }
}

const insertMany = async (req, res) => {
  const cs = convertCsvToJson(req.file)
  try {
    const data = await questionnaire.insertMany(cs)
    res
      .status(200)
      .json({ data, message: 'questionnaires created successfully.' })
  } catch (error) {
    safeLog.info(error)
    res.status(500).json({ message: error.message })
  }
}

const findAll = async (req, res) => {
  try {
    const page = Number(req.query.page) || 0
    const deviceType = req.query.type || 'CTG1'
    const limit = 50
    const data = await questionnaire
      .find({ type: deviceType })
      .limit(limit)
      .skip(page * limit)
      .sort({ viewOn: 1 })
      .lean() // Convert to plain JavaScript objects
    const totalCounts = await questionnaire.countDocuments({
      type: deviceType,
    })
    res.status(200).json({
      data,
      totalCounts,
      message: 'questionnaires fetched successfully.',
    })
  } catch (error) {
    safeLog.info(error)
    res.status(500).json({ message: error.message })
  }
}

const calculatePrice = async (req, res) => {
  try {
    const {
      QNA,
      phoneNumber,
      modelId,
      storage,
      name,
      ram,
      aadharNumber,
      companyId,
    } = req.body

    if (!QNA || !phoneNumber || !modelId) {
      return res.status(403).json({
        success: false,
        message: 'QNA, phone number, and modelId are required',
      })
    }

    const query = buildQuery(QNA)
    safeLog.info('Constructed Query:', { query })

    const [gradeData, priceData, modelData] = await Promise.all([
      fetchGradeData(query),
      fetchPriceData(modelId, storage, ram, companyId),
      models.findOne({ _id: modelId }).select('brandId'),
    ])

    safeLog.info('Fetched Grade Data:', { gradeData })
    // Fetch price data
    safeLog.info('Fetching price data with params:', {
      modelId,
      storage,
      ram,
      companyId,
    })
    safeLog.info('Fetched Price Data:', { priceData })

    const price = calculatePriceFromGrades(priceData, gradeData, query)

    safeLog.info('Calculated Price:', { price })

    const userDetails = {
      QNA,
      phoneNumber,
      aadharNumber,
      name,
    }
    safeLog.info(userDetails)

    const modelDetails = {
      modelId,
      brandId: modelData.brandId,
      storage,
      ram,
    }
    safeLog.info(modelDetails)

    const obj = buildLeadObject(
      req,
      userDetails,
      modelDetails,
      gradeData,
      price,
    )
    safeLog.info(obj)

    const { lead, uniqueCode } = await generateLeadAndUpdateOrCreate(
      req,
      obj,
      buildQueryParam(phoneNumber, modelId, storage, ram, req.userId),
    )
    safeLog.info({ gradeData })
    const CONVERSION_FEE = Number(process.env.CONVERSION_FEE) || 10

    return res.status(200).json({
      data: {
        id: lead._id,
        price: Number(price),
        grade: gradeData?.grade,
        uniqueCode,
        conversionFee: CONVERSION_FEE,
      },
      message: 'Price fetched successfully.',
    })
  } catch (error) {
    safeLog.error(error)
    return res.status(500).json({ message: error.message })
  }
}

// --- Background Processing Function ---

const generatePdfBuffers = async (customerHtmlContent, adminHtmlContent) => {
  const pdfResults = await Promise.allSettled([
    createPdfBuffer(customerHtmlContent),
    createPdfBuffer(adminHtmlContent),
  ])

  const customerPdfBuffer =
    pdfResults[0].status === 'fulfilled' ? pdfResults[0].value : null
  const adminPdfBuffer =
    pdfResults[1].status === 'fulfilled' ? pdfResults[1].value : null

  if (pdfResults[0].status === 'rejected') {
    safeLog.error(
      'Customer PDF generation failed (background):',
      pdfResults[0].reason,
    )
  }
  if (pdfResults[1].status === 'rejected') {
    safeLog.error(
      'Admin PDF generation failed (background):',
      pdfResults[1].reason,
    )
  }

  return { customerPdfBuffer, adminPdfBuffer }
}

const uploadAdminPdfToS3 = async (adminPdfBuffer, lead, isSangeeta) => {
  if (!adminPdfBuffer) {
    safeLog.warn('Admin PDF not generated, skipping S3 upload (background)')
    return
  }

  try {
    const receiptUrl = isSangeeta
      ? await uploadPdfToS3(adminPdfBuffer, lead.uniqueCode)
      : ''
    await leads.findByIdAndUpdate(lead._id, { reciept: receiptUrl })
    safeLog.info('Receipt uploaded to S3 and database updated:', receiptUrl)
  } catch (error) {
    safeLog.error('S3 upload failed (background):', error)
  }
}

const sendCustomerEmail = async (customerPdfBuffer, lead) => {
  if (!customerPdfBuffer) {
    safeLog.warn('Customer PDF not available, skipping email (background)')
    return
  }

  try {
    await sendConfirmationEmail(lead, customerPdfBuffer)
    safeLog.info('Confirmation email sent successfully for lead:', lead._id)
  } catch (error) {
    safeLog.error('Email sending failed (background):', error)
  }
}

/**
 * Process receipt generation and email sending in background
 * This runs asynchronously without blocking the HTTP response
 */
const processReceiptAndEmailInBackground = async (
  lead,
  reqBody,
  companySettings,
  signatureBase64,
  customerHtmlTemplate,
  adminHtmlTemplate,
) => {
  try {
    safeLog.info('Starting background receipt processing for lead:', lead._id)

    const isSangeeta = lead.storeId
      ? await isSangeetaStore(lead.storeId)
      : false

    const customerHtmlContent = generateInvoiceHtml(
      customerHtmlTemplate,
      lead,
      reqBody,
      {
        showPrice: companySettings.showPrice,
        maskInfo: companySettings.maskInfo,
        signatureBase64,
      },
    )

    const adminHtmlContent = generateInvoiceHtml(
      adminHtmlTemplate,
      lead,
      reqBody,
      {
        maskInfo: companySettings.maskInfo,
        signatureBase64,
        showBonusOffer: isSangeeta,
      },
    )

    const { customerPdfBuffer, adminPdfBuffer } = await generatePdfBuffers(
      customerHtmlContent,
      adminHtmlContent,
    )

    await uploadAdminPdfToS3(adminPdfBuffer, lead, isSangeeta)
    await sendCustomerEmail(customerPdfBuffer, lead)

    safeLog.info('Background receipt processing completed for lead:', lead._id)
  } catch (error) {
    safeLog.error('Background receipt processing error:', error)
  }
}

// --- Helper Functions for itemPurchased ---

const fetchCompanySettings = async (companyId) => {
  const defaults = { showPrice: false, maskInfo: false }
  if (!companyId) {
    return defaults
  }

  const company = await companyModel
    .findById(companyId)
    .select('showPrice maskInfo')

  return company
    ? { showPrice: company.showPrice, maskInfo: company.maskInfo }
    : defaults
}

const applyNegotiationRules = async (lead, reqBody) => {
  lead.negotiatedAmount = Number(reqBody.negotiatedAmount || 0)
  if (lead.negotiatedAmount <= 0) {
    return null
  }
  const maxNegotiationAmount = await getMaxNegotiationAmount(
    lead.userId?.companyId,
  )
  if (lead.negotiatedAmount > maxNegotiationAmount) {
    return negotiationLimitMessage(maxNegotiationAmount)
  }
  if (lead.bonusPrice > 0) {
    lead.bonusPrice = 0
  }
  return null
}

const generateInvoicePdfs = async (
  lead,
  reqBody,
  companySettings,
  signatureBase64,
  isSangeeta,
) => {
  const customerTemplatePath = companySettings.showPrice
    ? path.join(dirName, '../templates/purchase_receipt.html')
    : path.join(dirName, '../templates/invoice.html')

  const customerHtmlTemplate = fs.readFileSync(customerTemplatePath, 'utf-8')

  const customerHtmlContent = generateInvoiceHtml(
    customerHtmlTemplate,
    lead,
    reqBody,
    {
      showPrice: companySettings.showPrice,
      maskInfo: companySettings.maskInfo,
      signatureBase64,
      showBonusOffer: isSangeeta,
    },
  )

  const storeHtmlContent = generateInvoiceHtml(
    customerHtmlTemplate,
    lead,
    reqBody,
    {
      showPrice: true,
      maskInfo: companySettings.maskInfo,
      signatureBase64,
      showBonusOffer: isSangeeta,
    },
  )
  // Both PDFs are built at the same time; each takes a few seconds.
  const [customerPdfBuffer, storePdfBuffer] = await Promise.all([
    createPdfBuffer(customerHtmlContent),
    createPdfBuffer(storeHtmlContent),
  ])

  return { customerPdfBuffer, storePdfBuffer }
}

const sendEmailsWithErrorHandling = async (
  lead,
  customerPdfBuffer,
  storePdfBuffer,
) => {
  let customerEmailSent = !lead.emailId
  let storeEmailSent = !lead.store?.email
  if (lead.emailId) {
    try {
      safeLog.info('Attempting to send confirmation email to:', lead.emailId)
      await sendConfirmationEmail(lead, customerPdfBuffer)
      customerEmailSent = true
      safeLog.info('Confirmation email sent successfully to:', lead.emailId)
    } catch (emailError) {
      safeLog.error('Failed to send confirmation email:', {
        error: emailError.message,
        stack: emailError.stack,
        emailId: lead.emailId,
        leadId: lead._id,
      })
    }
  } else {
    safeLog.warn('No email address found for lead:', lead._id)
  }

  if (lead.store?.email) {
    try {
      safeLog.info(
        'Attempting to send store invoice email to:',
        lead.store.email,
      )
      await sendStoreInvoiceEmail(lead.store, lead, storePdfBuffer)
      storeEmailSent = true
      safeLog.info(
        'Store invoice email sent successfully to:',
        lead.store.email,
      )
    } catch (storeEmailError) {
      safeLog.error('Failed to send store invoice email:', {
        error: storeEmailError.message,
        stack: storeEmailError.stack,
        storeEmail: lead.store?.email,
        leadId: lead._id,
      })
    }
  } else {
    safeLog.warn('No email address found for store:', lead._id)
  }
  return { customerEmailSent, storeEmailSent }
}

export const finalizePurchaseAfterPayout = async (leadId, paymentDetails = {}) => {
  const leadFromDb = await leadsController.getLeadById(leadId)
  if (!leadFromDb) {
    throw new Error('Lead not found while generating payout receipt')
  }
  const lead = await decryptPIIFields(
    leadFromDb,
    PII_FIELDS_TO_ENCRYPT,
  )
  const companySettings = await fetchCompanySettings(
    lead?.userId?.companyId || lead.companyId,
  )
  const signatureBase64 = await getSignatureBase64(
    lead.documentId?.signature,
  )
  const isSangeeta = lead.storeId
    ? await isSangeetaStore(lead.storeId)
    : false
  const { customerPdfBuffer, storePdfBuffer } = await generateInvoicePdfs(
    lead,
    paymentDetails,
    companySettings,
    signatureBase64,
    isSangeeta,
  )
  const receiptUrl = isSangeeta
    ? await uploadPdfToS3(storePdfBuffer, lead.uniqueCode)
    : ''
  await leads.findByIdAndUpdate(lead._id, { reciept: receiptUrl })
  const delivery = await sendEmailsWithErrorHandling(
    lead,
    customerPdfBuffer,
    storePdfBuffer,
  )
  if (!delivery.customerEmailSent) {
    throw new Error('Customer receipt email delivery failed')
  }
  return receiptUrl
}

// --- Main Controller Function ---

// Undo the "sold" marking applied before payout creation. Only the fields that
// gate a resale are reverted; the quote figures are harmless and are rewritten
// by the next attempt. Pure.
export const buildSaleRollback = (previousStatus) => ({
  $set: {
    is_selled: false,
    ...(previousStatus ? { status: previousStatus } : {}),
  },
  $unset: { soldAt: '', payoutAmount: '' },
})

const prepareLeadForSale = async (lead, body) => {
  lead.price = Number(body.sellingPrice)
  lead.bonusPrice = Number(body.bonusPrice ?? 0)
  lead.slabBonusAmount = Number(body.slabBonusAmount || 0)
  lead.slabApplied = body.slabApplied || ''
  lead.couponDiscount = Number(body.couponDiscount || 0)
  lead.exactValue = Number(body.exactValue || lead.price)
  lead.quotedPrice = Number(body.quotedPrice || lead.price)
  lead.actualPrice = Number(body.quotedPrice || lead.price)
  lead.is_selled = true
  lead.soldAt = new Date()
  lead.tncVersion = tncContent.version

  const negotiationError = await applyNegotiationRules(lead, body)
  const payoutAmount = Math.floor(
    lead.price +
      lead.bonusPrice +
      lead.negotiatedAmount +
      lead.couponDiscount,
  )
  return { negotiationError, payoutAmount }
}

const buildPayoutNotificationMessage = (notification) => {
  if (notification.pendingUserAction) {
    return 'Payout is ready. Click Pay Now to send the customer payment link.'
  }
  if (notification.delivered) {
    return `Payout link sent by ${notification.channel || 'notification'}.`
  }
  return 'Payout link created, but notification delivery failed.'
}

const createPayoutForPurchaseWithRollback = async ({
  lead,
  initiatedBy,
  amount,
  previousStatus,
  leadUpdate,
}) => {
  await leads.findByIdAndUpdate(lead._id, leadUpdate)
  let payoutResult
  try {
    payoutResult = await createPayoutForPurchase({
      lead,
      initiatedBy,
      amount,
    })
  } catch (error) {
    // The lead is marked sold before the payout exists. Without this
    // rollback a failed payout leaves a sold lead with nothing to pay it,
    // and the is_selled guard above rejects every retry as "Item sold out".
    await leads.findByIdAndUpdate(
      lead._id,
      buildSaleRollback(previousStatus),
    )
    throw error
  }
  return payoutResult
}

const isSangeetaStoreForLead = async (lead) => {
  if (!lead.storeId) {
    return false
  }
  return isSangeetaStore(lead.storeId)
}

const uploadReceiptPdf = async (isSangeeta, storePdfBuffer, lead) => {
  if (!isSangeeta) {
    return ''
  }
  return uploadPdfToS3(storePdfBuffer, lead.uniqueCode)
}

// Receipt emails go out after the sale has been answered, so a slow or
// blocked mail server cannot hold the Sell button. A failure is logged only;
// the sale is already saved.
export const sendReceiptsInBackground = (send) => {
  Promise.resolve()
    .then(send)
    .catch((error) => {
      safeLog.error('Receipt emails failed after sale:', {
        error: error?.message,
      })
    })
}

const getErrorStatusCode = (error) => {
  if (error instanceof PayoutBusinessError) {
    return error.statusCode
  }
  return 500
}

const itemPurchased = async (req, res) => {
  try {
    const leadFromDb = await leadsController.getLeadById(req.body.id)
    safeLog.info('item-purchased lead', leadFromDb)

    if (!validateLeadAndUser(leadFromDb, req.userId)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid user or id' })
    }

    if (leadFromDb.is_selled) {
      return res
        .status(200)
        .json({ success: true, message: 'Item sold out', data: leadFromDb })
    }

    const lead = await decryptPIIFields(leadFromDb, PII_FIELDS_TO_ENCRYPT)
    safeLog.info('Decrypted lead for invoice generation')

    const companySettings = await fetchCompanySettings(lead?.userId?.companyId)
    safeLog.info('lead.store.companyId', lead.userId.companyId)

    const { negotiationError, payoutAmount } = await prepareLeadForSale(
      lead,
      req.body,
    )
    if (negotiationError) {
      return res
        .status(400)
        .json({ success: false, message: negotiationError })
    }
    if (!Number.isFinite(payoutAmount) || payoutAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Purchase amount must be greater than zero',
      })
    }
    const payoutMode = await getPayoutModeForStore(lead.storeId)
    const isHsbcPayout = ['HSBC_UPI', 'HSBC_IMPS', 'HSBC_NEFT'].includes(
      payoutMode.mode,
    )
    if (isHsbcPayout) {
      await validatePayoutEligibility({
        lead,
        amount: payoutAmount,
        settings: payoutMode.settings,
      })
    }

    const leadUpdate = {
      price: lead.price,
      bonusPrice: lead.bonusPrice,
      slabBonusAmount: lead.slabBonusAmount,
      negotiatedAmount: lead.negotiatedAmount,
      slabApplied: lead.slabApplied,
      couponDiscount: lead.couponDiscount,
      exactValue: lead.exactValue,
      quotedPrice: lead.quotedPrice,
      actualPrice: lead.actualPrice,
      is_selled: lead.is_selled,
      soldAt: lead.soldAt,
      tncVersion: lead.tncVersion,
      ...(isHsbcPayout
        ? { status: 'Payment Pending', payoutAmount }
        : {}),
    }

    if (isHsbcPayout) {
      const payoutResult = await createPayoutForPurchaseWithRollback({
        lead,
        initiatedBy: req.userId,
        amount: payoutAmount,
        previousStatus: leadFromDb.status,
        leadUpdate,
      })
      return res.status(200).json({
        success: true,
        data: lead.modelId,
        id: lead._id,
        payout: {
          id: payoutResult.payout._id,
          amount: payoutResult.payout.amount,
          status: payoutResult.payout.status,
          statusMessage: payoutResult.payout.statusMessage,
          approvalRequired: payoutResult.payout.approval.required,
          paymentLink: payoutResult.paymentLink,
          notificationDelivered:
            payoutResult.notification.delivered,
        },
        message: buildPayoutNotificationMessage(payoutResult.notification),
      })
    }

    const signatureUrl = lead.documentId?.signature
    const signatureBase64 = await getSignatureBase64(signatureUrl)

    const isSangeeta = await isSangeetaStoreForLead(lead)

    const { customerPdfBuffer, storePdfBuffer } = await generateInvoicePdfs(
      lead,
      req.body,
      companySettings,
      signatureBase64,
      isSangeeta,
    )

    const receiptUrl = await uploadReceiptPdf(
      isSangeeta,
      storePdfBuffer,
      lead,
    )

    await leads.findByIdAndUpdate(lead._id, {
      ...leadUpdate,
      reciept: receiptUrl,
    })

    const response = res.status(200).json({
      data: lead.modelId,
      id: lead._id,
      message:
        'Item Sold Successfully. Receipt will be sent to your email shortly.',
    })
    sendReceiptsInBackground(() =>
      sendEmailsWithErrorHandling(lead, customerPdfBuffer, storePdfBuffer),
    )
    return response
  } catch (error) {
    safeLog.error('Error in itemPurchased:', error)
    return res
      .status(getErrorStatusCode(error))
      .json({ message: error.message })
  }
}

const customerDetail = async (req, res) => {
  try {
    const { phoneNumber, name, emailId, leadId } = req.body
    if (!phoneNumber || !name || !emailId || !leadId) {
      return res.status(400).json({ message: 'Required fields are missing' })
    }
    await leads.findByIdAndUpdate(
      { _id: leadId },
      {
        phoneNumber,
        name,
        emailId,
        is_selled: true,
        userId: '6540d7df4058702d148699e8',
      },
    )
    return res.status(200).json({ message: 'Customer Details Added' })
  } catch (error) {
    safeLog.info(error)
    return res.status(500).json({ message: error.message })
  }
}

const convertCsvToJson = (file) => {
  const workbook = XLSX.read(file.buffer, { type: 'buffer' })
  var sheetNameList = workbook.SheetNames
  const options = { defval: '' }
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetNameList[0]], options)
}

const getSubmitedData = async (req, res) => {
  try {
    let lead = await leads
      .findOne({ userId: req.userId, _id: req.body.id })
      .populate('modelId')
    if (lead.gradeId) {
      lead = await leads
        .findOne({ userId: req.userId, _id: req.body.id })
        .populate('modelId')
        .populate('gradeId')
    }
    return res
      .status(200)
      .json({ data: lead, message: 'Item Fetched Successfully.' })
  } catch (error) {
    return res.status(500).json({ message: error.message })
  }
}

const uploadDocuments = async (req, res) => {
  try {
    const { IMEI, leadId } = req.body
    const Bucket = process.env.S3_BUCKET_NAME
    const Region = process.env.S3_REGION
    const Folder = process.env.S3_FOLDER

    // Decrypt IMEI for use in S3 URLs (IMEI comes encrypted from encryptRequestPII middleware)
    const decryptedIMEI = await decryptPII(IMEI)

    const obj = {
      IMEI: IMEI || '', // Keep encrypted IMEI for database storage
      adhar: {
        front: `https://${Bucket}.s3.${Region}.amazonaws.com/${Folder}/${decryptedIMEI}-adhaarFront`,
        back: `https://${Bucket}.s3.${Region}.amazonaws.com/${Folder}/${decryptedIMEI}-adhaarBack`,
      },
      phoneBill:
        req.body.phoneBill ||
        `https://${Bucket}.s3.${Region}.amazonaws.com/${Folder}/${decryptedIMEI}-phoneBill`,
      phonePhotos: {
        front:
          req.body.adhaarFront ||
          `https://${Bucket}.s3.${Region}.amazonaws.com/${Folder}/${decryptedIMEI}-phoneFront`,
        back:
          req.body.adhaarBack ||
          `https://${Bucket}.s3.${Region}.amazonaws.com/${Folder}/${decryptedIMEI}-phoneBack`,
        up:
          req.body.phoneTop ||
          `https://${Bucket}.s3.${Region}.amazonaws.com/${Folder}/${decryptedIMEI}-phoneTop`,
        down:
          req.body.phoneBottom ||
          `https://${Bucket}.s3.${Region}.amazonaws.com/${Folder}/${decryptedIMEI}-phoneLeft`,
        left:
          req.body.phoneLeft ||
          `https://${Bucket}.s3.${Region}.amazonaws.com/${Folder}/${decryptedIMEI}-phoneRight`,
        right:
          req.body.phoneRight ||
          `https://${Bucket}.s3.${Region}.amazonaws.com/${Folder}/${decryptedIMEI}-phoneBottom`,
      },
      signature:
        req.body.signature ||
        `https://${Bucket}.s3.${Region}.amazonaws.com/${Folder}/${decryptedIMEI}-signature`,
      customerPhoto:
        req.body.customerPhoto ||
        `https://${Bucket}.s3.${Region}.amazonaws.com/${Folder}/${decryptedIMEI}-customerPhoto`,
      ceir:
        req.body.ceir ||
        `https://${Bucket}.s3.${Region}.amazonaws.com/${Folder}/${decryptedIMEI}-ceir`,
      userId: req.userId,
      leadId: leadId,
    }
    const data = await documents.create(obj)
    const lead = await leads.findOne({ _id: leadId }).select('gradeId')
    const toUpdate = await buildToUpdate(leadId, data._id, lead, req.body)

    await leads.findByIdAndUpdate({ _id: leadId }, toUpdate)
    return res
      .status(200)
      .json({ data, message: 'Documents uploaded successfully.' })
  } catch (error) {
    safeLog.info(error)
    return res.status(500).json({ message: error.message })
  }
}

const getDocuments = async (req, res) => {
  try {
    const page = Number(req.query.page) || 0
    const limit = Number(req.query.limit) || 10
    const data = await documents
      .find({})
      .populate('userId')
      .populate('leadId')
      .limit(limit)
      .skip(page * limit)
      .sort({ createdAt: -1 })
    const totalCounts = await documents.countDocuments({})
    res
      .status(200)
      .json({ data, totalCounts, message: 'documents fetched successfully.' })
  } catch (error) {
    safeLog.info(error)
    res.status(500).json({ message: error.message })
  }
}

const questionnaireList = async (req, res) => {
  const deviceType = req.query.deviceType || 'CTG1'

  try {
    const data = await questionnaire.aggregate([
      {
        $match: {
          type: deviceType,
        },
      },
      {
        $lookup: {
          from: 'categories',
          localField: 'type',
          foreignField: 'categoryCode',
          as: 'categoryInfo',
        },
      },
      {
        $unwind: { path: '$categoryInfo', preserveNullAndEmptyArrays: true },
      },
      {
        $group: {
          _id: '$group',
          data: { $push: '$$ROOT' }, // Keep all fields in the array
        },
      },
    ])
    res
      .status(200)
      .json({ data, message: 'questionnaire List fetched successfully.' })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
}

const update = async (req, res) => {
  try {
    const { id, group, yes, no, quetion } = req.body
    if (!id || !group || !yes || !no || !quetion || !req.body.default) {
      return res.status(400).json({ message: 'All fields are required' })
    }
    const result = await questionnaire.findByIdAndUpdate(
      { _id: req.body._id || req.body.id },
      req.body,
      { new: true },
    )
    return res.status(200).json({ result })
  } catch (error) {
    return res.status(500).json({ message: error.message, status: 500 })
  }
}

const deleteById = async (req, res) => {
  try {
    const { id } = req.query
    if (!id) {
      return res.status(400).json({ message: 'id is required' })
    }
    const result = await questionnaire.findByIdAndDelete(id)
    return res.status(200).json({ result })
  } catch (error) {
    return res.status(500).json({ message: error.message, status: 500 })
  }
}

//calcuatle the watch prce
const calculatePriceWatch = async (req, res) => {
  try {
    const { QNA, modelId, name, phoneNumber, aadharNumber } = req.body
    const query = {}
    if (!QNA || !modelId) {
      return res.status(403).json({
        success: false,
        message: 'QNA and modelId are required',
      })
    }

    const warranty = QNA?.Warranty
      ? QNA.Warranty.filter((e) => e.answer === WARRANTY1)
      : []
    query.warrentyCode = warranty.length ? WARRANTY1 : WARRANTY2

    FunctionalUpd(QNA, query, FUNCTIONAL_MAJOR1, FUNCTIONAL_MAJOR1_1)
    PhysicalUpd(QNA, query, COSMETICS1, COSMETICS2, COSMETICS3, COSMETICS4)
    AccessoriesUpd(QNA, query, ACCESSORIES1, ACCESSORIES2, ACCESSORIES3)
    //settig uniquew code
    const [gradeData, priceData, modelData] = await Promise.all([
      condtionCodesWatch.findOne(query).select('grade'),
      gradeprices.findOne({ modelId }).select('grades'),
      models.findOne({ _id: modelId }),
    ])

    safeLog.info({ query, gradeData, priceData })

    const price = calculatePriceFromGrades(priceData, gradeData, query)
    const actualPrice = price

    safeLog.info('Calculated Price:', { price })

    const queryParam = {
      phoneNumber,
      modelId,
      userId: req.userId,
      is_selled: false,
    }
    const obj = {
      QNA,
      modelId,
      brandId: modelData.brandId,
      userId: req.userId,
      price,
      gradeId: gradeData._id,
      actualPrice,
      uniqueCode: process.env.UNIQUE_CODE,
      ram: modelData.config[0].RAM,
      phoneNumber,
      aadharNumber,
      name,
    }
    const { lead, uniqueCode } = await generateLeadAndUpdateOrCreate(
      req,
      obj,
      queryParam,
    )
    return res.status(200).json({
      data: {
        id: lead._id,
        price: Number(price),
        grade: gradeData.grade,
        uniqueCode,
      },
      message: 'price fetched successfully.',
    })
  } catch (error) {
    safeLog.info(error)
    return res.status(500).json({ message: error.message })
  }
}

export default {
  insertMany,
  create,
  findAll,
  calculatePrice,
  itemPurchased,
  convertCsvToJson,
  uploadDocuments,
  getSubmitedData,
  getDocuments,
  questionnaireList,
  update,
  deleteById,
  calculatePriceWatch,
  customerDetail,
}
