// Over the limit, but the test leaves files named untracked* out of git. The check
// must skip it. Ways it could fail on this file:
//   - it walks the folder instead of asking git which files are tracked
// pad to 501 lines
