import fs from 'fs'

// PGP encrypt/sign + decrypt/verify for the HSBC Payment Initiation flow.
//
// Requests: encrypt with the HSBC public key + sign with the client private key,
// then Base64 (the `paymentBase64` JSON field). Responses & webhook events:
// Base64-decode, decrypt with the client private key, verify with the HSBC
// public key. Passphrase for the client key defaults to the value HSBC ships in
// the key archive. `openpgp` is imported lazily so non-PGP paths and pure unit
// tests don't load it.

const env = (key, fallback = '') => (process.env[key] || fallback).trim()

const keyPaths = () => ({
  clientPrivate: env(
    'HSBC_PAYMENT_PGP_CLIENT_PRIVATE_KEY_PATH',
    './hsbc-keys/client-private.key',
  ),
  hsbcPublic: env(
    'HSBC_PAYMENT_PGP_HSBC_PUBLIC_KEY_PATH',
    './hsbc-keys/hsbc-public.key',
  ),
  passphrase: env('HSBC_PAYMENT_PGP_PASSPHRASE', '1password'),
})

export const pgpConfigured = () => {
  const paths = keyPaths()
  return fs.existsSync(paths.clientPrivate) && fs.existsSync(paths.hsbcPublic)
}

let cachedKeys = null
const loadKeys = async () => {
  if (cachedKeys) {
    return cachedKeys
  }
  const openpgp = await import('openpgp')
  const paths = keyPaths()
  const hsbcPublicKey = await openpgp.readKey({
    armoredKey: fs.readFileSync(paths.hsbcPublic, 'utf8'),
  })
  const encryptedPrivate = await openpgp.readPrivateKey({
    armoredKey: fs.readFileSync(paths.clientPrivate, 'utf8'),
  })
  const clientPrivateKey = await openpgp.decryptKey({
    privateKey: encryptedPrivate,
    passphrase: paths.passphrase,
  })
  cachedKeys = { openpgp, hsbcPublicKey, clientPrivateKey }
  return cachedKeys
}

/**
 * Encrypt + sign a UTF-8 payload and return it Base64-encoded (for paymentBase64).
 */
export const encryptSignToBase64 = async (text) => {
  const { openpgp, hsbcPublicKey, clientPrivateKey } = await loadKeys()
  const message = await openpgp.createMessage({ text: String(text) })
  const armored = await openpgp.encrypt({
    message,
    encryptionKeys: hsbcPublicKey,
    signingKeys: clientPrivateKey,
    format: 'armored',
  })
  return Buffer.from(armored, 'utf8').toString('base64')
}

/**
 * Base64-decode, decrypt and verify a PGP message (response or webhook event).
 * Returns { text, verified }. Verification failure does not throw; `verified` is
 * false so the caller can decide.
 */
export const decryptVerifyFromBase64 = async (base64) => {
  const { openpgp, hsbcPublicKey, clientPrivateKey } = await loadKeys()
  const armored = Buffer.from(String(base64), 'base64').toString('utf8')
  const message = await openpgp.readMessage({ armoredMessage: armored })
  const { data, signatures } = await openpgp.decrypt({
    message,
    decryptionKeys: clientPrivateKey,
    verificationKeys: hsbcPublicKey,
  })
  let verified = false
  try {
    if (signatures && signatures[0]) {
      await signatures[0].verified
      verified = true
    }
  } catch {
    verified = false
  }
  return { text: data, verified }
}
