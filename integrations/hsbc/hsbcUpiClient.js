import crypto from 'crypto'
import fs from 'fs'
import https from 'https'
import axios from 'axios'

const DEFAULT_BASE_URL = 'https://upiapi-uat.hsbc.co.in'
const DEFAULT_TIMEOUT_MS = 30000

export class HsbcUpiConfigurationError extends Error {}

export class HsbcUpiTransportError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'HsbcUpiTransportError'
    this.status = options.status
    this.code = options.code
    this.isTimeout = options.isTimeout || false
    this.responseData = options.responseData
    this.endpoint = options.endpoint
  }
}

const requiredConfig = (name, value) => {
  if (!value) {
    throw new HsbcUpiConfigurationError(`${name} is not configured`)
  }
  return value
}

const getConfig = () => ({
  merchantId: process.env.HSBC_UPI_MERCHANT_ID,
  merchantKey: process.env.HSBC_UPI_MERCHANT_KEY,
  baseUrl: process.env.HSBC_UPI_BASE_URL || DEFAULT_BASE_URL,
  validatePath:
    process.env.HSBC_UPI_VALIDATE_PATH || '/upi/api/v2/meValidateVPA',
  payPath:
    process.env.HSBC_UPI_PAY_PATH || '/upi/api/v2/mePayRefundApi',
  statusPaths: (
    process.env.HSBC_UPI_STATUS_PATHS ||
    '/upi/v2/mePayTransQuery,/upi/api/v2/mePayTransQuery'
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  timeoutMs: Number(process.env.HSBC_UPI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  encryptionMode: (process.env.HSBC_UPI_ENCRYPTION_MODE || 'UPIKIT').toUpperCase(),
  cipher: process.env.HSBC_UPI_CIPHER,
  keyEncoding: process.env.HSBC_UPI_KEY_ENCODING || 'hex',
  outputEncoding: process.env.HSBC_UPI_OUTPUT_ENCODING || 'hex',
  iv: process.env.HSBC_UPI_IV,
  caCertPath: process.env.HSBC_UPI_CA_CERT_PATH,
  clientCertPath: process.env.HSBC_UPI_CLIENT_CERT_PATH,
  clientKeyPath: process.env.HSBC_UPI_CLIENT_KEY_PATH,
  clientKeyPassphrase: process.env.HSBC_UPI_CLIENT_KEY_PASSPHRASE,
  clientPfxPath: process.env.HSBC_UPI_CLIENT_PFX_PATH,
  clientPfxPassphrase: process.env.HSBC_UPI_CLIENT_PFX_PASSPHRASE,
  mockMode: process.env.HSBC_UPI_MOCK_MODE === 'true',
})

const readOptionalFile = (filePath) =>
  filePath ? fs.readFileSync(filePath) : undefined

const createHttpsAgent = (config) => {
  if (config.clientPfxPath) {
    return new https.Agent({
      rejectUnauthorized: true,
      ca: readOptionalFile(config.caCertPath),
      pfx: readOptionalFile(config.clientPfxPath),
      passphrase: config.clientPfxPassphrase,
    })
  }

  return new https.Agent({
    rejectUnauthorized: true,
    ca: readOptionalFile(config.caCertPath),
    cert: readOptionalFile(config.clientCertPath),
    key: readOptionalFile(config.clientKeyPath),
    passphrase: config.clientKeyPassphrase,
  })
}

const normalizeKey = (merchantKey, encoding) => {
  const key = Buffer.from(merchantKey, encoding)
  if (![16, 24, 32].includes(key.length)) {
    throw new HsbcUpiConfigurationError(
      'HSBC_UPI_MERCHANT_KEY must resolve to 16, 24, or 32 bytes',
    )
  }
  return key
}

const resolveCipher = (config, key) => {
  if (config.cipher) {
    return config.cipher
  }
  return `aes-${key.length * 8}-ecb`
}

const encryptUpiKitMessage = (payload, config) => {
  const key = normalizeKey(
    requiredConfig('HSBC_UPI_MERCHANT_KEY', config.merchantKey),
    config.keyEncoding,
  )
  const cipherName = resolveCipher(config, key)
  const usesIv = !cipherName.toLowerCase().endsWith('-ecb')
  const iv = usesIv
    ? Buffer.from(requiredConfig('HSBC_UPI_IV', config.iv), 'hex')
    : null
  const cipher = crypto.createCipheriv(cipherName, key, iv)
  cipher.setAutoPadding(true)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ])
  return encrypted.toString(config.outputEncoding).toUpperCase()
}

