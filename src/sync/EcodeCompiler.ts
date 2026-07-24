import * as path from 'path';
import * as Babel from '@babel/standalone';

const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx']);

export class EcodeCompiler {
  compile(remotePath: string, source: string): string {
    if (!JAVASCRIPT_EXTENSIONS.has(path.posix.extname(remotePath).toLowerCase())) {
      return source;
    }

    try {
      const result = Babel.transform(source, {
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
    return Babel.version;
  }
}
