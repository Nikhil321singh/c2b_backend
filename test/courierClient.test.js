import { expect } from 'chai'
import {
  CourierConfigurationError,
  courierConfigurationStatus,
  createCourierOrder,
} from '../integrations/courier/courierClient.js'

// Courier env keys this suite manipulates. Snapshotted and restored around each
// test so it never leaks configuration into other suites (which also read these).
const COURIER_ENV_KEYS = [
  'COURIER_CREATE_ORDER_URL',
  'COURIER_API_TOKEN',
  'COURIER_AUTH_URL',
  'COURIER_CLIENT_ID',
  'COURIER_CLIENT_SECRET',
  'COURIER_PROVIDER',
]
const TEST_CREATE_ORDER_URL = 'https://sandbox.example/create'

describe('courier client configuration', () => {
  let saved

  beforeEach(() => {
    saved = {}
    for (const key of COURIER_ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of COURIER_ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = saved[key]
      }
    }
  })

  describe('courierConfigurationStatus', () => {
    it('is unconfigured with no environment set', () => {
      const status = courierConfigurationStatus()
      expect(status.configured).to.equal(false)
      expect(status.provider).to.equal('COURIER_ADAPTER')
    })

    it('is unconfigured when the create-order URL is present but auth is missing', () => {
      process.env.COURIER_CREATE_ORDER_URL = TEST_CREATE_ORDER_URL
      expect(courierConfigurationStatus().configured).to.equal(false)
    })

    it('is configured with a create-order URL and a static API token', () => {
      process.env.COURIER_CREATE_ORDER_URL = TEST_CREATE_ORDER_URL
      process.env.COURIER_API_TOKEN = 'static-token'
      expect(courierConfigurationStatus().configured).to.equal(true)
    })

    it('is configured with a URL and full client-credential auth', () => {
      process.env.COURIER_CREATE_ORDER_URL = TEST_CREATE_ORDER_URL
      process.env.COURIER_AUTH_URL = 'https://sandbox.example/auth'
      process.env.COURIER_CLIENT_ID = 'id'
      process.env.COURIER_CLIENT_SECRET = 'secret'
      expect(courierConfigurationStatus().configured).to.equal(true)
    })

    it('stays unconfigured when client credentials are only partially set', () => {
      process.env.COURIER_CREATE_ORDER_URL = TEST_CREATE_ORDER_URL
      process.env.COURIER_AUTH_URL = 'https://sandbox.example/auth'
      process.env.COURIER_CLIENT_ID = 'id'
      // no COURIER_CLIENT_SECRET
      expect(courierConfigurationStatus().configured).to.equal(false)
    })

    it('reports the configured provider name', () => {
      process.env.COURIER_PROVIDER = 'BLUEDART'
      expect(courierConfigurationStatus().provider).to.equal('BLUEDART')
    })
  })

  describe('createCourierOrder guards (no network)', () => {
    it('throws when the create-order endpoint is not configured', async () => {
      try {
        await createCourierOrder({ any: 'payload' })
        expect.fail('expected CourierConfigurationError')
      } catch (error) {
        expect(error).to.be.instanceOf(CourierConfigurationError)
        expect(error.message).to.match(/create-order endpoint is not configured/)
      }
    })

    it('throws when the URL is set but authentication is not configured', async () => {
      process.env.COURIER_CREATE_ORDER_URL = TEST_CREATE_ORDER_URL
      // No token and no client credentials: auth guard trips before any network call.
      try {
        await createCourierOrder({ any: 'payload' })
        expect.fail('expected CourierConfigurationError')
      } catch (error) {
        expect(error).to.be.instanceOf(CourierConfigurationError)
        expect(error.message).to.match(/authentication is not configured/)
      }
    })
  })
})
