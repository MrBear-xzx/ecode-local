import * as assert from 'assert';
import { lifecycleConnectionIdentity } from '../../domain/lifecycle';

suite('lifecycle domain', () => {
  test('binds a lifecycle snapshot to environment and server identity', () => {
    const identity = lifecycleConnectionIdentity(
      'environment-a',
      'D:\\workspace\\project\\dev',
      'http://localhost:8099/',
      'SysAdmin',
    );

    assert.strictEqual(
      identity,
      lifecycleConnectionIdentity(
        'environment-a',
        'd:\\WORKSPACE\\PROJECT\\DEV',
        'HTTP://LOCALHOST:8099',
        'sysadmin',
      ),
    );
    assert.notStrictEqual(
      identity,
      lifecycleConnectionIdentity(
        'environment-b',
        'D:\\workspace\\project\\dev',
        'http://localhost:8099',
        'sysadmin',
      ),
    );
    assert.notStrictEqual(
      identity,
      lifecycleConnectionIdentity(
        'environment-a',
        'D:\\workspace\\project\\dev',
        'http://localhost:9099',
        'sysadmin',
      ),
    );
  });
});
