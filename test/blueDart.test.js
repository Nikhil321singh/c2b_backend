import { expect } from 'chai'
import {
  BlueDartMappingError,
  buildWaybillRequest,
  formatBlueDartDate,
  formatBlueDartTime,
  mapLeadToWaybillRequest,
  toCreditReference,
} from '../integrations/bluedart/blueDartMapper.js'
import {
  BlueDartConfigurationError,
  blueDartConfigurationStatus,
  blueDartProfile,
  generateWaybill,
  getJwtToken,
  resetBlueDartTokenCache,
  trackShipment,
} from '../integrations/bluedart/blueDartClient.js'
import { parseTrackingResponse } from '../integrations/bluedart/blueDartTracking.js'

const TEST_ADDRESS_LINE = 'Sector 45, Gurugram'
const TEST_BLUEDART_BASE_URL =
  'https://apigateway-sandbox.bluedart.com/in/transportation'
const EXPECTED_CONFIG_ERROR_MESSAGE = 'expected BlueDartConfigurationError'

const validInput = () => ({
  pickup: {
    originArea: 'GGN',
    customerCode: '940111',
    name: 'Radical Aftermarket Services',
    address1: TEST_ADDRESS_LINE,
    pincode: '122003',
    mobile: '9990077455',
  },
  drop: {
    name: 'GREST Warehouse',
    address1: TEST_ADDRESS_LINE,
    pincode: '122003',
    mobile: '9990077455',
  },
  service: {
    productCode: 'A',
    productType: '0',
    creditReferenceNo: 'REF123',
    declaredValue: 1000,
    pickupDate: new Date('2026-08-05T09:00:00Z'),
  },
})

