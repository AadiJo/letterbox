// A new file one line over the limit. The check must report it. Ways it could fail on this file:
//   - it lets a file one line over the limit through, an off-by-one
//   - it reports the file under a path other than its path from the root
// pad to 501 lines
