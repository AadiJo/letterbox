// Listed in the baseline at 520 lines, and now 510. The check must report it, so the
// number is lowered and the file cannot grow back to 520. Ways it could fail on this file:
//   - it reports only growth, so the recorded number never comes down
//   - it reports a baselined file over the limit as if it were new
// pad to 510 lines