describe('blue dart mapper', () => {
  it('builds a waybill request with Shipper, Consignee, Returnadds and Services', () => {
    const req = buildWaybillRequest(validInput())
    expect(req.Shipper.OriginArea).to.equal('GGN')
    expect(req.Consignee.ConsigneeName).to.equal('GREST Warehouse')
    expect(req.Services.ProductCode).to.equal('A')
    expect(req.Services.CreditReferenceNo).to.equal('REF123')
    expect(req.Services.RegisterPickup).to.equal(true)
    // Blue Dart requires the RTO block; it defaults to the consignee.
    expect(req.Returnadds.ReturnAddress1).to.equal(TEST_ADDRESS_LINE)
    expect(req.Returnadds.ReturnPincode).to.equal('122003')
  })

  it('sends pincodes, customer code and mobiles as strings', () => {
    const req = buildWaybillRequest(validInput())
    expect(req.Shipper.CustomerCode).to.equal('940111')
    expect(req.Shipper.CustomerPincode).to.equal('122003')
    expect(req.Consignee.ConsigneePincode).to.equal('122003')
    expect(req.Shipper.CustomerMobile).to.equal('9990077455')
  })

  it('preserves a leading zero in the customer code', () => {
    // The API reference's own sample uses "099960"; coercing to a number would
    // address a different account.
    const input = validInput()
    input.pickup.customerCode = '099960'
    expect(buildWaybillRequest(input).Shipper.CustomerCode).to.equal('099960')
  })

  it('formats weight and piece count as strings', () => {
    const req = buildWaybillRequest(validInput())
    expect(req.Services.ActualWeight).to.equal('0.50')
    expect(req.Services.PieceCount).to.equal('1')
  })

  it('strips +91 and separators down to the 10-digit mobile', () => {
    const input = validInput()
    input.pickup.mobile = '+91 99900-77455'
    expect(buildWaybillRequest(input).Shipper.CustomerMobile).to.equal('9990077455')
  })

  it('coerces a numeric ProductType and passes named values through', () => {
    expect(buildWaybillRequest(validInput()).Services.ProductType).to.equal('0')
    const named = validInput()
    named.service.productType = 'Dutiables'
    expect(buildWaybillRequest(named).Services.ProductType).to.equal('Dutiables')
  })

  it('omits IsReversePickup unless explicitly requested', () => {
    expect(buildWaybillRequest(validInput()).Services).to.not.have.property(
      'IsReversePickup',
    )
    const rvp = validInput()
    rvp.service.isReversePickup = true
    expect(buildWaybillRequest(rvp).Services.IsReversePickup).to.equal(true)
  })

  it('keeps the label enabled by default via PDFOutputNotRequired=false', () => {
    expect(buildWaybillRequest(validInput()).Services.PDFOutputNotRequired).to.equal(
      false,
    )
  })

  it('uses an explicit return address when supplied', () => {
    const input = validInput()
    input.returnAddress = {
      name: 'RTO Hub',
      address1: 'Return Addr 1',
      pincode: '400057',
      mobile: '9995554447',
    }
    const req = buildWaybillRequest(input)
    expect(req.Returnadds.ReturnAddress1).to.equal('Return Addr 1')
    expect(req.Returnadds.ReturnPincode).to.equal('400057')
  })

  it('rejects a CreditReferenceNo longer than 20 characters', () => {
    // Blue Dart answers "InvalidCreditReferenceNo" with HTTP 400 otherwise.
    const input = validInput()
    input.service.creditReferenceNo = 'GRESTTEST1786102955206'
    expect(() => buildWaybillRequest(input)).to.throw(
      BlueDartMappingError,
      /at most 20 characters/,
    )
  })

  it('fits long GREST references into the 20-character limit', () => {
    // A lead uniqueCode or a 24-char ObjectId both overflow the limit.
    expect(toCreditReference('64f1a2b3c4d5e6f7a8b9c0d1')).to.equal(
      'a2b3c4d5e6f7a8b9c0d1',
    )
    expect(toCreditReference('64f1a2b3c4d5e6f7a8b9c0d1')).to.have.length(20)
    expect(toCreditReference('SHORT-1')).to.equal('SHORT-1')
  })

  it('keeps a lead-derived reference within the limit', () => {
    const req = mapLeadToWaybillRequest(
      { _id: '64f1a2b3c4d5e6f7a8b9c0d1', payoutAmount: 100 },
      {
        pickupOverride: validInput().pickup,
        warehouse: validInput().drop,
        service: { productCode: 'A', productType: '0' },
      },
    )
    expect(req.Services.CreditReferenceNo).to.have.length.of.at.most(20)
  })

  it('requires pickup, drop and service', () => {
    expect(() => buildWaybillRequest({})).to.throw(BlueDartMappingError)
  })

  it('validates mandatory shipper/consignee fields', () => {
    const input = validInput()
    input.pickup.pincode = ''
    expect(() => buildWaybillRequest(input)).to.throw(
      BlueDartMappingError,
      /pickup.pincode/,
    )
  })

  it('rejects a non-numeric pincode', () => {
    const input = validInput()
    input.drop.pincode = 'ABC'
    expect(() => buildWaybillRequest(input)).to.throw(
      BlueDartMappingError,
      /drop.pincode/,
    )
  })

  it('formats the pickup date as the Blue Dart /Date(...)/ token without an offset', () => {
    const token = formatBlueDartDate(new Date('2026-08-05T09:00:00Z'))
    expect(token).to.match(/^\/Date\(\d+\)\/$/)
    expect(() => formatBlueDartDate('not-a-date')).to.throw(BlueDartMappingError)
  })

  it('normalises pickup time to HHMM', () => {
    expect(formatBlueDartTime('1430')).to.equal('1430')
    expect(formatBlueDartTime(new Date('2026-08-05T14:05:00'))).to.equal('1405')
  })

  it('maps a GREST lead to a waybill request', () => {
    const lead = {
      _id: 'lead1',
      uniqueCode: 'PAY-1',
      payoutAmount: 5000,
      storeId: {
        storeName: 'Test Store',
        address: 'Sector 45',
        region: 'GGN',
        pincode: '122003',
        contactNumber: '9990077455',
      },
    }
    const req = mapLeadToWaybillRequest(lead, {
      warehouse: {
        name: 'WH',
        address1: 'WH Addr',
        pincode: '122003',
        mobile: '9990077455',
      },
      service: { productCode: 'A', productType: '0', customerCode: '940111' },
    })
    expect(req.Services.CreditReferenceNo).to.equal('PAY-1')
    expect(req.Services.DeclaredValue).to.equal(5000)
    expect(req.Shipper.OriginArea).to.equal('GGN')
  })
})

describe('blue dart tracking parser', () => {
  it('reads shipment status from the element form', () => {
    const xml = `<ShipmentData><Shipment>
      <WaybillNo>76662235090</WaybillNo>
      <Status>SHIPMENT DELIVERED</Status>
      <StatusType>DL</StatusType>
      <StatusDate>07-Aug-2026</StatusDate>
    </Shipment></ShipmentData>`
    const [entry] = parseTrackingResponse(xml)
    expect(entry.awbNo).to.equal('76662235090')
    expect(entry.status).to.equal('SHIPMENT DELIVERED')
    expect(entry.statusType).to.equal('DL')
  })

  it('reads shipment status from the attribute form', () => {
    const xml =
      '<ShipmentData><Shipment WaybillNo="76662235090" Status="IN TRANSIT"></Shipment></ShipmentData>'
    const [entry] = parseTrackingResponse(xml)
    expect(entry.awbNo).to.equal('76662235090')
    expect(entry.status).to.equal('IN TRANSIT')
  })

  it('returns one entry per shipment', () => {
    const xml =
      '<ShipmentData><Shipment WaybillNo="1" Status="A"></Shipment><Shipment WaybillNo="2" Status="B"></Shipment></ShipmentData>'
    expect(parseTrackingResponse(xml)).to.have.length(2)
  })

  it('surfaces a servlet-level error document', () => {
    const [entry] = parseTrackingResponse('<Error>Invalid login</Error>')
    expect(entry.error).to.equal('Invalid login')
  })

  it('returns an empty list for an unrecognised body', () => {
    expect(parseTrackingResponse('')).to.deep.equal([])
  })
})

