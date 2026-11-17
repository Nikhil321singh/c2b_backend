/**
 * Encryption Keys Configuration
 *
 * CRITICAL SECURITY:
 *  1. Add this file to .gitignore immediately
 *  2. Never commit this file to Git
 *  3. Back up keys securely (encrypted backup, password manager, HSM)
 *  4. Rotate keys periodically (every 90 days)
 *  5. Keep at least 2 keys: one active, one for decrypting old data
 *
 * KEY STRUCTURE:
 *  - id: unique identifier (e.g., 'v1', 'v2', 'prod-2024-q4')
 *  - key: 64-character hex string (32 bytes = 256 bits for AES-256)
 *  - active: boolean (only ONE key should be active at a time)
 *  - created: ISO date string (for audit/rotation tracking)
 *
 * GENERATE A NEW KEY:
 *  Run in terminal:
 *    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * AUTOMATIC KEY ROTATION:
 *  Keys are automatically rotated every 90 days by the key rotation scheduler.
 *  Last rotation: 2026-06-18
 */

export default {
  keys: {
    v1: {
      key: '65155037e586576ebdd178de628f53b11ed6699078c8b47efd06e326771082b0',
      active: false,
      created: '2026-02-18',
      description: 'Production encryption key v1',
    },

    v2: {
      key: 'cf8d91e90f8af0dd2c58ba0a361fced6e79237d3639464c2fa2cfb599f7d7a6b',
      active: false,
      created: '2026-02-25',
      description: 'Auto-rotated key (replaced v1)',
    },

    v3: {
      key: '834e56c20ead825ba849e4361e7cf9d4ad165cf357f80ce46033d0e02e34bddd',
      active: true,
      created: '2026-06-18',
      description: 'Auto-rotated key (replaced v2)',
    },

  },
}
