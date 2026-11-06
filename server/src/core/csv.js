/**
 * One CSV cell. Quotes when needed, and neutralises spreadsheet formula
 * injection: a text cell starting with = + - @ (or tab / CR) is prefixed
 * with ' so Excel/Sheets treat it as text. Plain numbers such as phone
 * numbers ("+14155550100") or negative amounts are left untouched.
 */
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d[\d.]*$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
