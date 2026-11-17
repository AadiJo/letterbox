// What main decides about an attachment's file name before it touches the disk. The name
// comes from a message, so it is hostile: it may hold a path, a name the OS treats
// specially, or characters that make "photo.exe" read as "photo.pdf". attachments.ts calls these.

/** The most bytes of UTF-8 a cleaned name keeps. Every common file system takes 255. */
const MAX_BYTES = 200

/** Names Windows keeps for devices, with or without an extension. */
const DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i

/**
 * Control characters, and the bidirectional controls that reorder text, such as U+202E
 * RIGHT-TO-LEFT OVERRIDE, which shows "invoice‮fdp.exe" as "invoiceexe.pdf".
 */
// oxlint-disable-next-line no-control-regex -- these are the control characters a name must not keep
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g

/** Path separators and the characters Windows refuses in a name. */
const RESERVED = /[/\\:*?"<>|]/g

/**
 * A file name that is safe to create in a folder main picked: one name, never a path, never
 * hidden, never a device, at most MAX_BYTES, with its extension kept. Falls back to "attachment".
 */
export function safeName(name: string): string {
  let clean = name
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(RESERVED, '_')
    // A leading dot hides a file, or makes "..". Windows drops trailing dots and spaces.
    .replace(/^[\s.]+|[\s.]+$/g, '')
  if (DEVICE_NAMES.test(clean)) clean = `_${clean}`
  if (Buffer.byteLength(clean) > MAX_BYTES) {
    const dot = clean.lastIndexOf('.')
    const extension = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : ''
    let stem = Array.from(clean.slice(0, clean.length - extension.length))
    while (stem.length > 0 && Buffer.byteLength(stem.join('') + extension) > MAX_BYTES) stem = stem.slice(0, -1)
    clean = stem.join('') + extension
  }
  return clean === '' ? 'attachment' : clean
}

/**
 * Extensions whose file the OS runs, installs or mounts, or opens in a program that runs code
 * from it, when a person opens it: programs, installers, scripts, shortcuts, disk images and
 * documents with macros. Main warns before it opens one.
 */
const RUNS_CODE = new Set(
  [
    // Windows programs, installers, scripts and shortcuts.
    'exe com scr pif cpl msi msix msixbundle appx msp msc bat cmd',
    'ps1 psm1 vbs vbe js jse wsf wsh hta lnk url scf reg inf',
    'application appref-ms gadget library-ms settingcontent-ms chm jar',
    // macOS apps, installers and scripts.
    'app pkg mpkg command tool workflow scpt applescript terminal',
    // Linux and Unix programs, packages and scripts.
    'sh bash zsh csh ksh fish run desktop appimage deb rpm',
    'py pyw pl rb php',
    // Disk images, which the OS mounts so the files inside open without its usual checks.
    'iso img vhd vhdx dmg',
    // Office documents with macros.
    'docm dotm xlsm xltm xlam pptm potm ppsm',
  ]
    .join(' ')
    .split(' '),
)

/** True when opening a file of this name could run code. Pass the cleaned name. */
export const runsCode = (name: string): boolean => {
  const dot = name.lastIndexOf('.')
  return dot !== -1 && RUNS_CODE.has(name.slice(dot + 1).toLowerCase())
}
