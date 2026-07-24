import * as assert from 'assert';
import { TokenStore } from '../../sync/auth/TokenStore';

suite('Token store', () => {
  test('isolates passwords and cookies by connection identity', async () => {
    const secrets = new MemorySecrets();
    const first = new TokenStore(secrets as never, 'identity-a');
    const second = new TokenStore(secrets as never, 'identity-b');

    await first.storePassword('password-a');
    await first.storeCookie('cookie-a');

    assert.strictEqual(await first.getPassword(), 'password-a');
    assert.strictEqual(await first.getCookie(), 'cookie-a');
    assert.strictEqual(await second.getPassword(), undefined);
    assert.strictEqual(await second.getCookie(), undefined);
  });

  test('clears only v2 Ecode secrets when requested', async () => {
    const secrets = new MemorySecrets();
    const store = new TokenStore(secrets as never, 'identity-a');
    await store.storePassword('password-a');
    await secrets.store('unrelated.secret', 'keep');

    await store.clearAllV2();

    assert.strictEqual(await store.getPassword(), undefined);
    assert.strictEqual(await secrets.get('unrelated.secret'), 'keep');
  });
});

class MemorySecrets {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.values.keys()];
  }
}
