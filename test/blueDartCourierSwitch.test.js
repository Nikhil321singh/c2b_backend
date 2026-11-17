import { expect } from 'chai'
import {
  courierConfigurationStatus,
  createCourierOrder,
  trackCourierShipments,
  CourierConfigurationError,
} from '../integrations/courier/courierClient.js'
import { buildOrderRequestFromCourierPayload } from '../integrations/bluedart/blueDartCourierAdapter.js'
import {
  BlueDartConfigurationError,
  resetBlueDartTokenCache,
} from '../integrations/bluedart/blueDartClient.js'

const COURIER_KEYS = [
  'COURIER_PROVIDER',
  'COURIER_CREATE_ORDER_URL',
  'COURIER_API_TOKEN',
]
const BLUEDART_KEYS = [
  'BLUEDART_BASE_URL',
  'BLUEDART_WAYBILL_PATH',
  'BLUEDART_LOGIN_ID',
  'BLUEDART_LICENSE_KEY',
  'BLUEDART_ORIGIN_AREA',
  'BLUEDART_CUSTOMER_CODE',
  'BLUEDART_CLIENT_ID',
  'BLUEDART_CLIENT_SECRET',
  'BLUEDART_JWT_TOKEN',
  'BLUEDART_IS_REVERSE_PICKUP',
  'BLUEDART_WAREHOUSE_ADDR1',
  'BLUEDART_WAREHOUSE_PIN',
  'BLUEDART_WAREHOUSE_MOBILE',
]
const ALL = [...COURIER_KEYS, ...BLUEDART_KEYS]

const samplePayload = () => ({
  referenceId: 'PAY-1',
  pickup: { name: 'Test Store', address: 'Sector 45, Gurugram', phone: '9990077455' },
  device: { model: 'iPhone', amount: 5000 },
})

const configureBlueDartWarehouse = () => {
  process.env.BLUEDART_ORIGIN_AREA = 'GGN'
  process.env.BLUEDART_CUSTOMER_CODE = '940111'
  process.env.BLUEDART_WAREHOUSE_ADDR1 = 'Warehouse Rd'
  process.env.BLUEDART_WAREHOUSE_PIN = '122003'
  process.env.BLUEDART_WAREHOUSE_MOBILE = '9990077455'
}

describe('courier provider switch (Blue Dart)', () => {
  let saved
  beforeEach(() => {
    saved = {}
    for (const key of ALL) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    resetBlueDartTokenCache()
  })
  afterEach(() => {
    for (const key of ALL) {
      if (saved[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = saved[key]
      }
    }
    resetBlueDartTokenCache()
  })

  it('reports the generic provider by default', () => {
    const status = courierConfigurationStatus()
    expect(status.provider).to.equal('COURIER_ADAPTER')
    expect(status.configured).to.equal(false)
  })

  it('reports Blue Dart status when the provider is BLUEDART', () => {
    process.env.COURIER_PROVIDER = 'BLUEDART'
    expect(courierConfigurationStatus().provider).to.equal('BLUEDART')
    expect(courierConfigurationStatus().configured).to.equal(false)

    process.env.BLUEDART_BASE_URL =
      'https://apigateway-sandbox.bluedart.com/in/transportation'
    process.env.BLUEDART_LOGIN_ID = 'GG940111'
    process.env.BLUEDART_LICENSE_KEY = 'secret'
    process.env.BLUEDART_CLIENT_ID = 'key'
    process.env.BLUEDART_CLIENT_SECRET = 'secret'
    expect(courierConfigurationStatus().configured).to.equal(true)
  })

  it('exposes Blue Dart tracking readiness through the courier seam', () => {
    process.env.COURIER_PROVIDER = 'BLUEDART'
    process.env.BLUEDART_LOGIN_ID = 'GG940111'
    process.env.BLUEDART_LICENSE_KEY = 'secret'
    const status = courierConfigurationStatus()
    expect(status.configured).to.equal(false)
    expect(status.trackingConfigured).to.equal(true)
  })

  it('routes createCourierOrder to Blue Dart (and errors without a gateway)', async () => {
    process.env.COURIER_PROVIDER = 'BLUEDART'
    configureBlueDartWarehouse()
    // No BLUEDART_BASE_URL -> the Blue Dart client raises a config error (no network).
    try {
      await createCourierOrder(samplePayload())
      expect.fail('expected a Blue Dart configuration error')
    } catch (error) {
      expect(error).to.be.instanceOf(BlueDartConfigurationError)
    }
  })

  it('does not touch Blue Dart for the generic provider', async () => {
    // Generic provider with no endpoint -> generic CourierConfigurationError.
    try {
      await createCourierOrder(samplePayload())
      expect.fail('expected a generic courier configuration error')
    } catch (error) {
      expect(error).to.be.instanceOf(CourierConfigurationError)
      expect(error).to.not.be.instanceOf(BlueDartConfigurationError)
    }
  })

  it('refuses tracking for the generic provider', async () => {
    try {
      await trackCourierShipments(['76662235090'])
      expect.fail('expected a generic courier configuration error')
    } catch (error) {
      expect(error).to.be.instanceOf(CourierConfigurationError)
    }
  })

  it('maps the courier payload into a waybill request', () => {
    configureBlueDartWarehouse()
    const req = buildOrderRequestFromCourierPayload(samplePayload())
    expect(req.Shipper.OriginArea).to.equal('GGN')
    expect(req.Shipper.CustomerName).to.equal('Test Store')
    expect(req.Consignee.ConsigneePincode).to.equal('122003')
    expect(req.Services.DeclaredValue).to.equal(5000)
    expect(req.Services.CreditReferenceNo).to.equal('PAY-1')
  })

  it('trims an over-long lead reference to Blue Dart 20-character limit', () => {
    configureBlueDartWarehouse()
    const payload = samplePayload()
    // warehouseService falls back to String(lead._id) - a 24-char ObjectId.
    payload.referenceId = '64f1a2b3c4d5e6f7a8b9c0d1'
    const req = buildOrderRequestFromCourierPayload(payload)
    expect(req.Services.CreditReferenceNo).to.have.length(20)
    expect(req.Services.CreditReferenceNo).to.equal('a2b3c4d5e6f7a8b9c0d1')
  })

  it('books a forward shipment because the account has no RVP', () => {
    configureBlueDartWarehouse()
    const req = buildOrderRequestFromCourierPayload(samplePayload())
    expect(req.Services).to.not.have.property('IsReversePickup')
    expect(req.Services.RegisterPickup).to.equal(true)
  })

  it('enables reverse pickup only when BLUEDART_IS_REVERSE_PICKUP is set', () => {
    configureBlueDartWarehouse()
    process.env.BLUEDART_IS_REVERSE_PICKUP = 'true'
    const req = buildOrderRequestFromCourierPayload(samplePayload())
    expect(req.Services.IsReversePickup).to.equal(true)
  })

  it('returns undelivered shipments to the configured warehouse', () => {
    configureBlueDartWarehouse()
    const req = buildOrderRequestFromCourierPayload(samplePayload())
    expect(req.Returnadds.ReturnAddress1).to.equal('Warehouse Rd')
    expect(req.Returnadds.ReturnPincode).to.equal('122003')
  })
})
