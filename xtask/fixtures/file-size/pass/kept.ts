// Over the limit and exactly at the 505 lines the baseline records. The check must
// pass it. Ways it could fail on this file:
//   - it reports a file at its recorded number, an off-by-one
//   - it reads the baseline for .rs files only
export const fixture = true
// pad to 505 lines
