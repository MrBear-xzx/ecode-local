import * as assert from 'assert';
import {
  findGbkIncompatibleCharacters,
  formatUnicodeCodePoint,
} from '../../domain/gbk';

suite('GBK source validation', () => {
  test('accepts ASCII, Chinese, and GBK punctuation', () => {
    assert.deepStrictEqual(
      findGbkIncompatibleCharacters('> 中文 → …\n'),
      [],
    );
  });

  test('reports exact positions for unsupported characters', () => {
    const issues = findGbkIncompatibleCharacters('ok\n箭头 ›\nemoji 😀');

    assert.deepStrictEqual(issues.map(issue => ({
      character: issue.character,
      codePoint: formatUnicodeCodePoint(issue.codePoint),
      line: issue.line,
      column: issue.column,
    })), [{
      character: '›',
      codePoint: 'U+203A',
      line: 2,
      column: 4,
    }, {
      character: '😀',
      codePoint: 'U+1F600',
      line: 3,
      column: 7,
    }]);
  });

  test('accepts an ASCII Unicode escape for an unsupported runtime character', () => {
    assert.deepStrictEqual(
      findGbkIncompatibleCharacters('const arrow = "\\u203A";\n'),
      [],
    );
  });
});
