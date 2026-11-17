import { expect } from 'chai'
import { withSmsRetries } from '../services/payoutNotificationService.js'

// delayMs: 0 keeps the tests instant (no real backoff waiting).
const NO_DELAY = { delayMs: 0 }

describe('withSmsRetries', () => {
  it('returns the result on the first successful attempt', async () => {
    let calls = 0
    const result = await withSmsRetries(async () => {
      calls += 1
      return { delivered: true }
    }, NO_DELAY)
    expect(result).to.deep.equal({ delivered: true })
    expect(calls).to.equal(1)
  })

  it('retries a transient failure and then succeeds', async () => {
    let calls = 0
    const result = await withSmsRetries(async () => {
      calls += 1
      if (calls < 3) {
        throw new Error('transient network error')
      }
      return { delivered: true }
    }, { maxAttempts: 3, delayMs: 0 })
    expect(result).to.deep.equal({ delivered: true })
    expect(calls).to.equal(3)
  })

  it('rethrows the last error after exhausting all attempts', async () => {
    let calls = 0
    try {
      await withSmsRetries(async () => {
        calls += 1
        throw new Error(`fail-${calls}`)
      }, { maxAttempts: 3, delayMs: 0 })
      expect.fail('expected withSmsRetries to throw')
    } catch (error) {
      expect(error.message).to.equal('fail-3')
    }
    expect(calls).to.equal(3)
  })

  it('does not retry a resolved soft-failure (permanent skip)', async () => {
    let calls = 0
    const result = await withSmsRetries(async () => {
      calls += 1
      // postMsg91Flow resolves (does not throw) for missing template / bad number.
      return { delivered: false, reason: 'SMS template is not configured' }
    }, NO_DELAY)
    expect(result.delivered).to.equal(false)
    expect(calls).to.equal(1)
  })
})
