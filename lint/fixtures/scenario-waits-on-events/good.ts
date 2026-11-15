// Waiting on what the core and the sim provider report. This file must stay clean.

const core = { inputClosed: async () => undefined }
const box = { applyHeld: async () => undefined }

export const stopped = async () => {
  await core.inputClosed()
  await box.applyHeld()
}
// A word in a string is not a timer.
export const note = 'scenarios never call setTimeout'
