/*
 * Blue Dart test-order helper.
 *
 * Generates one test waybill and saves the shipping label (AWBPrintContent) as a
 * PDF, which is what Blue Dart asked us to produce for validation.
 *
 * Usage:
 *   node scripts/bluedartTestOrder.js
 *
 * Requires (in the environment / secret manager — never committed):
 *   BLUEDART_BASE_URL  (sandbox: https://apigateway-sandbox.bluedart.com/in/transportation)
 *   BLUEDART_CLIENT_ID + BLUEDART_CLIENT_SECRET, or a ready BLUEDART_JWT_TOKEN
 *   BLUEDART_LOGIN_ID, BLUEDART_LICENSE_KEY, BLUEDART_CUSTOMER_CODE, BLUEDART_ORIGIN_AREA
 *   BLUEDART_PRODUCT_CODE, BLUEDART_PRODUCT_TYPE
 *
 * Until those are configured, the script runs as a DRY RUN: it prints the exact
 * request it would send (no network call), so the request shape can be reviewed
 * and shared.
 */
import fs from 'fs'
import dotenv from 'dotenv'
import { buildWaybillRequest } from '../integrations/bluedart/blueDartMapper.js'
import {
  blueDartConfigurationStatus,
  blueDartProfile,
  generateWaybill,
} from '../integrations/bluedart/blueDartClient.js'
import { safeLog } from '../utils/piiMasking.js'

dotenv.config()

const env = (key, fallback = '') => (process.env[key] || fallback).trim()

// Sample shipment for the validation order. Override any value via env.
const buildSampleRequest = () =>
  buildWaybillRequest({
    pickup: {
      originArea: env('BLUEDART_ORIGIN_AREA', 'GGN'),
      customerCode: env('BLUEDART_CUSTOMER_CODE', '940111'),
      name: env('BLUEDART_TEST_SHIPPER_NAME', 'Radical Aftermarket Services Pvt Ltd'),
      address1: env('BLUEDART_TEST_SHIPPER_ADDR', 'Sector 45, Gurugram'),
      address2: 'Haryana',
      pincode: env('BLUEDART_TEST_SHIPPER_PIN', '122003'),
      mobile: env('BLUEDART_TEST_SHIPPER_MOBILE', '9990077455'),
      email: env('BLUEDART_TEST_SHIPPER_EMAIL', 'baljeet.singh@grest.in'),
    },
    drop: {
      name: env('BLUEDART_TEST_CONSIGNEE_NAME', 'GREST Warehouse'),
      address1: env('BLUEDART_TEST_CONSIGNEE_ADDR', 'Sector 45, Gurugram'),
      address2: 'Haryana',
      pincode: env('BLUEDART_TEST_CONSIGNEE_PIN', '122003'),
      mobile: env('BLUEDART_TEST_CONSIGNEE_MOBILE', '9990077455'),
      email: env('BLUEDART_TEST_CONSIGNEE_EMAIL', 'warehouse.gurgaon@grest.in'),
      addressType: env('BLUEDART_WAREHOUSE_ADDRESS_TYPE', 'C'),
    },
    service: {
      productCode: env('BLUEDART_PRODUCT_CODE', 'A'),
      productType: env('BLUEDART_PRODUCT_TYPE'),
      subProductCode: env('BLUEDART_SUB_PRODUCT_CODE'),
      pieceCount: 1,
      actualWeight: Number(env('BLUEDART_TEST_WEIGHT', '0.5')),
      declaredValue: Number(env('BLUEDART_TEST_DECLARED_VALUE', '1000')),
      // Blue Dart caps CreditReferenceNo at 20 characters.
      creditReferenceNo: env('BLUEDART_TEST_REFERENCE', `GT${Date.now()}`),
      pickupDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      pickupTime: '1400',
      registerPickup: true,
      // Must stay false: the label Blue Dart asked us to share is returned as
      // AWBPrintContent, which is suppressed when this is true.
      pdfOutputNotRequired: false,
    },
  })

const saveLabel = (labelContent, outPath) => {
  let buffer
  if (typeof labelContent === 'string') {
    buffer = Buffer.from(labelContent, 'base64')
  } else if (Array.isArray(labelContent)) {
    buffer = Buffer.from(labelContent)
  } else {
    throw new Error('Unexpected AWBPrintContent format in Blue Dart response')
  }
  fs.writeFileSync(outPath, buffer)
  return outPath
}

const run = async () => {
  const request = buildSampleRequest()
  const status = blueDartConfigurationStatus()

  if (!status.configured) {
    safeLog.info(
      'Blue Dart not configured — DRY RUN. Set BLUEDART_BASE_URL plus BLUEDART_CLIENT_ID/BLUEDART_CLIENT_SECRET (or BLUEDART_JWT_TOKEN) to send.',
    )
    // Print the request (Profile creds hidden) so the shape can be reviewed/shared.
    const profile = blueDartProfile()
    const redactedProfile = {
      ...profile,
      LicenceKey: profile.LicenceKey ? '***' : '',
    }
    safeLog.info(
      'Request that would be sent:\n' +
        JSON.stringify({ Request: request, Profile: redactedProfile }, null, 2),
    )
    return
  }

  const result = await generateWaybill(request)
  safeLog.info(`Blue Dart waybill created: AWB ${result.awbNo}`)
  if (result.labelContent) {
    const outPath = env('BLUEDART_LABEL_OUT', './bluedart-test-label.pdf')
    saveLabel(result.labelContent, outPath)
    safeLog.info(`Shipping label saved to ${outPath}`)
  } else {
    safeLog.info('No AWBPrintContent returned; check PDFOutputNotRequired setting.')
  }
}

run().catch((error) => {
  safeLog.error('Blue Dart test order failed:', error.message)
  process.exitCode = 1
})
