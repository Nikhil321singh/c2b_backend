import { expect } from 'chai'
import storeModel from '../models/storeModel.js'

// The store payout mode must accept the HSBC bank-transfer modes, otherwise a
// store can never be configured for IMPS/NEFT and the payout flow is unreachable.
// validateSync() runs schema validation without a DB connection, so we only
// assert on the payoutSettings.mode path (other required fields are irrelevant).
describe('store payout mode enum', () => {
  const modeError = (mode) =>
    new storeModel({ payoutSettings: { mode } }).validateSync()?.errors?.[
      'payoutSettings.mode'
    ]

  it('accepts HSBC_IMPS', () => {
    expect(modeError('HSBC_IMPS')).to.equal(undefined)
  })

  it('accepts HSBC_NEFT', () => {
    expect(modeError('HSBC_NEFT')).to.equal(undefined)
  })

  it('still accepts the existing MANUAL and HSBC_UPI modes', () => {
    expect(modeError('MANUAL')).to.equal(undefined)
    expect(modeError('HSBC_UPI')).to.equal(undefined)
  })

  it('rejects an unknown mode', () => {
    expect(modeError('NOT_A_MODE')).to.not.equal(undefined)
  })
})
