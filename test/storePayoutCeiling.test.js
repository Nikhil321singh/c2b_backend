import { expect } from 'chai'
import {
  PayoutBusinessError,
  assertWithinPayoutCeiling,
  resolveStorePayoutCeiling,
} from '../services/buybackPayoutService.js'

// A store without its own ceiling must fall back to the global default rather
// than being treated as unlimited, and the block message must not disclose the
// store's authorised limit to the sales person.
describe('store payout ceiling', () => {
  const originalDefault = process.env.DEFAULT_STORE_PAYOUT_CEILING

  afterEach(() => {
    if (originalDefault === undefined) {
      delete process.env.DEFAULT_STORE_PAYOUT_CEILING
    } else {
      process.env.DEFAULT_STORE_PAYOUT_CEILING = originalDefault
    }
  })

  describe('resolveStorePayoutCeiling', () => {
    it('uses the store ceiling when one is configured', () => {
      process.env.DEFAULT_STORE_PAYOUT_CEILING = '50000'
      expect(resolveStorePayoutCeiling(5000)).to.equal(5000)
    })

    it('falls back to the global default when the store ceiling is 0', () => {
      process.env.DEFAULT_STORE_PAYOUT_CEILING = '40000'
      expect(resolveStorePayoutCeiling(0)).to.equal(40000)
    })

    it('falls back to the global default when the store ceiling is unset', () => {
      delete process.env.DEFAULT_STORE_PAYOUT_CEILING
      expect(resolveStorePayoutCeiling(undefined)).to.equal(50000)
      expect(resolveStorePayoutCeiling(null)).to.equal(50000)
    })

    it('ignores a blank or non-numeric global default', () => {
      process.env.DEFAULT_STORE_PAYOUT_CEILING = ''
      expect(resolveStorePayoutCeiling(0)).to.equal(50000)
      process.env.DEFAULT_STORE_PAYOUT_CEILING = 'unlimited'
      expect(resolveStorePayoutCeiling(0)).to.equal(50000)
    })

    it('allows the global default to be turned off with 0', () => {
      process.env.DEFAULT_STORE_PAYOUT_CEILING = '0'
      expect(resolveStorePayoutCeiling(0)).to.equal(0)
    })
  })

  describe('assertWithinPayoutCeiling', () => {
    it('blocks an amount above the ceiling with a 409', () => {
      let thrown
      try {
        assertWithinPayoutCeiling(6000, 5000)
      } catch (error) {
        thrown = error
      }
      expect(thrown).to.be.instanceOf(PayoutBusinessError)
      expect(thrown.statusCode).to.equal(409)
      expect(thrown.message).to.equal(
        'This payout exceeds the authorised ceiling for this store. Contact your Company Admin or Super Admin to raise the limit.',
      )
    })

    it('does not disclose the ceiling value in the message', () => {
      try {
        assertWithinPayoutCeiling(6000, 5000)
      } catch (error) {
        expect(error.message).to.not.contain('5000')
      }
    })

    it('allows an amount equal to the ceiling', () => {
      expect(() => assertWithinPayoutCeiling(5000, 5000)).to.not.throw()
    })

    it('allows an amount below the ceiling', () => {
      expect(() => assertWithinPayoutCeiling(4999, 5000)).to.not.throw()
    })

    it('does not block when no ceiling applies', () => {
      expect(() => assertWithinPayoutCeiling(999999, 0)).to.not.throw()
      expect(() => assertWithinPayoutCeiling(999999, undefined)).to.not.throw()
    })
  })
})
