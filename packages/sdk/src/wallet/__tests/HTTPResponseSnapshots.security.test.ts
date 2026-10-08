import { createHash } from 'node:crypto'
import {
  assertSafeWalletJSONValue,
  assertSafeWalletValue,
  validateHTTPWalletJSONResponse,
  validateWalletResult
} from '../WalletResultValidation.js'
import { normalizeBRC100WalletByteFields } from '../BRC100ByteEncoding.js'
import type { CallType } from '../substrates/WalletWireCalls.js'

function legacy(call: CallType, value: unknown): unknown {
  const raw = assertSafeWalletJSONValue(value, `HTTPWalletJSON ${call} raw response`)
  const data = assertSafeWalletValue(
    normalizeBRC100WalletByteFields(raw),
    `HTTPWalletJSON ${call} response`
  )
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Invalid HTTPWalletJSON ${call} response: expected an object`)
  }
  return validateWalletResult(call, data)
}

function validate(call: CallType, value: unknown): any {
  return validateHTTPWalletJSONResponse(call, value, undefined, { ok: true }).data
}

function outcome(action: () => unknown): unknown {
  try {
    return { value: action() }
  } catch (error) {
    return { error: (error as Error).message, name: (error as Error).name }
  }
}

function sparseBytes(): number[] {
  const value = [1, 2, 3]
  delete value[1]
  return value
}

describe('private HTTP wallet snapshots', () => {
  it.each([
    ['dense', [0, 7, 255]],
    ['typed', new Uint8Array([0, 7, 255])],
    ['historical', { 0: 0, 1: 7, 2: 255 }],
    ['null prototype', Object.assign(Object.create(null), { 0: 0, 1: 7, 2: 255 })],
    ['empty', []]
  ])('preserves %s bytes and isolates returned storage', (_name, plaintext) => {
    const source = { plaintext, metadata: { note: 'unchanged' } }
    const actual = validate('decrypt', source)
    expect(actual).toEqual(legacy('decrypt', source))
    expect(actual).not.toBe(source)
    expect(actual.plaintext).not.toBe(plaintext)
    source.metadata.note = 'changed'
    expect(actual.metadata.note).toBe('unchanged')
  })

  it('retains historical repair with safe non-enumerable metadata', () => {
    const plaintext = Object.defineProperty({ 0: 7 }, 'note', { value: 9 })
    expect(validate('decrypt', { plaintext })).toEqual(legacy('decrypt', { plaintext }))
    expect(validate('decrypt', { plaintext }).plaintext).toEqual([7])
  })

  it('preserves byte aliases but does not reinterpret opaque numeric records', () => {
    const bytes = [3, 4, 5]
    const numeric = { 0: 7, 1: 8 }
    const source = { plaintext: bytes, alias: bytes, opaque: numeric, data: numeric }
    const actual = validate('decrypt', source)
    const expected = legacy('decrypt', source) as typeof actual
    expect(actual).toEqual(expected)
    expect(actual.alias).toBe(actual.plaintext)
    expect(actual.plaintext).not.toBe(bytes)
    expect(Array.isArray(actual.opaque)).toBe(false)
    expect(actual.data).toEqual([7, 8])
  })

  it('isolates input mutation during status access and after return', () => {
    const plaintext = [7, 8, 9]
    const source = { plaintext }
    const result = validateHTTPWalletJSONResponse('decrypt', source, undefined, {
      get ok() {
        plaintext[0] = 256
        source.plaintext = [99]
        return true
      }
    }).data as { plaintext: number[] }
    expect(result.plaintext).toEqual([7, 8, 9])
    plaintext[1] = -1
    expect(result.plaintext).toEqual([7, 8, 9])
    result.plaintext[0] = 256
    expect(() => validateWalletResult('decrypt', result)).toThrow()
    expect(() => validate('decrypt', result)).toThrow()
  })

  it('reads each untrusted byte descriptor once', () => {
    let reads = 0
    const plaintext = new Proxy([7, 8, 9], {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        if (key !== 'length' && descriptor !== undefined) {
          reads++
          return { ...descriptor, value: reads <= 3 ? descriptor.value : 256 }
        }
        return descriptor
      }
    })
    expect(validate('decrypt', { plaintext }).plaintext).toEqual([7, 8, 9])
    expect(reads).toBe(3)
  })

  it.each([
    ['decrypt', { plaintext: sparseBytes() }],
    ['decrypt', { plaintext: [256] }],
    ['decrypt', { plaintext: [-1] }],
    ['decrypt', { plaintext: Object.defineProperty([7], '0', { enumerable: false }) }],
    ['decrypt', { plaintext: [NaN] }],
    ['decrypt', { plaintext: { 0: 1, 2: 3 } }],
    ['decrypt', { plaintext: new Date() }],
    ['decrypt', { plaintext: new Uint8Array(new SharedArrayBuffer(2)) }],
    ['decrypt', JSON.parse('{"plaintext":[1],"__proto__":{}}')],
    ['createHmac', { hmac: Array.from({ length: 31 }, () => 7) }],
    ['createSignature', { signature: [0x30, 0x06, 0x02, 0x01, 1, 0x02, 0x01] }],
    ['verifySignature', { valid: false }],
    ['verifyHmac', { valid: 'true' }],
    ['decrypt', []],
    ['decrypt', null]
  ] as const)('retains failure semantics for %s: %p', (call, value) => {
    const expected = outcome(() => legacy(call, value))
    expect(expected).toHaveProperty('error')
    expect(outcome(() => validate(call, value))).toEqual(expected)
  })

  it('rejects accessors without running them or reading HTTP status', () => {
    let reads = 0
    const value = Object.defineProperty({}, 'plaintext', {
      get() {
        reads++
        return [7]
      }
    })
    expect(() =>
      validateHTTPWalletJSONResponse('decrypt', value, undefined, {
        get ok() {
          reads++
          throw new Error('status accessed')
        }
      })
    ).toThrow('raw response')
    expect(reads).toBe(0)
  })

  it('preserves shape/status/schema ordering and status exceptions', () => {
    const response = {
      get ok(): boolean {
        throw new Error('status exception')
      }
    }
    expect(() => validateHTTPWalletJSONResponse('decrypt', [], undefined, response)).toThrow(
      'expected an object'
    )
    expect(() =>
      validateHTTPWalletJSONResponse('decrypt', { plaintext: [7] }, undefined, response)
    ).toThrow('status exception')
    expect(
      validateHTTPWalletJSONResponse('decrypt', { isError: true, code: 4 }, undefined, {
        ok: false
      })
    ).toEqual({ ok: false, data: { isError: true, code: 4 } })
  })

  it('does not expose owned buffers to replaceable normalization methods', () => {
    const replacements: Array<[object, PropertyKey]> = [
      [Object, 'entries'],
      [Array, 'from'],
      [Array.prototype, 'every'],
      [Array.prototype, 'push'],
      [Array.prototype, Symbol.iterator],
      [WeakSet.prototype, 'has'],
      [WeakSet.prototype, 'add']
    ]
    const descriptors = replacements.map(([target, key]) =>
      Object.getOwnPropertyDescriptor(target, key)!
    )
    const source = { plaintext: [7, 8], metadata: { nested: [true, 'safe'] } }
    let result: unknown
    let calls = 0
    try {
      for (let i = 0; i < replacements.length; i++) {
        Object.defineProperty(replacements[i][0], replacements[i][1], {
          ...descriptors[i],
          value() {
            calls++
            throw new Error('replaceable method called')
          }
        })
      }
      result = validate('decrypt', source)
    } finally {
      for (let i = 0; i < replacements.length; i++) {
        Object.defineProperty(replacements[i][0], replacements[i][1], descriptors[i])
      }
    }
    expect(calls).toBe(0)
    expect(result).toEqual(source)
  })

  it('does not leak private buffers through inherited numeric setters or an iterator', () => {
    const zero = Object.getOwnPropertyDescriptor(Array.prototype, '0')
    const iterator = Object.getOwnPropertyDescriptor(Object.prototype, Symbol.iterator)
    const source = { plaintext: [7, 8], metadata: { nested: [true, 'safe'] } }
    let calls = 0
    let result: unknown
    try {
      Object.defineProperty(Array.prototype, '0', {
        configurable: true,
        set() {
          calls++
        }
      })
      Object.defineProperty(Object.prototype, Symbol.iterator, {
        configurable: true,
        get() {
          calls++
          throw new Error('inherited iterator')
        }
      })
      result = validate('decrypt', source)
    } finally {
      if (zero === undefined) delete (Array.prototype as unknown as Record<string, unknown>)['0']
      else Object.defineProperty(Array.prototype, '0', zero)
      if (iterator === undefined)
        delete (Object.prototype as Record<symbol, unknown>)[Symbol.iterator]
      else Object.defineProperty(Object.prototype, Symbol.iterator, iterator)
    }
    expect(calls).toBe(0)
    expect(result).toEqual(source)
  })

  it('retains private ownership when status access poisons lookup and type detection', () => {
    const replacements: Array<[object, PropertyKey]> = [
      [WeakMap.prototype, 'get'],
      [WeakMap.prototype, 'set'],
      [ArrayBuffer, 'isView'],
      [Object.prototype, 'toString']
    ]
    const descriptors = replacements.map(([target, key]) =>
      Object.getOwnPropertyDescriptor(target, key)!
    )
    const plaintext = new Uint8Array([7, 8, 9])
    let result: any
    let calls = 0
    try {
      result = validateHTTPWalletJSONResponse(
        'decrypt',
        { plaintext, alias: plaintext },
        undefined,
        {
          get ok() {
            for (let i = 0; i < replacements.length; i++) {
              Object.defineProperty(replacements[i][0], replacements[i][1], {
                ...descriptors[i],
                value() {
                  calls++
                  throw new Error('poisoned intrinsic')
                }
              })
            }
            plaintext[0] = 99
            return true
          }
        }
      ).data
    } finally {
      for (let i = 0; i < replacements.length; i++) {
        Object.defineProperty(replacements[i][0], replacements[i][1], descriptors[i])
      }
    }
    expect(calls).toBe(0)
    expect(result.plaintext).toEqual(new Uint8Array([7, 8, 9]))
    expect(result.alias).toBe(result.plaintext)
  })

  it('preserves all 4,323,620 bytes in an independently owned result', () => {
    const plaintext = Array.from({ length: 4_323_620 }, (_, index) => index % 256)
    const result = validate('decrypt', { plaintext })
    const digest = (value: number[]) =>
      createHash('sha256').update(Uint8Array.from(value)).digest('hex')
    expect(result.plaintext).not.toBe(plaintext)
    expect(result.plaintext.length).toBe(plaintext.length)
    expect(digest(result.plaintext)).toBe(digest(plaintext))
    plaintext[0] = 99
    expect(result.plaintext[0]).toBe(0)
  }, 30_000)
})
