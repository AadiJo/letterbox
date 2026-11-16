// A time the core sent, parsed and formatted. Nothing here reads the machine's clock.

export const sent = new Date('2026-03-09T16:00:00.000Z')
export const parsed = Date.parse('2026-03-09T16:00:00.000Z')
export const frame = performance.now()
