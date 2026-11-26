import axios from 'axios'
import jwt from 'jsonwebtoken'
import { XMLParser } from 'fast-xml-parser'

// Decodes the base64 Aadhaar XML returned by download_xml into a parsed object.
// Returns { xml, rawXml } where `xml` is the parsed structure and `rawXml` is the
// decoded XML string. Throws if decoding fails.
const decodeAadhaarXml = (base64) => {
  const buf = Buffer.from(base64, 'base64')
  const rawXml = buf.toString('utf8')

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
  })
  const xml = parser.parse(rawXml)
  return { xml, rawXml }
}

// Returns `obj[key]` when present, otherwise `null`.
const pickXmlAttr = (obj, key) => obj?.[key] ?? null

// Extracts the human-readable KYC fields (name, dob, gender, masked aadhaar, address)
// from the parsed Aadhaar XML certificate.
const extractAadhaarKyc = (xml) => {
  const cert = xml?.Certificate
  const uiddata = cert?.CertificateData?.KycRes?.UidData

  const poi = uiddata?.Poi || {}
  const poa = uiddata?.Poa || {}
  const photoB64 = uiddata?.Pht || ''

  return {
    name: pickXmlAttr(poi, '@_name'),
    dob: pickXmlAttr(poi, '@_dob'),
    gender: pickXmlAttr(poi, '@_gender'),
    aadhaarNumber: pickXmlAttr(uiddata, '@_uid'),
    mobile: pickXmlAttr(uiddata, '@_tkn'),
    address: {
      careOf: pickXmlAttr(poa, '@_co'),
      country: pickXmlAttr(poa, '@_country'),
      district: pickXmlAttr(poa, '@_dist'),
      landmark: pickXmlAttr(poa, '@_lm'),
      pinCode: pickXmlAttr(poa, '@_pc'),
      state: pickXmlAttr(poa, '@_state'),
      street: pickXmlAttr(poa, '@_street'),
      subDistrict: pickXmlAttr(poa, '@_subdist'),
      vtc: pickXmlAttr(poa, '@_vtc'),
    },
    hasPhoto: !!photoB64,
    photo: photoB64,
  }
}

const WRAPPER_BASE_URL = 'https://business.grest.in/api/v1/wrapper/digilocker'

const MSG_FETCH_ISSUED_FILES = 'Failed to fetch Aadhaar issued files'


const CLOCK_SKEW_BUFFER_SECONDS = 30

export const generateAadhaarToken = () => {
  const partnerId = process.env.ADHAAR_DIGILOCKER_SPRINTVERIFY_PARTNER_ID
  const seed =
    process.env.ADHAAR_DIGILOCKER_SPRINTVERIFY_JWT_KEY ||
    process.env.ADHAAR_DIGILOCKER_SPRINTVERIFY_AUTHORISED_KEY

  const timestamp =
    Math.floor(Date.now() / 1000) + CLOCK_SKEW_BUFFER_SECONDS
  const reqid = `REQ${timestamp}${Math.floor(Math.random() * 1e6)}`

  const payload = {
    timestamp,
    partnerId,
    reqid,
  }

  const token = jwt.sign(payload, seed, {
    algorithm: 'HS256',
  })

  return { token, partnerId, expiresIn: 300 }
}

const isHtmlBody = (body) =>
  typeof body === 'string' && /^\s*</.test(body)

const makeSprintRequest = async (endpoint, fields) => {
  const fullUrl = `${WRAPPER_BASE_URL}/${endpoint}`

  // Fresh token per request, valid 5 minutes.
  const { token, partnerId } = generateAadhaarToken()

  const jsonBody = {
    ...fields,
    token,
    user_agent: partnerId,
  }

  try {
    // Accept all HTTP statuses so we can surface wrapper / WAF errors
    // (502, etc.) instead of falling into a generic 500 on the client.
    const response = await axios.post(fullUrl, jsonBody, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 60000,
      validateStatus: (status) => status >= 200 && status < 600,
    })

    return {
      status: response.status,
      data: response.data,
      rawStatus: response.status,
      isHtml: isHtmlBody(response.data),
    }
  } catch (error) {
    if (error.response) {
      return {
        status: error.response.status,
        data: error.response.data,
        rawStatus: error.response.status,
        isHtml: isHtmlBody(error.response.data),
      }
    }
    throw error
  }
}

const handleSuccess = (res, data) =>
  res.status(200).json({ success: true, data })

const handleFailure = (res, statusCode, message, data) =>
  res.status(statusCode).json({ success: false, message, data })

