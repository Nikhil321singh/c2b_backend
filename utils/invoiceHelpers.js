import fs from 'fs'
import os from 'os'
import axios from 'axios'
import FormData from 'form-data'
import path from 'path'
import AWS from 'aws-sdk'
import transporter from './transporter.js'
import {
  maskPhoneNumber,
  maskEmail,
  prepareRAMStorageLabel,
  getFormattedDate,
  fillTemplate,
} from './questionnaireUtils.js'
import { tncContent } from './termsAndConditions.js'
import { safeLog } from './piiMasking.js'

// Initialize S3
const s3 = new AWS.S3({
  region: process.env.S3_REGION,
  accessKeyId: process.env.S3_ACCESS_KEY,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
})

// Constants
const PDF_CONTENT_TYPE = 'application/pdf'
const PDF_SIGNATURE = Buffer.from('%PDF-')
const EMAIL_DISCLAIMER = 'Note: Please do not reply to this email. Replies to this message are not monitored.'

/**
 * Generate invoice HTML from template with dynamic data
 * @param {string} template - HTML template string
 * @param {Object} lead - Lead object with all details
 * @param {Object} reqBody - Request body
 * @param {Object} options - Options for invoice generation
 * @returns {string} - Generated HTML
 */
function calcTotalPrice(lead) {
  return Math.floor(lead.price + (lead.bonusPrice || 0) + (lead.negotiatedAmount || 0) + (lead.couponDiscount || 0))
}

// Hardcoded to match the frontend PurchaseReceipt CompanyHeader
const COMPANY_NAME = 'Radical Aftermarket Services Pvt. Ltd'
const COMPANY_GSTIN = '06AAJCR2110E1ZX'
const COMPANY_ADDRESS = 'Khasra No. 34/22, 1st Floor, NK Tower, Kanhai Road, Sector-45, Gurugram, Haryana - 122003'

export const generateInvoiceHtml = (
  template,
  lead,
  reqBody,
  { showPrice, maskInfo, signatureBase64 = null, showBonusOffer = false } = {},
) => {
  const bonusOfferHtml = showBonusOffer
    ? `
      <div style="text-align: center; margin: 20px 0">
        <h2
          style="
            font-style: italic;
            color: #000;
            padding-top: 10px;
            font-weight: bold;
          "
        >
          "This Trade-In value is inclusive of all bonus offers."
        </h2>
      </div>
    `
    : ''

  const totalPrice = showPrice ? calcTotalPrice(lead) : undefined

  // Payout transaction details (mode/reference/date/status). Present only for
  // receipts generated after an HSBC payout; empty for other receipts.
  const paymentDetailsSection = [
    ['Payment Mode', reqBody?.paymentMode],
    ['Payment Reference', reqBody?.paymentReference],
    [
      'Payment Date',
      reqBody?.paidAt ? getFormattedDate(reqBody.paidAt) : reqBody?.paymentDate,
    ],
    ['Payment Status', reqBody?.paymentStatus],
  ]
    .filter(([, value]) => value)
    .map(
      ([label, value]) =>
        `<p><span class="font-bold"> ${label}:</span> ${value}</p>`,
    )
    .join('')

  const data = {
    name: lead.name,
    email: lead.emailId,
    model: lead.modelId.name,
    bonusPrice: lead.bonusPrice,
    phoneName: lead.modelId.name,
    RAM: lead.ram,
    storage: lead.storage,
    imeiNumber: lead.documentId?.IMEI || '',
    LaptopimeiNumber: lead.documentId?.SerialNumber || '',
    maskedPhoneNumber: maskPhoneNumber(lead.phoneNumber, maskInfo),
    maskedEmail: maskEmail(lead.emailId, maskInfo),
    aadharNumber: lead.aadharNumber,
    uniqueCode: lead.uniqueCode,
    formattedDate: getFormattedDate(lead.updatedAt),
    storeName: lead?.store?.storeName || '',
    address: lead?.store?.address || '',
    websiteShortName: process.env.SHORT_NAME,
    companyName: COMPANY_NAME,
    priceHeader: showPrice
      ? '<th style="width: 25%; text-align: left">PRICE</th>'
      : '',
    priceCell: showPrice ? `<td>Rs. ${totalPrice}/-</td>` : '',
    itemWidth: showPrice ? 'width: 65%;' : 'width: 90%;',
    price: totalPrice,
    companyGstin: COMPANY_GSTIN,
    companyAddress: COMPANY_ADDRESS,
    companyContact: process.env.COMPANY_CONTACT,
    companyEmail: process.env.SUPPORT_EMAIL,
    logoUrl: process.env.LOGO_URL,
    courtJurisdiction: process.env.COURT_JURISDICTION,
    RAMStorage: prepareRAMStorageLabel(lead.ram, lead.storage),
    termsAndConditions: tncContent.html,
    signatureBase64: signatureBase64 || '',
    signatureDisplay: signatureBase64 ? 'block' : 'none',
    bonusOfferSection: bonusOfferHtml,
    paymentDetailsSection,
  }
  return fillTemplate(template, data)
}

