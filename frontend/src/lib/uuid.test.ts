import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUuid } from './uuid'

describe('createUuid', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('creates a valid v4 UUID when crypto.randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0)
        return bytes
      },
    })

    expect(createUuid()).toBe('00000000-0000-4000-8000-000000000000')
  })
})
