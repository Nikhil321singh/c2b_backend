import { expect } from 'chai'
import { buildSaleRollback } from '../controller/questionnaireController.js'

// A lead is marked sold before its payout exists. If payout creation fails the
// marking must be undone, otherwise the device is consumed with nothing to pay
// it and the is_selled guard rejects every retry as "Item sold out".
describe('sale rollback after a failed payout', () => {
  it('clears the sold flag', () => {
    expect(buildSaleRollback('Pending').$set.is_selled).to.equal(false)
  })

  it('restores the previous lead status', () => {
    expect(buildSaleRollback('Pending').$set.status).to.equal('Pending')
    expect(buildSaleRollback('Available For Pickup').$set.status).to.equal(
      'Available For Pickup',
    )
  })

  it('leaves the status untouched when the previous one is unknown', () => {
    expect(buildSaleRollback(undefined).$set).to.not.have.property('status')
    expect(buildSaleRollback('').$set).to.not.have.property('status')
  })

  it('removes the sale timestamp and payout amount', () => {
    const rollback = buildSaleRollback('Pending')
    expect(rollback.$unset).to.have.property('soldAt')
    expect(rollback.$unset).to.have.property('payoutAmount')
  })

  it('never leaves the lead sold', () => {
    for (const status of ['Pending', 'Picked Up', undefined]) {
      expect(buildSaleRollback(status).$set.is_selled).to.equal(false)
    }
  })
})
