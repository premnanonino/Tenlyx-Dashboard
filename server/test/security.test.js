import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell } from '../src/core/csv.js';
import { isAllowedEmail } from '../src/auth/auth.js';

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

test('isAllowedEmail accepts exact @courserev.ai addresses', () => {
  for (const ok of ['prem@courserev.ai', 'First.Last+tag@CourseRev.AI', '  a@courserev.ai  ']) {
    assert.equal(isAllowedEmail(ok, 'courserev.ai'), true, ok);
  }
});

test('isAllowedEmail rejects other domains and look-alikes', () => {
  for (const bad of ['prem@courserev.ai.evil.com', 'prem@evilcourserev.ai', 'prem@sub.courserev.ai', 'a@b@courserev.ai',
    '@courserev.ai', 'courserev.ai', 'prem@courserev.io', 'pr em@courserev.ai', '', null, undefined]) {
    assert.equal(isAllowedEmail(bad, 'courserev.ai'), false, String(bad));
  }
});