const decryptUpiKitMessage = (encryptedMessage, config) => {
  const key = normalizeKey(
    requiredConfig('HSBC_UPI_MERCHANT_KEY', config.merchantKey),
    config.keyEncoding,
  )
  const cipherName = resolveCipher(config, key)
  const usesIv = !cipherName.toLowerCase().endsWith('-ecb')
  const iv = usesIv
    ? Buffer.from(requiredConfig('HSBC_UPI_IV', config.iv), 'hex')
    : null
  const decipher = crypto.createDecipheriv(cipherName, key, iv)
  decipher.setAutoPadding(true)
  const decrypted = Buffer.concat([
    decipher.update(
      Buffer.from(encryptedMessage, config.outputEncoding),
    ),
    decipher.final(),
  ]).toString('utf8')
  return JSON.parse(decrypted)
}

const encodeRequest = (payload, config) => {
  if (config.encryptionMode === 'PLAIN') {
    return payload
  }

  return {
    requestMsg: encryptUpiKitMessage(payload, config),
    pgMerchantId: requiredConfig(
      'HSBC_UPI_MERCHANT_ID',
      config.merchantId,
    ),
  }
}

const decodeResponse = (data, config) => {
  if (!data || typeof data !== 'object') {
    return data
  }

  if (config.encryptionMode === 'PLAIN') {
    return data.apiResp || data
  }

  const encrypted = data.response || data.responseMsg
  if (!encrypted) {
    return data.apiResp || data
  }
  return decryptUpiKitMessage(encrypted, config)
}

const post = async (path, payload, config) => {
  try {
    const response = await axios.post(
      `${config.baseUrl}${path}`,
      encodeRequest(payload, config),
      {
        timeout: config.timeoutMs,
        httpsAgent: createHttpsAgent(config),
        headers: { 'Content-Type': 'application/json' },
        validateStatus: (status) => status >= 200 && status < 300,
      },
    )
    return {
      data: decodeResponse(response.data, config),
      httpStatus: response.status,
    }
  } catch (error) {
    if (error instanceof HsbcUpiConfigurationError) {
      throw error
    }
    const endpointNotFound = error.response?.status === 404
    let message
    if (endpointNotFound) {
      message = 'HSBC UPI endpoint is not available'
    } else if (error.code === 'ECONNABORTED') {
      message = 'HSBC UPI request timed out'
    } else {
      message = 'HSBC UPI request failed'
    }
    throw new HsbcUpiTransportError(
      message,
      {
        status: error.response?.status,
        code: error.code,
        isTimeout: error.code === 'ECONNABORTED',
        responseData: error.response?.data,
        endpoint: path,
      },
    )
  }
}

const mockValidation = (vpa) => ({
  data: {
    payerVPA: vpa,
    payerName: 'UAT CUSTOMER',
    valStatusCode: 'VE',
    valStatusDesc: 'VPA Available',
    respVpa: vpa,
    ifsc: 'HSBD0400002',
  },
  httpStatus: 200,
})

const mockPayment = (payload) => ({
  data: {
    pgMerchantId: payload.pgMerchantId,
    refNo: String(Date.now()).slice(-6),
    paymentType: 'P',
    transAmount: payload.amount,
    respCode: '00',
    transStatus: 'S',
    transMessage: 'Transaction success',
    beneVPA: payload.beneVPA,
    newTransId: `MOCK${crypto.randomBytes(15).toString('hex').toUpperCase()}`,
    newTransRRN: String(Date.now()).slice(-12),
    newMeOrderNo: payload.meOrderNo,
  },
  httpStatus: 200,
})

export const validateVpa = async ({ vpa, reference }) => {
  const config = getConfig()
  const merchantId = requiredConfig(
    'HSBC_UPI_MERCHANT_ID',
    config.merchantId,
  )
  if (config.mockMode) {
    return mockValidation(vpa)
  }
  return post(
    config.validatePath,
    {
      payerVPA: vpa,
      pgMerchantID: merchantId,
      meRefNo: reference,
    },
    config,
  )
}

