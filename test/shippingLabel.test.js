import { expect } from 'chai'
import { normalizeShippingLabelPdf } from '../utils/invoiceHelpers.js'

const PDF_BYTES = Buffer.from('%PDF-1.4\nlabel\n%%EOF')

describe('shipping label PDF normalization', () => {
  it('accepts a PDF buffer', () => {
    expect(normalizeShippingLabelPdf(PDF_BYTES)).to.deep.equal(PDF_BYTES)
  })

  it('converts a Blue Dart byte array into PDF bytes', () => {
    expect(normalizeShippingLabelPdf([...PDF_BYTES])).to.deep.equal(PDF_BYTES)
  })

  it('decodes a base64 PDF string', () => {
    expect(
      normalizeShippingLabelPdf(PDF_BYTES.toString('base64')),
    ).to.deep.equal(PDF_BYTES)
  })

  it('decodes a PDF data URL', () => {
    const dataUrl = `data:application/pdf;base64,${PDF_BYTES.toString('base64')}`
    expect(normalizeShippingLabelPdf(dataUrl)).to.deep.equal(PDF_BYTES)
  })

  it('rejects malformed byte arrays', () => {
    expect(() => normalizeShippingLabelPdf([37, 80, 999])).to.throw(
      'unsupported format',
    )
  })

  it('rejects decoded content without a PDF signature', () => {
    expect(() =>
      normalizeShippingLabelPdf(Buffer.from('not a PDF').toString('base64')),
    ).to.throw('not a valid PDF')
  })
})
