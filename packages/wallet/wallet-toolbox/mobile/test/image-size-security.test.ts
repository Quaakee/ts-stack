import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const requireFromMobile = createRequire(path.join(process.cwd(), 'mobile/package.json'))
const metroManifest = requireFromMobile.resolve('metro/package.json')
const requireFromMetro = createRequire(metroManifest)
const imageSizeEntry = requireFromMetro.resolve('image-size')
const imageSizeManifest = path.resolve(path.dirname(imageSizeEntry), '../../package.json')
const imageSizeUtils = requireFromMetro.resolve('image-size/types/utils')

describe('Metro image-size security boundary', () => {
  it('uses the maintained release beyond both parser advisories', () => {
    const manifest = JSON.parse(readFileSync(imageSizeManifest, 'utf8')) as { version: string }
    expect(manifest.version).toBe('2.0.4')
  })

  it('terminates on zero-sized boxes and non-progressing ICNS entries', () => {
    const source = `
      const { imageSize } = require(${JSON.stringify(imageSizeEntry)})
      const { findBox } = require(${JSON.stringify(imageSizeUtils)})
      const zeroBox = Buffer.alloc(8)
      zeroBox.write('meta', 4)
      if (findBox(zeroBox, 'meta', 0) !== undefined) process.exit(4)
      const input = Buffer.alloc(16)
      input.write('icns', 0)
      input.writeUInt32BE(16, 4)
      input.write('ic07', 8)
      input.writeUInt32BE(0, 12)
      try {
        imageSize(input)
      } catch (error) {
        // A malformed record may be rejected by the detector or the ICNS
        // parser; termination without accepting dimensions is the contract.
        process.exit(0)
      }
      process.exit(2)
    `
    const result = spawnSync(process.execPath, ['-e', source], {
      encoding: 'utf8',
      timeout: 2_000
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
  })
})
