import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-extension-test-'));
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;

    await runTests({
      ...(vscodeExecutablePath
        ? { vscodeExecutablePath }
        : { version: '1.93.1' as const }),
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [testWorkspace, '--disable-extensions'],
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exitCode = 1;
  } finally {
    fs.rmSync(testWorkspace, { recursive: true, force: true });
  }
}

void main();
