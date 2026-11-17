/*
 * Standalone HSBC IMPS sandbox connectivity test. No database needed.
 * Loads .env, sends one test IMPS payout to the HSBC sandbox, prints the result.
 *   node scripts/hsbcImpsSandboxTest.js
 */
import dotenv from 'dotenv'
import {
  paymentInitiationConfig,
  paymentInitiationStatus,
  buildImpsPaymentXml,
  initiateImpsPayout,
} from '../integrations/hsbc/hsbcPaymentInitiationClient.js'

dotenv.config()

const run = async () => {
  const cfg = paymentInitiationConfig()
  const status = paymentInitiationStatus()
  // Never print secrets.
  console.log('Config:', {
    baseUrl: cfg.baseUrl,
    profileId: cfg.profileId,
    debitAccount: cfg.remitterAccount,
    mockMode: cfg.mockMode,
    configured: status.configured,
    clientIdSet: Boolean(cfg.clientId),
    clientSecretSet: Boolean(cfg.clientSecret),
  })

  const beneficiary = {
    beneficiaryAccount: '10000002',
    beneficiaryIfsc: 'HDFC0000007',
    amount: 1,
  }
  console.log(
    '\nRequest XML that will be sent:\n' +
      buildImpsPaymentXml({
        serviceProviderId: cfg.serviceProviderId,
        requestId: 'PREVIEW',
        remitterAccount: cfg.remitterAccount,
        ...beneficiary,
        authToken: cfg.authToken,
      }),
  )

  console.log('\nCalling HSBC sandbox (payments/instant-settlement)…')
  try {
    const result = await initiateImpsPayout(beneficiary)
    console.log('\nRESULT:', JSON.stringify(result, null, 2))
  } catch (error) {
    console.log('\nERROR:', error.name, '-', error.message, '(status', error.status + ')')
  }
}

run()
