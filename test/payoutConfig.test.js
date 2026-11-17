import { expect } from 'chai'
import {
  normalizeBuybackPayoutSettings,
  PayoutConfigError,
} from '../services/payoutConfigService.js'

describe('payout config - company buyback settings normalization', () => {
  it('normalizes enabled + numeric rule fields', () => {
    const result = normalizeBuybackPayoutSettings({
      enabled: true,
      deviceCooldownDays: '30',
      customerSellLimitCount: 3,
      customerSellLimitWindowDays: 90,
    })
    expect(result).to.deep.equal({
      enabled: true,
      deviceCooldownDays: 30,
      customerSellLimitCount: 3,
      customerSellLimitWindowDays: 90,
    })
  })

  it('defaults missing fields (disabled, zeroed rules)', () => {
    expect(normalizeBuybackPayoutSettings({})).to.deep.equal({
      enabled: false,
      deviceCooldownDays: 0,
      customerSellLimitCount: 0,
      customerSellLimitWindowDays: 0,
    })
  })

  it('rejects a negative numeric value', () => {
    expect(() =>
      normalizeBuybackPayoutSettings({ deviceCooldownDays: -1 }),
    ).to.throw(PayoutConfigError, /zero or a positive number/)
  })

  it('requires the sell-limit count and window to be set together', () => {
    expect(() =>
      normalizeBuybackPayoutSettings({ customerSellLimitCount: 3 }),
    ).to.throw(PayoutConfigError, /must be set together/)
    expect(() =>
      normalizeBuybackPayoutSettings({ customerSellLimitWindowDays: 90 }),
    ).to.throw(PayoutConfigError, /must be set together/)
  })

  it('accepts a paired sell limit', () => {
    const result = normalizeBuybackPayoutSettings({
      customerSellLimitCount: 2,
      customerSellLimitWindowDays: 30,
    })
    expect(result.customerSellLimitCount).to.equal(2)
    expect(result.customerSellLimitWindowDays).to.equal(30)
  })
})
