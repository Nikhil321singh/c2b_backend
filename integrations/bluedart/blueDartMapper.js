// Pure mapping from GREST shipment data to a Blue Dart GenerateWayBill request.
//
// Field names, nesting and value types follow the Blue Dart Apigee
// "Waybill Generation Process" sample request verbatim (Request.Shipper /
// Request.Consignee / Request.Returnadds / Request.Services). Notably Blue Dart
// sends pincodes, mobiles and CustomerCode as JSON numbers rather than strings.
//
// Kept pure (no I/O) so it can be unit tested.

export class BlueDartMappingError extends Error {}

const str = (value) => String(value ?? '').trim()

const requireField = (value, name) => {
  const out = str(value)
  if (!out) {
    throw new BlueDartMappingError(`Blue Dart waybill: "${name}" is required`)
  }
  return out
}

// Pincodes and customer codes are sent as JSON strings, per the Blue Dart API
// reference. This matters: the reference's own sample uses CustomerCode
// "099960", and coercing that to a number would silently drop the leading zero
// and address a different account.
const digitString = (value, name) => {
  const digits = str(value).replace(/\D/g, '')
  if (!digits) {
    throw new BlueDartMappingError(`Blue Dart waybill: "${name}" is required`)
  }
  return digits
}

// Indian mobile numbers arrive with assorted +91 / 0 prefixes and spacing; Blue
// Dart wants the bare 10-digit subscriber number as a string.
const mobile = (value) => {
  const digits = str(value).replace(/\D/g, '')
  if (!digits) {
    return ''
  }
  return digits.slice(-10)
}

// Blue Dart rejects a CreditReferenceNo longer than 20 characters
// ("InvalidCreditReferenceNo"). Enforced here so an over-long reference fails
// in the mapper rather than as an opaque HTTP 400 mid-booking.
export const CREDIT_REFERENCE_MAX_LENGTH = 20

/**
 * Fit a GREST reference into Blue Dart's 20-character limit by keeping the
 * tail, which carries the timestamp/random portion of both a lead uniqueCode
 * and a Mongo ObjectId (24 chars) and so stays unique.
 */
export const toCreditReference = (value) =>
  str(value).slice(-CREDIT_REFERENCE_MAX_LENGTH)

const creditReference = (value) => {
  const out = requireField(value, 'service.creditReferenceNo')
  if (out.length > CREDIT_REFERENCE_MAX_LENGTH) {
    throw new BlueDartMappingError(
      `Blue Dart waybill: "service.creditReferenceNo" must be at most ${CREDIT_REFERENCE_MAX_LENGTH} characters (got ${out.length})`,
    )
  }
  return out
}

// ProductType is numeric in the Blue Dart sample ("ProductType": 0 for Docs).
// Named values are passed through unchanged so the configured value can be
// corrected without a code change. Always returned as a string so the mapper's
// request body is type-consistent.
const productType = (value) => {
  const raw = str(value)
  if (raw === '') {
    return '0'
  }
  return /^\d+$/.test(raw) ? String(Number(raw)) : raw
}

// Blue Dart classic APIs expect dates as "/Date(<epochMs>)/". The sample
// request carries no timezone offset (responses do include "+0530").
export const formatBlueDartDate = (input) => {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) {
    throw new BlueDartMappingError('Blue Dart waybill: invalid pickup date')
  }
  return `/Date(${date.getTime()})/`
}

