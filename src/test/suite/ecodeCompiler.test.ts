import * as assert from 'assert';
import { EcodeCompiler } from '../../sync/EcodeCompiler';

suite('Ecode compiler', () => {
  const compiler = new EcodeCompiler();

  test('matches the Ecode Babel version and transforms JavaScript and JSX', () => {
    const compiled = compiler.compile(
      'Type/example.js',
      'const render = value => <div>{value}</div>;\n',
    );

    assert.strictEqual(compiler.getVersion(), '7.5.5');
    assert.match(compiled, /React\.createElement/);
    assert.doesNotMatch(compiled, /=>/);
  });

  test('keeps non-JavaScript source as compiled content', () => {
    const css = '.example { color: red; }\n';
    const json = '{\n  "enabled": true\n}\n';

    assert.strictEqual(compiler.compile('Type/example.css', css), css);
    assert.strictEqual(compiler.compile('Type/example.json', json), json);
  });

  test('blocks invalid JavaScript before upload', () => {
    assert.throws(
      () => compiler.compile('Type/broken.js', 'const = ;'),
      /Ecode 前端编译失败: Type\/broken\.js/,
    );
  });
});
