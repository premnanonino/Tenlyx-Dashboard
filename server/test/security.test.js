import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell } from '../src/core/csv.js';

test('csvCell neutralises spreadsheet formulas', () => {
  assert.equal(csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('-2+3'), "'-2+3");
});

test('csvCell keeps phone numbers, amounts and plain text intact', () => {
  assert.equal(csvCell('+14155550100'), '+14155550100');
  assert.equal(csvCell('-0.25'), '-0.25');
  assert.equal(csvCell(-0.1234567), '-0.123457');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell(null), '');
});