// Blue Dart pickup time is "HHMM" (e.g. "1430").
export const formatBlueDartTime = (input) => {
  const value = str(input)
  if (/^\d{4}$/.test(value)) {
    return value
  }
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) {
    return '1400'
  }
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}${mm}`
}

const buildShipper = (pickup) => ({
  OriginArea: requireField(pickup.originArea, 'pickup.originArea'),
  CustomerCode: digitString(pickup.customerCode, 'pickup.customerCode'),
  CustomerName: requireField(pickup.name, 'pickup.name'),
  CustomerAddress1: requireField(pickup.address1, 'pickup.address1'),
  CustomerAddress2: str(pickup.address2),
  CustomerAddress3: str(pickup.address3),
  CustomerPincode: digitString(pickup.pincode, 'pickup.pincode'),
  CustomerMobile: mobile(pickup.mobile),
  CustomerTelephone: str(pickup.telephone),
  CustomerEmailID: str(pickup.email),
  CustomerGSTNumber: str(pickup.gstNumber),
  CustomerLatitude: str(pickup.latitude),
  CustomerLongitude: str(pickup.longitude),
  CustomerMaskedContactNumber: str(pickup.maskedContactNumber),
  IsToPayCustomer: Boolean(pickup.isToPayCustomer),
  Sender: str(pickup.sender || pickup.name),
  VendorCode: str(pickup.vendorCode),
})

const buildConsignee = (drop) => ({
  ConsigneeName: requireField(drop.name, 'drop.name'),
  ConsigneeAddress1: requireField(drop.address1, 'drop.address1'),
  ConsigneeAddress2: str(drop.address2),
  ConsigneeAddress3: str(drop.address3),
  ConsigneePincode: digitString(drop.pincode, 'drop.pincode'),
  ConsigneeMobile: mobile(drop.mobile),
  ConsigneeTelephone: str(drop.telephone),
  ConsigneeEmailID: str(drop.email),
  // "R" (residential) / "C" (commercial); Blue Dart uses it for routing.
  ConsigneeAddressType: str(drop.addressType),
  ConsigneeAttention: str(drop.attention || drop.name),
  ConsigneeGSTNumber: str(drop.gstNumber),
  ConsigneeLatitude: str(drop.latitude),
  ConsigneeLongitude: str(drop.longitude),
  ConsigneeMaskedContactNumber: str(drop.maskedContactNumber),
})

// Return (RTO) address block. Blue Dart requires it on the waybill request; it
// defaults to the consignee so an undelivered shipment comes back to us.
const buildReturnAddress = (returnAddress, drop) => {
  const source = returnAddress || drop
  return {
    ManifestNumber: str(source.manifestNumber),
    ReturnAddress1: requireField(source.address1, 'return.address1'),
    ReturnAddress2: str(source.address2),
    ReturnAddress3: str(source.address3),
    ReturnContact: str(source.contact || source.name),
    ReturnEmailID: str(source.email),
    ReturnLatitude: str(source.latitude),
    ReturnLongitude: str(source.longitude),
    ReturnMaskedContactNumber: str(source.maskedContactNumber),
    ReturnMobile: mobile(source.mobile),
    ReturnPincode: digitString(source.pincode, 'return.pincode'),
    ReturnTelephone: str(source.telephone),
  }
}

const buildServices = (service) => {
  const out = {
    AWBNo: str(service.awbNo),
    // Weight and piece count are strings in the API reference ("0.50", "1").
    ActualWeight: Number(service.actualWeight || 0.5).toFixed(2),
    CollectableAmount: Number(service.collectableAmount || 0),
    Commodity: service.commodity || {},
    CreditReferenceNo: creditReference(service.creditReferenceNo),
    DeclaredValue: Number(service.declaredValue || 0),
    Dimensions: Array.isArray(service.dimensions) ? service.dimensions : [],
    ECCN: str(service.eccn),
    // false keeps AWBPrintContent populated, which is the shipping label.
    PDFOutputNotRequired: Boolean(service.pdfOutputNotRequired),
    PackType: str(service.packType),
    PickupDate: formatBlueDartDate(service.pickupDate || new Date()),
    PickupTime: formatBlueDartTime(service.pickupTime || '1400'),
    PieceCount: String(Number(service.pieceCount || 1)),
    ProductCode: requireField(service.productCode, 'service.productCode'),
    ProductType: productType(service.productType),
    RegisterPickup: service.registerPickup !== false,
    SpecialInstruction: str(service.specialInstruction),
    SubProductCode: str(service.subProductCode),
    OTPBasedDelivery: Number(service.otpBasedDelivery || 0),
    OTPCode: str(service.otpCode),
    itemdtl: Array.isArray(service.itemDetails) ? service.itemDetails : [],
    noOfDCGiven: Number(service.noOfDCGiven || 0),
  }
  // Only sent when explicitly requested: the GREST Blue Dart account is
  // provisioned without RVP, so the flag stays off unless configured otherwise.
  if (service.isReversePickup) {
    out.IsReversePickup = true
  }
  return out
}

/**
 * Assemble a Blue Dart WayBillGenerationRequest from explicit pickup (Shipper),
 * drop (Consignee), return-address and service inputs.
 */
export const buildWaybillRequest = ({
  pickup,
  drop,
  service,
  returnAddress,
} = {}) => {
  if (!pickup || !drop || !service) {
    throw new BlueDartMappingError(
      'Blue Dart waybill requires pickup, drop and service',
    )
  }
  return {
    Consignee: buildConsignee(drop),
    Returnadds: buildReturnAddress(returnAddress, drop),
    Services: buildServices(service),
    Shipper: buildShipper(pickup),
  }
}

/**
 * Derive waybill inputs from a GREST lead: pickup from the store, delivery to
 * the company warehouse. Addresses are provided by the caller/config because
 * the store pincode is not modelled on the store document.
 */
export const mapLeadToWaybillRequest = (
  lead,
  { pickupOverride, warehouse, service, returnAddress } = {},
) => {
  if (!lead) {
    throw new BlueDartMappingError('Blue Dart waybill: lead is required')
  }
  const store = lead.storeId && typeof lead.storeId === 'object' ? lead.storeId : {}

  const pickup = pickupOverride || {
    originArea: store.region || service?.originArea,
    customerCode: service?.customerCode,
    name: store.storeName || 'GREST Store',
    address1: store.address || '',
    pincode: store.pincode,
    mobile: store.contactNumber || '',
    email: store.email || '',
  }

  const drop = warehouse || {
    name: 'GREST Warehouse',
    address1: '',
    pincode: '',
  }

  return buildWaybillRequest({
    pickup,
    drop,
    returnAddress,
    service: {
      ...service,
      creditReferenceNo: toCreditReference(
        service?.creditReferenceNo || lead.uniqueCode || String(lead._id),
      ),
      declaredValue: service?.declaredValue ?? lead.payoutAmount ?? lead.price ?? 0,
    },
  })
}
