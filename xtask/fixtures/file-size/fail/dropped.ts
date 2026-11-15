// Listed in the baseline at 600 lines, and now under the limit. The check must report
// it, so its line is removed and it cannot grow back. Ways it could fail on this file:
//   - it only looks for growth, so a stale line stays in the baseline
export const fixture = true
// pad to 20 lines
