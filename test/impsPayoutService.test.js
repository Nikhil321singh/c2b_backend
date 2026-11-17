import { expect } from 'chai'
import BuybackPayout from '../models/buybackPayoutModel.js'
import {
  PayoutBusinessError,
  validateBankDetails,
  validateApprovalDecision,
  maskAccount,
} from '../services/buybackPayoutService.js'

describe('imps payout - bank detail validation', () => {
  it('accepts and normalises a valid account + IFSC', () => {
    const result = validateBankDetails({
      accountNumber: ' 0730 4808 4001 ',
      ifsc: 'hdfc0000007',
      accountName: '  Rahman Ali  ',
    })
    expect(result.accountNumber).to.equal('073048084001')
    expect(result.ifsc).to.equal('HDFC0000007')
    expect(result.accountName).to.equal('Rahman Ali')
  })

  it('rejects an invalid account number', () => {
    expect(() => validateBankDetails({ accountNumber: '12', ifsc: 'HDFC0000007', accountName: 'Rahman Ali' })).to.throw(
      PayoutBusinessError,
      /account number/,
    )
    expect(() => validateBankDetails({ accountNumber: 'ABC123', ifsc: 'HDFC0000007', accountName: 'Rahman Ali' })).to.throw(
      PayoutBusinessError,
    )
  })

  it('rejects an invalid IFSC', () => {
    expect(() => validateBankDetails({ accountNumber: '073048084001', ifsc: 'HDFC123', accountName: 'Rahman Ali' })).to.throw(
      PayoutBusinessError,
      /IFSC/,
    )
    // 5th char must be 0
    expect(() => validateBankDetails({ accountNumber: '073048084001', ifsc: 'HDFCX000007', accountName: 'Rahman Ali' })).to.throw(
      PayoutBusinessError,
    )
  })

  it('requires a valid account holder name', () => {
    expect(() => validateBankDetails({
      accountNumber: '073048084001',
      ifsc: 'HDFC0000007',
      accountName: '',
    })).to.throw(PayoutBusinessError, /account holder name/)
  })

  it('masks all but the last four digits of an account', () => {
    expect(maskAccount('073048084001')).to.equal('********4001')
    expect(maskAccount('1234')).to.equal('1234')
  })
})

describe('payout approval decision validation', () => {
  it('requires a rejection remark and trims valid remarks', () => {
    expect(() => validateApprovalDecision({ approved: false, remarks: '   ' }))
      .to.throw(PayoutBusinessError, /remark is required/)
    expect(validateApprovalDecision({ approved: false, remarks: '  Invalid details  ' }))
      .to.deep.equal({ approved: false, remarks: 'Invalid details' })
  })

  it('allows approval without a remark', () => {
    expect(validateApprovalDecision({ approved: true }))
      .to.deep.equal({ approved: true, remarks: '' })
  })
})

describe('imps payout - model', () => {
  it('defaults the provider to HSBC_UPI', () => {
    expect(new BuybackPayout().provider).to.equal('HSBC_UPI')
  })

  it('accepts HSBC_IMPS as a valid provider and rejects unknown providers', () => {
    const impsErrors = new BuybackPayout({ provider: 'HSBC_IMPS' }).validateSync()?.errors || {}
    expect(impsErrors.provider).to.equal(undefined)

    const badErrors = new BuybackPayout({ provider: 'HSBC_XYZ' }).validateSync()?.errors || {}
    expect(badErrors.provider).to.not.equal(undefined)
  })

  it('hides the encrypted beneficiary account in JSON output', () => {
    const doc = new BuybackPayout({ beneficiaryAccountNumberEncrypted: 'secret', beneficiaryAccountMasked: '****4001' })
    const json = doc.toJSON()
    expect(json.beneficiaryAccountNumberEncrypted).to.equal(undefined)
    expect(json.beneficiaryAccountMasked).to.equal('****4001')
  })
})
