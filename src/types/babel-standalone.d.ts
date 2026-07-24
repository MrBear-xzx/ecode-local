declare module '@babel/standalone' {
  export const version: string;

  export interface TransformResult {
    code?: string | null;
  }

  export interface TransformOptions {
    babelrc?: boolean;
    filename?: string;
    sourceMaps?: boolean;
    sourceType?: 'module' | 'script' | 'unambiguous';
    presets?: unknown[];
    plugins?: unknown[];
  }

  export function transform(code: string, options: TransformOptions): TransformResult;
}
