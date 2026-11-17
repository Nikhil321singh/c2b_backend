import { expect } from 'chai'
import { classifyBankEnquiryFailure } from '../services/buybackPayoutService.js'
import {
  HsbcPaymentConfigurationError,
  HsbcPaymentTransportError,
} from '../integrations/hsbc/hsbcPaymentInitiationClient.js'

// An IMPS/NEFT status enquiry fails for causes that need different operator
// responses. One shared message made a setup gap look like a payment problem.
describe('bank status enquiry failure classification', () => {
  it('reports an unconfigured integration distinctly', () => {
    const failure = classifyBankEnquiryFailure(
      new HsbcPaymentConfigurationError('HSBC payment client is not configured'),
    )
    expect(failure.outcome).to.equal('STATUS_NOT_CONFIGURED')
    expect(failure.message).to.contain('not configured on this environment')
  })

  it('reports an endpoint HSBC has not enabled distinctly', () => {
    const failure = classifyBankEnquiryFailure(
      new HsbcPaymentTransportError('Not Found', 404),
    )
    expect(failure.outcome).to.equal('STATUS_ENDPOINT_UNAVAILABLE')
    expect(failure.message).to.contain('enables the enquiry API')
  })

  it('reports rejected credentials distinctly', () => {
    for (const status of [401, 403]) {
      const failure = classifyBankEnquiryFailure(
        new HsbcPaymentTransportError('Denied', status),
      )
      expect(failure.outcome).to.equal('STATUS_AUTH_REJECTED')
      expect(failure.message).to.contain('rejected the status enquiry')
    }
  })

  it('falls back to the generic transport failure', () => {
    const failure = classifyBankEnquiryFailure(
      new HsbcPaymentTransportError('socket hang up', 500),
    )
    expect(failure.outcome).to.equal('STATUS_TRANSPORT_ERROR')
    expect(failure.message).to.contain('could not confirm the payment status')
  })

  it('never tells the operator to retry the payment', () => {
    const errors = [
      new HsbcPaymentConfigurationError('nope'),
      new HsbcPaymentTransportError('Not Found', 404),
      new HsbcPaymentTransportError('Denied', 401),
      new HsbcPaymentTransportError('timeout', undefined),
    ]
    for (const error of errors) {
      expect(classifyBankEnquiryFailure(error).message).to.contain(
        'Do not retry the payment',
      )
    }
  })
})
