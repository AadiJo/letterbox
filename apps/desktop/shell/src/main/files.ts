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

/** The longest extension a cut keeps, dot included. ".settingcontent-ms", among the risky ones, is 18. */
const MAX_EXTENSION = 32

/** Drops a leading dot, which hides a file or makes "..", and trailing dots and spaces, which Windows drops itself. */
const trimmed = (name: string) => name.replace(/^[\s.]+|[\s.]+$/g, '')

/** Cuts a name to MAX_BYTES from the end of its stem, keeping its extension. */
function shorten(name: string): string {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 && name.length - dot <= MAX_EXTENSION ? name.slice(dot) : ''
  let stem = Array.from(name.slice(0, name.length - extension.length))
  while (stem.length > 0 && Buffer.byteLength(stem.join('') + extension) > MAX_BYTES) stem = stem.slice(0, -1)
  return stem.join('') + extension
}

/**
 * A file name that is safe to create in a folder main picked: one name, never a path, never
 * hidden, never a device, at most MAX_BYTES (one more for the device guard), with its
 * extension kept, and nothing at its end that Windows drops. That last part matters after a
 * cut: "setup.exe." reads as having no extension, and Windows creates "setup.exe". The name
 * this gives is the one written to disk, so `runsCode` reads that. Falls back to "attachment".
 */
export function safeName(name: string): string {
  const clean = trimmed(name.normalize('NFC').replace(INVISIBLE, '').replace(RESERVED, '_'))
  // A cut can leave a dot or a space at the end again, so the name is trimmed once more after it.
  const cut = trimmed(Buffer.byteLength(clean) > MAX_BYTES ? shorten(clean) : clean)
  if (cut === '') return 'attachment'
  return DEVICE_NAMES.test(cut) ? `_${cut}` : cut
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
    'ps1 psm1 vbs vbe js jse ws wsf wsc wsh sct hta lnk url scf reg inf',
    'application appref-ms gadget library-ms settingcontent-ms chm jar',
    // macOS apps, installers and scripts, and Launch Services shortcuts, which open the URL
    // inside them, a file:// one included.
    'app pkg mpkg command tool workflow scpt applescript terminal webloc inetloc fileloc',
    // Linux and Unix programs, packages and scripts.
    'sh bash zsh csh ksh fish run desktop appimage deb rpm',
    'py pyw pl rb php',
    // Disk images, which the OS mounts so the files inside open without its usual checks.
    'iso img vhd vhdx dmg',
    // Office documents with macros, and Excel add-ins.
    'docm dotm xlsm xltm xlam xll pptm potm ppsm',
  ]
    .join(' ')
    .split(' '),
)

/** True when opening a file of this name could run code. Pass the cleaned name. */
export const runsCode = (name: string): boolean => {
  const dot = name.lastIndexOf('.')
  return dot !== -1 && RUNS_CODE.has(name.slice(dot + 1).toLowerCase())
}
