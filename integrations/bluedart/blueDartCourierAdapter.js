import { buildWaybillRequest, toCreditReference } from './blueDartMapper.js'
import { generateWaybill } from './blueDartClient.js'

// Adapts the generic courier payload (produced by warehouseService) into a Blue
// Dart waybill: Shipper = the pickup store, Consignee = the company warehouse.
// The store's pincode is not modelled, so the origin pincode and the warehouse
// address come from configuration (single-warehouse default; revisit when
// multi-warehouse addresses are modelled).
//
// The GREST Blue Dart account is provisioned B2B/B2C without RVP, so this books
// a forward shipment with a registered pickup rather than a reverse pickup.
// BLUEDART_IS_REVERSE_PICKUP can flip that once RVP is enabled on the account.

const env = (key, fallback = '') => (process.env[key] || fallback).trim()

const flag = (key) => ['true', '1', 'yes'].includes(env(key).toLowerCase())

export const buildOrderRequestFromCourierPayload = (payload = {}) => {
  const pickup = payload.pickup || {}
  const device = payload.device || {}

  const warehouse = {
    name: env('BLUEDART_WAREHOUSE_NAME', 'GREST Warehouse'),
    address1: env('BLUEDART_WAREHOUSE_ADDR1'),
    address2: env('BLUEDART_WAREHOUSE_ADDR2'),
    pincode: env('BLUEDART_WAREHOUSE_PIN'),
    mobile: env('BLUEDART_WAREHOUSE_MOBILE'),
    email: env('BLUEDART_WAREHOUSE_EMAIL'),
    gstNumber: env('BLUEDART_WAREHOUSE_GST'),
    addressType: env('BLUEDART_WAREHOUSE_ADDRESS_TYPE', 'C'),
  }

  return buildWaybillRequest({
    pickup: {
      originArea: env('BLUEDART_ORIGIN_AREA'),
      customerCode: env('BLUEDART_CUSTOMER_CODE'),
      name: pickup.name || 'GREST Store',
      address1: pickup.address || '',
      pincode: env('BLUEDART_ORIGIN_PINCODE', '122003'),
      mobile: pickup.phone || '',
      gstNumber: env('BLUEDART_SHIPPER_GST'),
    },
    drop: warehouse,
    // Undelivered shipments return to the same warehouse they were bound for.
    returnAddress: warehouse,
    service: {
      productCode: env('BLUEDART_PRODUCT_CODE', 'A'),
      productType: env('BLUEDART_PRODUCT_TYPE'),
      subProductCode: env('BLUEDART_SUB_PRODUCT_CODE'),
      declaredValue: Number(device.amount || 0),
      actualWeight: Number(env('BLUEDART_DEFAULT_WEIGHT', '0.5')),
      // Blue Dart caps this at 20 chars; a lead uniqueCode or ObjectId is longer.
      creditReferenceNo: toCreditReference(
        payload.referenceId || `GREST${Date.now()}`,
      ),
      isReversePickup: flag('BLUEDART_IS_REVERSE_PICKUP'),
      registerPickup: true,
    },
  })
}

/**
 * Create a Blue Dart shipment for a warehouse lead. Returns the same shape as
 * the generic courier adapter (orderId + providerStatus) plus the label content
 * and pickup-registration outcome, so it can slot into the existing courier seam.
 */
export const createBlueDartOrder = async (payload) => {
  const request = buildOrderRequestFromCourierPayload(payload)
  const result = await generateWaybill(request)
  return {
    orderId: result.awbNo,
    // A waybill can be issued while its pickup registration fails; the caller
    // records that so Operations can chase the pickup separately.
    providerStatus: result.pickupRegistrationFailed ? 'PICKUP_FAILED' : 'CREATED',
    providerError: result.pickupRegistrationError || '',
    labelContent: result.labelContent,
    shipmentPickupDate: result.shipmentPickupDate,
  }
}