export const initiatePayout = async ({
  beneficiaryVpa,
  amount,
  merchantOrderNo,
  remarks,
}) => {
  const config = getConfig()
  const merchantId = requiredConfig(
    'HSBC_UPI_MERCHANT_ID',
    config.merchantId,
  )
  const payload = {
    pgMerchantId: merchantId,
    meAccNo: '',
    subMeCode: '',
    mcc: process.env.HSBC_UPI_MCC || '',
    amount: Number(amount).toFixed(2),
    currency: 'INR',
    beneAccNo: '',
    beneIfsc: '',
    beneVPA: beneficiaryVpa,
    beneAadhar: '',
    beneEmailID: '',
    beneMobNo: '',
    paymentType: 'P',
    orgTransRRN: '',
    orgTxnID: '',
    orgOrderNo: '',
    meOrderNo: merchantOrderNo,
    transRemarks: remarks.slice(0, 50),
    valueDate: '',
    batchID: '',
    consolidation: 'N',
    beneOrderPartyID: '',
    channel: 'U',
    addInfo1: '',
    addInfo2: '',
    addInfo3: '',
    addInfo4: '',
    addInfo5: '',
    addInfo6: '',
    addInfo7: '',
    addInfo8: '',
    addInfo9: '',
    addInfo10: '',
  }

  if (config.mockMode) {
    return mockPayment(payload)
  }
  return post(config.payPath, payload, config)
}

const statusPayloads = (merchantId, merchantOrderNo, reference, rrn) => [
  {
    pgMerchantId: merchantId,
    meRefNo: reference,
    transRRN: rrn || '',
    meOrderNo: merchantOrderNo,
    payChannel: 'U',
  },
  {
    pgMerchantId: merchantId,
    meRefNo: reference,
    transRRN: rrn || '',
    meOrderNo: merchantOrderNo,
    channel: 'U',
  },
]

export const enquirePayout = async ({
  merchantOrderNo,
  reference,
  rrn,
}) => {
  const config = getConfig()
  const merchantId = requiredConfig(
    'HSBC_UPI_MERCHANT_ID',
    config.merchantId,
  )

  if (config.mockMode) {
    return {
      data: {
        pgMerchantId: merchantId,
        paymentType: 'P',
        respCode: '00',
        transStatus: 'S',
        transMessage: 'Transaction success',
        newTransRRN: rrn || String(Date.now()).slice(-12),
        newMeOrderNo: merchantOrderNo,
      },
      httpStatus: 200,
    }
  }

  let lastError
  for (const path of config.statusPaths) {
    for (const payload of statusPayloads(
      merchantId,
      merchantOrderNo,
      reference,
      rrn,
    )) {
      try {
        return await post(path, payload, config)
      } catch (error) {
        lastError = error
        if (![400, 404].includes(error.status)) {
          throw error
        }
      }
    }
  }
  throw lastError
}

export const hsbcUpiClientConfigStatus = () => {
  const config = getConfig()
  const configured = Boolean(config.merchantId && config.merchantKey)
  const customerAppConfigured = Boolean(
    process.env.PAYOUT_CUSTOMER_APP_URL,
  )
  const notificationMode = (
    process.env.PAYOUT_LINK_NOTIFICATION_MODE ||
    process.env.PAYOUT_NOTIFICATION_MODE ||
    'EMAIL'
  ).toUpperCase()
  const successNotificationMode = (
    process.env.PAYOUT_SUCCESS_NOTIFICATION_MODE ||
    process.env.PAYOUT_NOTIFICATION_MODE ||
    'EMAIL'
  ).toUpperCase()
  const emailConfigured = Boolean(process.env.MAIL && process.env.MAIL_PASS)
  const emailNotificationConfigured = Boolean(
    emailConfigured && process.env.PAYOUT_NOTIFICATION_EMAIL,
  )
  const linkNotificationConfigured =
    notificationMode === 'SMS'
      ? Boolean(
          process.env.MSG91_AUTHKEY &&
            process.env.MSG91_PAYOUT_LINK_TEMPLATE_ID,
        )
      : emailNotificationConfigured
  const successNotificationConfigured =
    successNotificationMode === 'SMS'
      ? Boolean(
          process.env.MSG91_AUTHKEY &&
            process.env.MSG91_PAYOUT_SUCCESS_TEMPLATE_ID,
        )
      : emailNotificationConfigured
  const developmentOverrideEnabled =
    process.env.PAYOUT_FORCE_HSBC_IN_DEVELOPMENT === 'true'
  return {
    configured,
    baseUrl: config.baseUrl,
    encryptionMode: config.encryptionMode,
    mockMode: config.mockMode,
    customerAppConfigured,
    notificationMode,
    successNotificationMode,
    emailNotificationConfigured,
    linkNotificationConfigured,
    successNotificationConfigured,
    reconciliationEnabled:
      process.env.HSBC_PAYOUT_RECONCILIATION_ENABLED !== 'false',
    developmentOverrideEnabled,
    uatReady:
      configured &&
      customerAppConfigured &&
      linkNotificationConfigured &&
      successNotificationConfigured &&
      !config.mockMode &&
      !developmentOverrideEnabled,
  }
}