/**
 * Create PDF buffer from HTML content
 * @param {string} htmlContent - HTML content to convert to PDF
 * @returns {Promise<Buffer>} - PDF buffer
 */
export const createPdfBuffer = async (htmlContent) => {
  const tempHtmlPath = path.join(
    os.tmpdir(),
    `temp_invoice_${process.pid}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}.html`,
  )
  fs.writeFileSync(tempHtmlPath, htmlContent)

  try {
    const form = new FormData()
    form.append('file', fs.createReadStream(tempHtmlPath), 'file.html')

    const { data: base64Data } = await axios.post(process.env.PDF_URI, form, {
      headers: form.getHeaders(),
    })

    if (!base64Data) {
      throw new Error('No PDF data in response')
    }

    return Buffer.from(base64Data, 'base64')
  } finally {
    if (fs.existsSync(tempHtmlPath)) {
      fs.unlinkSync(tempHtmlPath)
    }
  }
}

/**
 * Upload PDF to S3
 * @param {Buffer} pdfBuffer - PDF buffer
 * @param {string} uniqueCode - Unique code for filename
 * @returns {Promise<string>} - S3 URL
 */
export const uploadPdfToS3 = async (pdfBuffer, uniqueCode) => {
  const receiptName = `receipt-${uniqueCode}-${Date.now()}.pdf`
  const uploadParams = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: `${process.env.S3_FOLDER || 'receipts'}/${receiptName}`,
    Body: pdfBuffer,
    ContentType: PDF_CONTENT_TYPE,
  }

  const uploadResult = await s3.upload(uploadParams).promise()
  return uploadResult.Location
}

/**
 * Normalize the label formats returned by courier APIs and reject corrupt
 * content before it is stored with a PDF content type.
 * @param {Buffer|string|number[]} label - PDF buffer, base64 string, or byte array
 * @returns {Buffer} - Valid PDF bytes
 */
export const normalizeShippingLabelPdf = (label) => {
  let body
  if (Buffer.isBuffer(label)) {
    body = label
  } else if (
    Array.isArray(label) &&
    label.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    body = Buffer.from(label)
  } else if (typeof label === 'string') {
    const base64 = label
      .trim()
      .replace(/^data:application\/pdf;base64,/i, '')
    body = Buffer.from(base64, 'base64')
  } else {
    throw new Error('Shipping label has an unsupported format')
  }

  if (
    body.length < PDF_SIGNATURE.length ||
    !body.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)
  ) {
    throw new Error('Shipping label is not a valid PDF')
  }
  return body
}

/**
 * Store a courier shipping label PDF in S3. Couriers return the label as base64
 * or a byte array in the waybill response, which is too large to keep on the
 * shipment document.
 * @param {Buffer|string|number[]} label - Label content returned by the courier
 * @param {string} awbNo - Waybill number used in the object key
 * @returns {Promise<{key: string, url: string}>} - The uploaded label's key and URL
 */
export const uploadShippingLabelToS3 = async (label, awbNo) => {
  const body = normalizeShippingLabelPdf(label)
  const uploadParams = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: `${process.env.S3_LABEL_FOLDER || 'shipping-labels'}/label-${awbNo}-${Date.now()}.pdf`,
    Body: body,
    ContentType: PDF_CONTENT_TYPE,
  }

  const uploadResult = await s3.upload(uploadParams).promise()
  return { key: uploadResult.Key || uploadParams.Key, url: uploadResult.Location }
}

/**
 * Short-lived download link for a stored shipping label, so labels can be
 * re-printed whether or not the bucket is public.
 * @param {string} key - S3 object key of the label
 * @param {number} expiresInSeconds - Link lifetime
 * @returns {string} - Signed GET URL
 */
export const getShippingLabelSignedUrl = (key, expiresInSeconds = 300) =>
  s3.getSignedUrl('getObject', {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Expires: expiresInSeconds,
  })

/**
 * Fetch signature from S3 and convert to base64
 * @param {string} signatureUrl - The S3 URL of the signature
 * @returns {Promise<string|null>} - Base64 data URL or null if failed
 */
export const getSignatureBase64 = async (signatureUrl) => {
  if (!signatureUrl) {
    return null
  }

  try {
    const bucketName = process.env.S3_BUCKET_NAME
    const urlObj = new URL(signatureUrl)
    const key = decodeURIComponent(urlObj.pathname.substring(1))

    const params = {
      Bucket: bucketName,
      Key: key,
    }

    const data = await s3.getObject(params).promise()
    const base64Image = data.Body.toString('base64')
    const contentType = data.ContentType || 'image/png'
    return `data:${contentType};base64,${base64Image}`
  } catch (error) {
    safeLog.error('Error fetching signature from S3:', error)
    return null
  }
}

