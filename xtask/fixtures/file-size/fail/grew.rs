// Listed in the baseline at 510 lines, and now 511. The check must report it. Ways it could fail:
//   - it compares a baselined file with the limit instead of its recorded number
//   - it lets one line of growth through, an off-by-one
// pad to 511 lines
