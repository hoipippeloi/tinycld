import { createHmac } from 'node:crypto'

// RFC 6238 codes, as an authenticator app computes them (SHA-1, 6 digits,
// 30-second steps), so a spec can type the code a real user would.

function base32Decode(secret: string): Buffer {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    let bits = ''
    for (const char of secret.replace(/[\s=]/g, '').toUpperCase()) {
        const value = alphabet.indexOf(char)
        if (value < 0) throw new Error(`not base32: ${char}`)
        bits += value.toString(2).padStart(5, '0')
    }
    const bytes: number[] = []
    for (let i = 0; i + 8 <= bits.length; i += 8)
        bytes.push(Number.parseInt(bits.slice(i, i + 8), 2))
    return Buffer.from(bytes)
}

/** The code for the step `stepsAhead` steps after now. */
export function totpCode(secret: string, stepsAhead = 0): string {
    const step = Math.floor(Date.now() / 1000 / 30) + stepsAhead
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64BE(BigInt(step))
    const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
    const offset = hmac[hmac.length - 1] & 0x0f
    const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
    return value.toString().padStart(6, '0')
}