const handleCatchError = (error, res, fallbackMessage) => {
  const status = error.response?.status || 500
  const responseData = error.response?.data || {}
  const message = responseData.message || error.message || fallbackMessage

  if (status === 401 || message.toLowerCase().includes('jwt')) {
    return res.status(401).json({
      success: false,
      message: 'Authentication failed: Invalid or expired JWT token',
      error: responseData,
    })
  }

  if (message.toLowerCase().includes('authorisedkey')) {
    return res.status(401).json({
      success: false,
      message: 'Authentication failed: Invalid Authorisedkey',
      error: responseData,
    })
  }

  return res.status(status).json({
    success: false,
    message,
    error: responseData,
  })
}

const validateRequired = (fields, res) => {
  const missing = Object.entries(fields)
    .filter(([, value]) => !value)
    .map(([key]) => key)

  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Missing required fields: ${missing.join(', ')}`,
    })
  }
  return null
}

const handleHtmlBodyResponse = (res, httpStatus, body) => {
  const raw = typeof body === 'string' ? body.slice(0, 200) : String(httpStatus)
  let message
  if (httpStatus >= 500) {
    message = `DigiLocker wrapper server error (${httpStatus}). Please retry.`
  } else {
    message = `Unexpected response from DigiLocker wrapper (HTTP ${httpStatus}).`
  }
  return handleFailure(res, httpStatus || 502, message, {
    raw_response: raw,
    status: httpStatus,
  })
}

// HTTP 502 + providerStatus: 201 => refid not usable / awaiting consent,
// 422 => provider rejected request, 5xx => provider-side failure.
const buildWrapperFailure = (body, httpStatus, successMessage) => {
  const { providerStatus, providerMessage } = body
  let message = providerMessage || successMessage
  let statusCode = httpStatus || 502

  if (providerStatus === 201) {
    message = message || 'DigiLocker session not found. Please start a new verification.'
    statusCode = 201
  } else if (providerStatus === 422) {
    message = message || 'DigiLocker provider rejected the request.'
    statusCode = 422
  } else if (typeof providerStatus === 'number' && providerStatus >= 500) {
    message = message || 'DigiLocker provider is temporarily unavailable. Please retry.'
    statusCode = 502
  }

  return { message, statusCode }
}

const handleApiResponse = (response, res, successMessage, mapData) => {
  // `response` is the normalized object returned by makeSprintRequest
  // (status/data/rawStatus/isHtml).
  const httpStatus = response.status ?? response.rawStatus
  const body = response.data

  // The DigiLocker wrapper returns an HTML/error page for some failures.
  if (response.isHtml || typeof body !== 'object' || body === null) {
    return handleHtmlBodyResponse(res, httpStatus, body)
  }

  // HTTP 200 = billed-and-successful call.
  if (httpStatus === 200) {
    const data = typeof mapData === 'function' ? mapData(body) : (body.data || body)
    return handleSuccess(res, data)
  }

  const { message, statusCode } = buildWrapperFailure(body, httpStatus, successMessage)
  return handleFailure(res, statusCode, message, body.data || body)
}

export const initiateAadhaarSession = async (req, res) => {
  try {
    const { refid, redirect_url } = req.body

    const validationError = validateRequired({ refid, redirect_url }, res)
    if (validationError) {
      return validationError
    }

    const response = await makeSprintRequest('initiate', {
      refid,
      redirect_url,
    })

    return handleApiResponse(response, res, 'Failed to initiate Aadhaar DigiLocker session', (body) => {
      // Wrapper returns `authorizationUrl`; frontend expects `authorization_url`.
      const data = body.data || body
      return {
        ...data,
        authorization_url: data.authorization_url || data.authorizationUrl,
      }
    })
  } catch (error) {
    return handleCatchError(error, res, 'Failed to initiate Aadhaar DigiLocker session')
  }
}

export const getAadhaarAccessToken = async (req, res) => {
  try {
    const { refid } = req.body

    const validationError = validateRequired({ refid }, res)
    if (validationError) {
      return validationError
    }

    const response = await makeSprintRequest('access-token', {
      refid,
    })

    return handleApiResponse(response, res, 'User authentication incomplete. Please complete DigiLocker login.')
  } catch (error) {
    return handleCatchError(error, res, 'Failed to generate Aadhaar access token')
  }
}

export const getAadhaarIssuedFiles = async (req, res) => {
  try {
    const { refid } = req.body

    const validationError = validateRequired({ refid }, res)
    if (validationError) {
      return validationError
    }

    const response = await makeSprintRequest('issued-files', {
      refid,
    })

    return handleApiResponse(response, res, MSG_FETCH_ISSUED_FILES, (body) => {
      // Frontend expects `data` to be the array of issued documents.
      const data = body.data ?? body
      return Array.isArray(data) ? data : (data?.issuedFiles || data?.files || data)
    })
  } catch (error) {
    return handleCatchError(error, res, MSG_FETCH_ISSUED_FILES)
  }
}

export const downloadAadhaarXml = async (req, res) => {
  try {
    const { refid, uri } = req.body

    const validationError = validateRequired({ refid, uri }, res)
    if (validationError) {
      return validationError
    }

    const response = await makeSprintRequest('download-xml', {
      refid,
      uri,
    })

    return handleApiResponse(response, res, 'Failed to download Aadhaar XML document', (body) => {
      const data = body.data ?? body
      // The wrapper returns the document as `base64Xml`.
      const base64Xml = data.base64Xml || data.base64_xml || data.xml_data || data
      const { xml } = decodeAadhaarXml(base64Xml)
      const kyc = extractAadhaarKyc(xml)
      return {
        message: data.message,
        name: kyc.name,
        dob: kyc.dob,
        gender: kyc.gender,
        aadhaarNumber: kyc.aadhaarNumber,
        address: kyc.address,
        photo: kyc.photo,
      }
    })
  } catch (error) {
    return handleCatchError(error, res, 'Failed to download Aadhaar XML document')
  }
}

const getStatusCode = (response) =>
  response.data?.providerStatus === 422 ? 422 : (response.status || 400)

const getFailureMessage = (response, fallback) =>
  response.data?.providerMessage ||
  response.data?.message ||
  fallback

// STEP 1: generate the DigiLocker access token.
// Returns { error } where `error` is null on success.
const stepAccessToken = async (refid) => {
  const tokenResponse = await makeSprintRequest('access-token', { refid })

  if (tokenResponse.status !== 200) {
    const message = tokenResponse.data?.providerStatus === 422
      ? 'User authentication incomplete. Please complete DigiLocker login first.'
      : getFailureMessage(tokenResponse, 'Aadhaar access token generation failed')
    return { error: { status: getStatusCode(tokenResponse), message } }
  }
  return { error: null }
}

// STEP 2: fetch the issued files and the matching Aadhaar document.
// Returns { error, doc } where `error` is null on success.
const stepIssuedFiles = async (refid) => {
  const filesResponse = await makeSprintRequest('issued-files', { refid })

  if (filesResponse.status !== 200) {
    return {
      error: {
        status: getStatusCode(filesResponse),
        message: getFailureMessage(filesResponse, MSG_FETCH_ISSUED_FILES),
      },
    }
  }

  const filesData = filesResponse.data?.data ?? filesResponse.data
  const issuedFiles = Array.isArray(filesData)
    ? filesData
    : (filesData?.issuedFiles || filesData?.files || [])

  const aadhaarDoc = issuedFiles?.find(
    (doc) => doc.doctype === 'ADHAR' || doc.name?.toLowerCase().includes('aadhaar'),
  )

  if (!aadhaarDoc) {
    return { error: { status: 404, message: 'Aadhaar document not found in DigiLocker' } }
  }
  return { error: null, doc: aadhaarDoc }
}

const getBase64Xml = (downloadResponse) => {
  const downloadData = downloadResponse.data?.data ?? downloadResponse.data
  return downloadData?.base64Xml || downloadData?.base64_xml || downloadData
}

const decodeDocument = (base64Xml) => {
  const decoded = decodeAadhaarXml(base64Xml)
  return {
    xml: decoded.rawXml,
    kyc: extractAadhaarKyc(decoded.xml),
  }
}

export const verifyAadhaarViaDigiLocker = async (req, res) => {
  try {
    const { refid, uri } = req.body

    const validationError = validateRequired({ refid, uri }, res)
    if (validationError) {
      return validationError
    }

    // STEP 1: access-token
    const { error: accessTokenError } = await stepAccessToken(refid)
    if (accessTokenError) {
      return handleFailure(res, accessTokenError.status, accessTokenError.message)
    }

    // STEP 2: issued-files
    const { error: issuedFilesError, doc: aadhaarDoc } = await stepIssuedFiles(refid)
    if (issuedFilesError) {
      return handleFailure(res, issuedFilesError.status, issuedFilesError.message)
    }

    // STEP 3: download-xml
    const downloadResponse = await makeSprintRequest('download-xml', {
      refid,
      uri: aadhaarDoc.uri,
    })
    const base64Xml = getBase64Xml(downloadResponse)

    if (downloadResponse.status !== 200) {
      return handleFailure(
        res,
        getStatusCode(downloadResponse),
        getFailureMessage(downloadResponse, 'Failed to download Aadhaar document'),
      )
    }

    let xml, kyc
    try {
      const decoded = decodeDocument(base64Xml)
      xml = decoded.xml
      kyc = decoded.kyc
    } catch (decodeErr) {
      return handleCatchError(decodeErr, res, 'Failed to decode Aadhaar XML document')
    }

    return handleSuccess(res, {
      verified: true,
      document_type: aadhaarDoc.doctype,
      document_name: aadhaarDoc.name,
      issuer: aadhaarDoc.issuer,
      xml_data: base64Xml,
      xml,
      kyc,
    })
  } catch (error) {
    return handleCatchError(error, res, 'Aadhaar verification via DigiLocker failed')
  }
}
