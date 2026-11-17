import {
  maskAadhaar,
  maskPhone,
  maskEmail,
  maskIMEI,
  maskPAN,
  maskGST,
  maskName,
  maskAddress,
} from '../utils/piiMasking.js'
import { ROLES } from './rbac.js'
import mongoose from 'mongoose'

const ROLE_PERMISSIONS = {
  [ROLES.SUPER_ADMIN]: {
    canViewFullAadhaar: true,
    canViewFullPhone: true,
    canViewFullEmail: true,
    canViewFullIMEI: true,
    canViewFullPAN: true,
    canViewFullGST: true,
    canViewFullName: true,
    canViewFullAddress: true,
    canViewAadhaarDocuments: true,
    canViewPANDocuments: true,
  },
  [ROLES.ADMIN_MANAGER]: {
    canViewFullAadhaar: true,
    canViewFullPhone: true,
    canViewFullEmail: true,
    canViewFullIMEI: true,
    canViewFullPAN: true,
    canViewFullGST: true,
    canViewFullName: true,
    canViewFullAddress: true,
    canViewAadhaarDocuments: true,
    canViewPANDocuments: true,
  },
  [ROLES.COMPANY_ADMIN]: {
    canViewFullAadhaar: true,
    canViewFullPhone: true,
    canViewFullEmail: true,
    canViewFullIMEI: true,
    canViewFullPAN: true,
    canViewFullGST: true,
    canViewFullName: true,
    canViewFullAddress: true,
    canViewAadhaarDocuments: true,
    canViewPANDocuments: true,
  },
  [ROLES.TECHNICIAN]: {
    canViewFullAadhaar: true,
    canViewFullPhone: true,
    canViewFullEmail: true,
    canViewFullIMEI: true,
    canViewFullPAN: true,
    canViewFullGST: true,
    canViewFullName: true,
    canViewFullAddress: true,
    canViewAadhaarDocuments: true,
    canViewPANDocuments: true,
  },
  [ROLES.SALES]: {
    canViewFullAadhaar: true,
    canViewFullPhone: true,
    canViewFullEmail: true,
    canViewFullIMEI: true,
    canViewFullPAN: true,
    canViewFullGST: true,
    canViewFullName: true,
    canViewFullAddress: true,
    canViewAadhaarDocuments: true,
    canViewPANDocuments: true,
  },
}

const FIELD_MASK_RULES = {
  aadharnumber: { permission: 'canViewFullAadhaar', mask: maskAadhaar },
  aadhaar: { permission: 'canViewFullAadhaar', mask: maskAadhaar },
  aadhar: { permission: 'canViewFullAadhaar', mask: maskAadhaar },

  phonenumber: { permission: 'canViewFullPhone', mask: maskPhone },
  phone: { permission: 'canViewFullPhone', mask: maskPhone },
  mobile: { permission: 'canViewFullPhone', mask: maskPhone },
  mobilenumber: { permission: 'canViewFullPhone', mask: maskPhone },
  contactnumber: { permission: 'canViewFullPhone', mask: maskPhone },

  email: { permission: 'canViewFullEmail', mask: maskEmail },
  emailid: { permission: 'canViewFullEmail', mask: maskEmail },
  emailaddress: { permission: 'canViewFullEmail', mask: maskEmail },

  imei: { permission: 'canViewFullIMEI', mask: maskIMEI },

  pannumber: { permission: 'canViewFullPAN', mask: maskPAN },
  pan: { permission: 'canViewFullPAN', mask: maskPAN },

  gstnumber: { permission: 'canViewFullGST', mask: maskGST },
  gst: { permission: 'canViewFullGST', mask: maskGST },
  gstin: { permission: 'canViewFullGST', mask: maskGST },

  name: { permission: 'canViewFullName', mask: maskName },
  fullname: { permission: 'canViewFullName', mask: maskName },
  customername: { permission: 'canViewFullName', mask: maskName },

  address: { permission: 'canViewFullAddress', mask: maskAddress },
  fulladdress: { permission: 'canViewFullAddress', mask: maskAddress },
}

