// Over the limit, listed in the baseline at 520 lines, and now 510. A baselined file
// may shrink, so the check must pass it. Ways it could fail on this file:
//   - it reports any change from the recorded number, not only growth
//   - it reports a baselined file over the limit as if it were new
// pad to 510 lines
