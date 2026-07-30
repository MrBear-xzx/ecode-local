import * as fs from 'fs';
import * as path from 'path';

const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx']);
let babel: BabelStandalone | undefined;

interface BabelStandalone {
  version: string;
  transform(
    source: string,
    options: Record<string, unknown>,
  ): { code?: string | null };
}

export class EcodeCompiler {
  compile(remotePath: string, source: string): string {
    if (!JAVASCRIPT_EXTENSIONS.has(path.posix.extname(remotePath).toLowerCase())) {
      return source;
    }

    try {
      const result = loadBabel().transform(source, {
        babelrc: false,
        filename: 'repl',
        sourceMaps: false,
        sourceType: 'module',
        presets: [
          'es2015',
          'react',
          ['stage-2', { decoratorsLegacy: true, loose: true }],
        ],
        plugins: ['proposal-object-rest-spread'],
      });
      if (typeof result.code !== 'string') {
        throw new Error('Babel 未返回编译结果');
      }
      return result.code;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Ecode 前端编译失败: ${remotePath}: ${message}`);
    }
  }

  getVersion(): string {
    return loadBabel().version;
  }
}

function loadBabel(): BabelStandalone {
  if (babel) {
    return babel;
  }
  const bundledRuntime = path.join(__dirname, 'babel.min.js');
  babel = module.require(
    fs.existsSync(bundledRuntime) ? bundledRuntime : '@babel/standalone',
  ) as BabelStandalone;
  return babel;
}
