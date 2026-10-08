import { MAX_AUTH_MESSAGE_BYTES, snapshotBoundedAuthData } from '../AuthMessageValidation.js'

describe('authenticated byte snapshots', () => {
  it('reads each descriptor once and owns exactly the observed bytes', () => {
    let reads = 0
    const input = [7, 8, 9]
    const source = new Proxy(input, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        if (key !== 'length' && descriptor !== undefined) {
          reads++
          return { ...descriptor, value: reads <= 3 ? descriptor.value : 256 }
        }
        return descriptor
      }
    })
    const result = snapshotBoundedAuthData(source)
    input[0] = 99
    expect(reads).toBe(3)
    expect(result).toEqual([7, 8, 9])
    expect(result).not.toBe(source)
  })

  it('does not expose a retained payload to replaceable array methods', async () => {
    const from = Object.getOwnPropertyDescriptor(Array, 'from')!
    const every = Object.getOwnPropertyDescriptor(Array.prototype, 'every')!
    const source = [7, 8, 9]
    let captured: unknown[] | undefined
    const capture = (value: unknown[]) => {
      captured = value
    }
    let result: number[] | undefined
    try {
      Object.defineProperty(Array, 'from', {
        ...from,
        value(...args: unknown[]) {
          const value = Reflect.apply(from.value, Array, args) as unknown[]
          captured = value
          return value
        }
      })
      Object.defineProperty(Array.prototype, 'every', {
        ...every,
        value(this: unknown[], ...args: unknown[]) {
          capture(this)
          return Reflect.apply(every.value, this, args)
        }
      })
      result = snapshotBoundedAuthData(source)
    } finally {
      Object.defineProperty(Array, 'from', from)
      Object.defineProperty(Array.prototype, 'every', every)
    }
    await Promise.resolve()
    if (captured !== undefined) captured[0] = 255
    expect(captured).toBeUndefined()
    expect(result).toEqual([7, 8, 9])
  })

  it('captures later descriptor exceptions before reporting an earlier hole', () => {
    const sparse: unknown[] = []
    sparse.length = 2
    const source = new Proxy(sparse, {
      getOwnPropertyDescriptor(target, key) {
        if (key === '1') throw new Error('later descriptor')
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })
    expect(() => snapshotBoundedAuthData(source)).toThrow('later descriptor')
  })

  it('rejects accessors without invoking them and preserves non-byte traversal', () => {
    let reads = 0
    const source = Object.defineProperty([7], '0', {
      get() {
        reads++
        return 7
      }
    })
    expect(() => snapshotBoundedAuthData(source)).toThrow('sparse arrays')
    expect(reads).toBe(0)
    const mixed = [256, -1, 'text', [0, 255], { payload: [7, 8] }]
    const owned = snapshotBoundedAuthData(mixed)
    expect(owned).toEqual(mixed)
    expect(owned[3]).not.toBe(mixed[3])
    expect(owned[4]).not.toBe(mixed[4])
  })

  it('retains the exact aggregate byte bound', () => {
    const maximum = Math.floor((MAX_AUTH_MESSAGE_BYTES - 2) / 4)
    const value = Array.from({ length: maximum }, () => 7)
    expect(snapshotBoundedAuthData(value)).toHaveLength(maximum)
    value.push(7)
    expect(() => snapshotBoundedAuthData(value)).toThrow(
      'Authentication message exceeds the byte limit.'
    )
  }, 30_000)
})
