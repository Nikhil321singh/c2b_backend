import fs from 'fs'
import { expect } from 'chai'
import {
  pgpConfigured,
  encryptSignToBase64,
  decryptVerifyFromBase64,
} from '../integrations/hsbc/hsbcPgp.js'

// These tests need the local (git-ignored) hsbc-keys/. They are skipped when the
// keys are not present (e.g. CI), which is expected.
describe('hsbc pgp', function () {
  before(function () {
    if (!pgpConfigured()) {
      this.skip()
    }
  })

  it('encrypts + signs a payload into Base64 PGP', async () => {
    const b64 = await encryptSignToBase64('<p2aRequest><AMOUNT>1</AMOUNT></p2aRequest>')
    const armored = Buffer.from(b64, 'base64').toString('utf8')
    expect(armored).to.contain('BEGIN PGP MESSAGE')
  })

  it('round-trips: decrypts a message encrypted to the client key', async () => {
    const openpgp = await import('openpgp')
    const clientPublic = await openpgp.readKey({
      armoredKey: fs.readFileSync('./hsbc-keys/client-public.key', 'utf8'),
    })
    const clientPrivEnc = await openpgp.readPrivateKey({
      armoredKey: fs.readFileSync('./hsbc-keys/client-private.key', 'utf8'),
    })
    const clientPriv = await openpgp.decryptKey({
      privateKey: clientPrivEnc,
      passphrase: '1password',
    })
    const armored = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: '<Response><RRN>012119135393</RRN></Response>' }),
      encryptionKeys: clientPublic,
      signingKeys: clientPriv,
      format: 'armored',
    })
    const b64 = Buffer.from(armored, 'utf8').toString('base64')
    const { text } = await decryptVerifyFromBase64(b64)
    expect(text).to.contain('<RRN>012119135393</RRN>')
  })
})
