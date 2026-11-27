// Sell (manual payout): the sale is answered before the receipt emails are
// sent, and an unreachable mail server gives up in seconds, not minutes.
import { expect } from 'chai'
import { sendReceiptsInBackground } from '../controller/questionnaireController.js'
import transporter from '../utils/transporter.js'
import mailTransporter from '../utils/mailTransporter.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('Sell: receipt emails do not hold the sale', () => {
  it('sends the emails only after the current response has gone out', async () => {
    const order = []
    sendReceiptsInBackground(() => {
      order.push('emails')
    })
    order.push('response')
    await tick()
    expect(order).to.deep.equal(['response', 'emails'])
  })

  it('a failing email is logged, never thrown back to the sale', async () => {
    let called = false
    expect(() =>
      sendReceiptsInBackground(async () => {
        called = true
        throw new Error('Connection timeout')
      }),
    ).to.not.throw()
    await tick()
    expect(called).to.equal(true)
  })

  it('a synchronous throw inside the sender is also caught', async () => {
    expect(() =>
      sendReceiptsInBackground(() => {
        throw new Error('boom')
      }),
    ).to.not.throw()
    await tick()
  })
})

describe('Mail transporters: short time limits', () => {
  for (const [name, mailer] of [['transporter', transporter], ['mailTransporter', mailTransporter]]) {
    it(`${name} gives up on an unreachable server within seconds`, () => {
      expect(mailer.options.connectionTimeout).to.equal(10000)
      expect(mailer.options.greetingTimeout).to.equal(10000)
      expect(mailer.options.socketTimeout).to.equal(20000)
    })
  }
})
