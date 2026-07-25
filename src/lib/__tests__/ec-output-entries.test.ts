import { describe, expect, it } from 'vitest'
import { parseEcResults } from '../bmp-types'

describe('parseEcResults structured output entries', () => {
  it('keeps the result boundary while preserving the flattened log contract', () => {
    const parsed = parseEcResults([{
      $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
      entries: [
        { logType: 'MESSAGE', message: '<style>.x{color:red}</style>' },
        { logType: 'MESSAGE', message: 'Result : <div class="x">Ready</div>' },
        { logType: 'MESSAGE', message: 'Duration : 4ms' },
      ],
    }])

    expect(parsed.log).toBe([
      '<style>.x{color:red}</style>',
      '<div class="x">Ready</div>',
      'Duration : 4ms',
    ].join('\n'))
    expect(parsed.outputEntries).toEqual([
      { logType: 'MESSAGE', message: '<style>.x{color:red}</style>', result: false },
      { logType: 'MESSAGE', message: '<div class="x">Ready</div>', result: true },
      { logType: 'MESSAGE', message: 'Duration : 4ms', result: false },
    ])
  })

  it('retains warning types for consumers that must not hide them', () => {
    const parsed = parseEcResults([{
      $class: 'com.corporater.bmp.dto.command.extended.ExtendedExecuteResult',
      entries: [
        { logType: 'MESSAGE', message: 'Result : <div>Ready</div>' },
        { logType: 'WARNING', message: 'Partial result' },
      ],
    }])

    expect(parsed.hasWarning).toBe(true)
    expect(parsed.outputEntries[1]).toEqual({
      logType: 'WARNING',
      message: 'Partial result',
      result: false,
    })
  })
})