describe('blue dart client configuration', () => {
  const KEYS = [
    'BLUEDART_BASE_URL',
    'BLUEDART_WAYBILL_PATH',
    'BLUEDART_LOGIN_ID',
    'BLUEDART_LICENSE_KEY',
    'BLUEDART_CUSTOMER_CODE',
    'BLUEDART_ORIGIN_AREA',
    'BLUEDART_CLIENT_ID',
    'BLUEDART_CLIENT_SECRET',
    'BLUEDART_JWT_TOKEN',
    'BLUEDART_TRACKING_LICENSE_KEY',
  ]
  let saved

  beforeEach(() => {
    saved = {}
    for (const key of KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    resetBlueDartTokenCache()
  })
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = saved[key]
      }
    }
    resetBlueDartTokenCache()
  })

  it('is unconfigured without endpoint and credentials', () => {
    expect(blueDartConfigurationStatus().configured).to.equal(false)
    expect(blueDartConfigurationStatus().provider).to.equal('BLUEDART')
  })

  it('is configured once gateway, profile and app credentials are present', () => {
    process.env.BLUEDART_BASE_URL = TEST_BLUEDART_BASE_URL
    process.env.BLUEDART_LOGIN_ID = 'GG940111'
    process.env.BLUEDART_LICENSE_KEY = 'secret'
    process.env.BLUEDART_CLIENT_ID = 'key'
    process.env.BLUEDART_CLIENT_SECRET = 'secret'
    expect(blueDartConfigurationStatus().configured).to.equal(true)
  })

  it('accepts a pre-generated JWT in place of app credentials', () => {
    process.env.BLUEDART_BASE_URL = TEST_BLUEDART_BASE_URL
    process.env.BLUEDART_LOGIN_ID = 'GG940111'
    process.env.BLUEDART_LICENSE_KEY = 'secret'
    process.env.BLUEDART_JWT_TOKEN = 'a.b.c'
    expect(blueDartConfigurationStatus().configured).to.equal(true)
  })

  it('stays unconfigured when the gateway is set but auth is missing', () => {
    process.env.BLUEDART_BASE_URL = TEST_BLUEDART_BASE_URL
    process.env.BLUEDART_LOGIN_ID = 'GG940111'
    process.env.BLUEDART_LICENSE_KEY = 'secret'
    expect(blueDartConfigurationStatus().configured).to.equal(false)
  })

  it('exposes tracking-only readiness from credentials alone', () => {
    process.env.BLUEDART_LOGIN_ID = 'GG940111'
    process.env.BLUEDART_LICENSE_KEY = 'secret'
    const status = blueDartConfigurationStatus()
    expect(status.configured).to.equal(false)
    expect(status.trackingConfigured).to.equal(true)
  })

  it('builds the Profile using the Blue Dart field names', () => {
    process.env.BLUEDART_LOGIN_ID = 'GG940111'
    process.env.BLUEDART_LICENSE_KEY = 'secret'
    process.env.BLUEDART_ORIGIN_AREA = 'GGN'
    const profile = blueDartProfile()
    expect(profile.LoginID).to.equal('GG940111')
    expect(profile.LicenceKey).to.equal('secret')
    expect(profile.Api_type).to.equal('S')
    // OriginArea/CustomerCode belong to the Shipper block, not the Profile.
    expect(profile).to.not.have.property('Area')
    expect(profile).to.not.have.property('CustomerCode')
  })

  it('returns a statically configured JWT without calling the token API', async () => {
    process.env.BLUEDART_JWT_TOKEN = 'static.jwt.token'
    expect(await getJwtToken()).to.equal('static.jwt.token')
  })

  it('throws a configuration error when no auth is configured', async () => {
    try {
      await getJwtToken()
      expect.fail(EXPECTED_CONFIG_ERROR_MESSAGE)
    } catch (error) {
      expect(error).to.be.instanceOf(BlueDartConfigurationError)
    }
  })

  it('throws a configuration error for waybill when the gateway is missing', async () => {
    try {
      await generateWaybill({ Shipper: {}, Consignee: {}, Services: {} })
      expect.fail(EXPECTED_CONFIG_ERROR_MESSAGE)
    } catch (error) {
      expect(error).to.be.instanceOf(BlueDartConfigurationError)
    }
  })

  it('throws a configuration error for tracking without credentials', async () => {
    try {
      await trackShipment('76662235090')
      expect.fail(EXPECTED_CONFIG_ERROR_MESSAGE)
    } catch (error) {
      expect(error).to.be.instanceOf(BlueDartConfigurationError)
    }
  })
})