/**
 * Send confirmation email with PDF attachment
 * @param {Object} lead - Lead object with customer details
 * @param {Buffer} pdfBuffer - PDF buffer to attach
 * @returns {Promise<void>}
 */
export const sendConfirmationEmail = async (lead, pdfBuffer) => {
  try {
    if (!lead?.emailId) {
      throw new Error('Lead email address is required')
    }
    if (!lead?.name) {
      throw new Error('Lead name is required')
    }
    if (!lead?.modelId?.name) {
      throw new Error('Lead model information is required')
    }
    if (!pdfBuffer) {
      throw new Error('PDF buffer is required')
    }

    const mailOptions = {
      from: process.env.MAIL,
      to: lead.emailId,
      subject: 'Your Purchase Confirmation',
      html: `
        <p>Dear ${lead.name},</p>
        <p>Thank you for selling your device to <strong>${process.env.APP_NAME}</strong>.</p>
        <p>Your purchase receipt is attached to this email for your reference.</p>
        <p>Product: <strong>${lead.modelId.name}</strong></p>
        <p>For any queries, feel free to contact our support team at ${process.env.SUPPORT_EMAIL} / ${process.env.CONTACT_NUM}</p>
        <p style="font-size:12px; color:#666; margin-top:12px;">
          ${EMAIL_DISCLAIMER}
        </p>
        <br/>
        <p>Best Regards,</p>
        <p><strong>${process.env.APP_NAME}</strong></p>
        <p><a href="${process.env.DOMAIN}">Visit Our Website</a></p>
      `,
      attachments: [
        {
          filename: 'receipt.pdf',
          content: pdfBuffer,
          contentType: PDF_CONTENT_TYPE,
        },
      ],
    }

    safeLog.info('Sending email with options:', {
      from: mailOptions.from,
      to: mailOptions.to,
      subject: mailOptions.subject,
    })

    const info = await transporter.sendMail(mailOptions)
    safeLog.info('Email sent successfully:', { messageId: info.messageId })
    return info
  } catch (error) {
    safeLog.error('Error in sendConfirmationEmail:', {
      error: error.message,
      stack: error.stack,
      emailId: lead?.emailId,
    })
    throw error
  }
}

export const sendStoreInvoiceEmail = async (store, lead, pdfBuffer) => {
  try {
    if (!store?.email) {
      throw new Error('Store email address is required')
    }
    if (!store?.storeName) {
      throw new Error('Store name is required')
    }
    if (!lead?.modelId?.name) {
      throw new Error('Lead model information is required')
    }
    if (!pdfBuffer) {
      throw new Error('PDF buffer is required')
    }

    const finalPrice = lead.price + (lead.bonusPrice || 0) + (lead.negotiatedAmount || 0) + (lead.couponDiscount || 0)

    const mailOptions = {
      from: process.env.MAIL,
      to: store.email,
      subject: `Store Invoice - ${store.storeName}`,
      html: `
        <p>Dear ${store.storeName} Team,</p>
        <p>A new device purchase has been completed at your store.</p>
        <p><strong>Product:</strong> ${lead.modelId.name}</p>
        <p><strong>Final Price:</strong> Rs. ${finalPrice}</p>
        <p>The invoice is attached to this email for your reference.</p>
        <p>For any queries, feel free to contact our support team at ${process.env.SUPPORT_EMAIL} / ${process.env.CONTACT_NUM}</p>
        <p style="font-size:12px; color:#666; margin-top:12px;">
          ${EMAIL_DISCLAIMER}
        </p>
        <br/>
        <p>Best Regards,</p>
        <p><strong>${process.env.APP_NAME}</strong></p>
        <p><a href="${process.env.DOMAIN}">Visit Our Website</a></p>
      `,
      attachments: [
        {
          filename: 'store_invoice.pdf',
          content: pdfBuffer,
          contentType: PDF_CONTENT_TYPE,
        },
      ],
    }

    safeLog.info('Sending store invoice email to:', store.email)

    const info = await transporter.sendMail(mailOptions)
    safeLog.info('Store invoice email sent successfully:', { messageId: info.messageId })
    return info
  } catch (error) {
    safeLog.error('Error in sendStoreInvoiceEmail:', {
      error: error.message,
      stack: error.stack,
      storeEmail: store?.email,
    })
    throw error
  }
}

export default {
  generateInvoiceHtml,
  createPdfBuffer,
  uploadPdfToS3,
  getSignatureBase64,
  sendConfirmationEmail,
  sendStoreInvoiceEmail,
}