const getUserPermissions = (user) => {
  if (!user || !user.role) {
    // Default to most restrictive permissions if role not found
    return ROLE_PERMISSIONS[ROLES.SALES]
  }

  return ROLE_PERMISSIONS[user.role] || ROLE_PERMISSIONS[ROLES.SALES]
}

/**
 * Apply field-level masking to a single object based on user permissions
 *
 * @param {object} obj - Object to mask
 * @param {object} permissions - User's permissions
 * @param {Set} visited - Set of visited objects to prevent circular references
 * @returns {object} Masked object
 */

const isPlainObject = (val) =>
  Object.prototype.toString.call(val) === '[object Object]'

const maskObjectFields = (obj, permissions, visited = new Set()) => {
  if (obj === null || obj === undefined) {
    return obj
  }
  if (typeof obj !== 'object') {
    return obj
  }

  if (obj instanceof Date) {
    return obj
  }
  if (obj instanceof mongoose.Types.ObjectId) {
    return obj.toString()
  }
  if (Buffer.isBuffer(obj)) {
    return obj
  }

  if (visited.has(obj)) {
    return obj
  }
  visited.add(obj)

  if (Array.isArray(obj)) {
    return obj.map((item) => maskObjectFields(item, permissions, visited))
  }

  if (!isPlainObject(obj)) {
    return obj
  }

  const masked = { ...obj }

  for (const key of Object.keys(masked)) {
    const value = masked[key]

    // recursion first
    masked[key] = maskObjectFields(value, permissions, visited)

    const rule = FIELD_MASK_RULES[key.toLowerCase()]

    if (rule && !permissions[rule.permission]) {
      masked[key] = rule.mask(value)
    }
  }

  return masked
}

export const applyFieldLevelAccess = (req, res, next) => {
  // Store the original json method
  const originalJson = res.json.bind(res)

  // Override res.json to apply field-level masking
  res.json = async function (data) {
    // If data is a Promise (from async middleware), await it first
    const resolvedData = data instanceof Promise ? await data : data

    // Get user permissions
    const permissions = getUserPermissions(req.user)

    // Apply masking to response data
    const maskedData = maskObjectFields(resolvedData, permissions)

    // Call original json method with masked data
    return originalJson(maskedData)
  }

  next()
}

export const createAccessControl = (customPermissions = {}) => {
  return (req, res, next) => {
    const originalJson = res.json.bind(res)

    res.json = function (data) {
      // Merge user permissions with custom overrides
      const userPermissions = getUserPermissions(req.user)
      const permissions = { ...userPermissions, ...customPermissions }

      const maskedData = maskObjectFields(data, permissions)
      return originalJson(maskedData)
    }

    next()
  }
}

export const canViewField = (user, field) => {
  const permissions = getUserPermissions(user)

  const fieldPermissionMap = {
    aadhaar: 'canViewFullAadhaar',
    aadhar: 'canViewFullAadhaar',
    aadhaarNumber: 'canViewFullAadhaar',
    phone: 'canViewFullPhone',
    phoneNumber: 'canViewFullPhone',
    mobile: 'canViewFullPhone',
    email: 'canViewFullEmail',
    imei: 'canViewFullIMEI',
    pan: 'canViewFullPAN',
    panNumber: 'canViewFullPAN',
    gst: 'canViewFullGST',
    gstNumber: 'canViewFullGST',
    name: 'canViewFullName',
    address: 'canViewFullAddress',
    aadhaarDocuments: 'canViewAadhaarDocuments',
    panDocuments: 'canViewPANDocuments',
  }

  const permissionKey = fieldPermissionMap[field]
  return permissionKey ? permissions[permissionKey] : false
}

// Default export
export default {
  applyFieldLevelAccess,
  createAccessControl,
  canViewField,
  getUserPermissions,
  ROLES,
  ROLE_PERMISSIONS,
}
