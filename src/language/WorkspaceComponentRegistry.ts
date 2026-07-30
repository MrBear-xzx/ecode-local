import * as vscode from 'vscode';
import * as path from 'path';
import {
  parseEcodeComponentCalls,
  type EcodeComponentCall,
} from './componentRegistry';

const SOURCE_GLOB = '**/*.{js,jsx,ts,tsx}';
const EXCLUDE_GLOB = '**/{node_modules,out,dist,.git,.vscode-test}/**';
const SOURCE_LANGUAGES = new Set([
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
]);

export interface IndexedEcodeComponentCall extends EcodeComponentCall {
  uri: vscode.Uri;
  range: vscode.Range;
}

export interface RegisteredEcodeComponent {
  appId: string;
  name: string;
  definitions: readonly IndexedEcodeComponentCall[];
}

export class WorkspaceComponentRegistry implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly callsByUri = new Map<
    string,
    readonly IndexedEcodeComponentCall[]
  >();
  private readonly uriRevisions = new Map<string, number>();
  private sourceRoots: string[] = [];
  private readonly ready: Promise<void>;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB);
    this.disposables = [
      this.changed,
      watcher,
      watcher.onDidCreate(uri => {
        void this.refreshFile(uri);
      }),
      watcher.onDidChange(uri => {
        void this.refreshFile(uri);
      }),
      watcher.onDidDelete(uri => this.removeUri(uri)),
      vscode.workspace.onDidOpenTextDocument(document => {
        if (isSourceDocument(document)) {
          this.updateDocument(document);
        }
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (isSourceDocument(document)) {
          if (document.uri.scheme === 'untitled') {
            this.removeUri(document.uri);
          } else {
            void this.refreshFile(document.uri);
          }
        }
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (isSourceDocument(event.document)) {
          this.updateDocument(event.document);
        }
      }),
    ];
    for (const document of vscode.workspace.textDocuments) {
      if (isSourceDocument(document)) {
        this.updateDocument(document);
      }
    }
    this.ready = this.initialize().catch(() => undefined);
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  async getRegisteredComponents(
    appId: string,
  ): Promise<readonly RegisteredEcodeComponent[]> {
    const definitions = (await this.getCalls())
      .filter(call => call.kind === 'definition' && call.appId === appId);
    const grouped = new Map<string, IndexedEcodeComponentCall[]>();
    for (const definition of definitions) {
      const calls = grouped.get(definition.name) ?? [];
      calls.push(definition);
      grouped.set(definition.name, calls);
    }
    return [...grouped.entries()]
      .map(([name, calls]) => ({
        appId,
        name,
        definitions: calls,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getSnapshot(
    sourceRoot: string,
  ): Promise<readonly IndexedEcodeComponentCall[]> {
    await this.ready;
    const root = path.resolve(sourceRoot);
    return this.currentCalls()
      .filter(call =>
        call.uri.scheme === 'file'
        && isInside(root, path.resolve(call.uri.fsPath)))
      .sort(compareCalls);
  }

  async refreshSourceRoot(sourceRoot: string): Promise<void> {
    await this.ready;
    const root = path.resolve(sourceRoot);
    this.sourceRoots = uniqueSourceRoots([...this.sourceRoots, root]);
    const fileUris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(sourceRoot, SOURCE_GLOB),
      EXCLUDE_GLOB,
    );
    const discovered = new Set(fileUris.map(uri => uri.toString()));
    await Promise.all(fileUris.map(uri => this.loadFile(uri, true)));

    const staleUris = [...this.callsByUri.keys()]
      .map(key => vscode.Uri.parse(key))
      .filter(uri =>
        uri.scheme === 'file'
        && isInside(root, path.resolve(uri.fsPath))
        && !discovered.has(uri.toString()));
    for (const uri of staleUris) {
      try {
        await vscode.workspace.fs.stat(uri);
        await this.loadFile(uri, true);
      } catch {
        this.removeUri(uri);
      }
    }
  }

  setSourceRoots(sourceRoots: readonly string[]): void {
    this.sourceRoots = uniqueSourceRoots(sourceRoots);
  }

  async getDefinitions(
    call: EcodeComponentCall,
    sourceUri?: vscode.Uri,
  ): Promise<vscode.Location[]> {
    const available = this.findDefinitions(call, sourceUri);
    if (available.length > 0) {
      return available;
    }
    await this.ready;
    return this.findDefinitions(call, sourceUri);
  }

  async getReferences(
    call: EcodeComponentCall,
    includeDeclaration: boolean,
    sourceUri?: vscode.Uri,
  ): Promise<vscode.Location[]> {
    await this.ready;
    return this.callsForSource(sourceUri)
      .filter(candidate =>
        sameComponent(candidate, call)
        && (includeDeclaration || candidate.kind === 'reference'))
      .map(candidate => new vscode.Location(candidate.uri, candidate.range));
  }

  private findDefinitions(
    call: EcodeComponentCall,
    sourceUri?: vscode.Uri,
  ): vscode.Location[] {
    return this.callsForSource(sourceUri)
      .filter(candidate =>
        candidate.kind === 'definition'
        && sameComponent(candidate, call))
      .map(candidate => new vscode.Location(candidate.uri, candidate.range));
  }

  private async initialize(): Promise<void> {
    const fileUris = await vscode.workspace.findFiles(
      SOURCE_GLOB,
      EXCLUDE_GLOB,
    );
    await Promise.all(fileUris.map(uri => this.loadFile(uri, false)));
  }

  private async refreshFile(uri: vscode.Uri): Promise<void> {
    await this.loadFile(uri, true);
  }

  private async loadFile(
    uri: vscode.Uri,
    incrementRevision: boolean,
  ): Promise<void> {
    const key = uri.toString();
    const revision = incrementRevision
      ? this.bumpRevision(key)
      : this.uriRevisions.get(key) ?? 0;
    try {
      const document = vscode.workspace.textDocuments
        .find(candidate => candidate.uri.toString() === key);
      const source = document && isSourceDocument(document)
        ? document.getText()
        : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      if ((this.uriRevisions.get(key) ?? 0) === revision) {
        this.setCalls(key, indexCalls(uri, source));
      }
    } catch {
      if ((this.uriRevisions.get(key) ?? 0) === revision) {
        if (this.callsByUri.delete(key)) {
          this.changed.fire();
        }
      }
    }
  }

  private updateDocument(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    this.bumpRevision(key);
    this.setCalls(key, indexCalls(document.uri, document.getText()));
  }

  private removeUri(uri: vscode.Uri): void {
    const key = uri.toString();
    this.bumpRevision(key);
    if (this.callsByUri.delete(key)) {
      this.changed.fire();
    }
  }

  private bumpRevision(key: string): number {
    const revision = (this.uriRevisions.get(key) ?? 0) + 1;
    this.uriRevisions.set(key, revision);
    return revision;
  }

  private setCalls(
    key: string,
    calls: readonly IndexedEcodeComponentCall[],
  ): void {
    const previous = this.callsByUri.get(key) ?? [];
    if (calls.length > 0) {
      this.callsByUri.set(key, calls);
    } else {
      this.callsByUri.delete(key);
    }
    if (!sameCalls(previous, calls)) {
      this.changed.fire();
    }
  }

  private async getCalls(): Promise<readonly IndexedEcodeComponentCall[]> {
    await this.ready;
    return this.currentCalls();
  }

  private currentCalls(): readonly IndexedEcodeComponentCall[] {
    return [...this.callsByUri.values()].flat();
  }

  private callsForSource(
    sourceUri?: vscode.Uri,
  ): readonly IndexedEcodeComponentCall[] {
    if (sourceUri?.scheme !== 'file') {
      return this.currentCalls();
    }
    const sourcePath = path.resolve(sourceUri.fsPath);
    const sourceRoot = this.sourceRoots.find(root =>
      isInside(root, sourcePath));
    return sourceRoot
      ? this.currentCalls().filter(call =>
        call.uri.scheme === 'file'
        && isInside(sourceRoot, path.resolve(call.uri.fsPath)))
      : this.currentCalls();
  }
}

function uniqueSourceRoots(sourceRoots: readonly string[]): string[] {
  return [...new Set(sourceRoots.map(sourceRoot => path.resolve(sourceRoot)))]
    .sort((left, right) => right.length - left.length);
}

function sameCalls(
  left: readonly IndexedEcodeComponentCall[],
  right: readonly IndexedEcodeComponentCall[],
): boolean {
  return left.length === right.length
    && left.every((call, index) => {
      const candidate = right[index];
      return candidate !== undefined
        && call.kind === candidate.kind
        && call.appId === candidate.appId
        && call.name === candidate.name
        && call.nameRange.start === candidate.nameRange.start
        && call.nameRange.end === candidate.nameRange.end;
    });
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== '..'
      && !path.isAbsolute(relative));
}

function compareCalls(
  left: IndexedEcodeComponentCall,
  right: IndexedEcodeComponentCall,
): number {
  return left.appId.localeCompare(right.appId)
    || left.name.localeCompare(right.name)
    || left.kind.localeCompare(right.kind)
    || left.uri.fsPath.localeCompare(right.uri.fsPath)
    || left.range.start.line - right.range.start.line
    || left.range.start.character - right.range.start.character;
}

function isSourceDocument(document: vscode.TextDocument): boolean {
  return SOURCE_LANGUAGES.has(document.languageId)
    && (document.uri.scheme === 'file' || document.uri.scheme === 'untitled');
}

function sameComponent(
  left: EcodeComponentCall,
  right: EcodeComponentCall,
): boolean {
  return left.appId === right.appId && left.name === right.name;
}

function indexCalls(
  uri: vscode.Uri,
  source: string,
): readonly IndexedEcodeComponentCall[] {
  return parseEcodeComponentCalls(source).map(call => ({
    ...call,
    uri,
    range: rangeAtOffsets(source, call.nameRange.start, call.nameRange.end),
  }));
}

function rangeAtOffsets(
  source: string,
  start: number,
  end: number,
): vscode.Range {
  return new vscode.Range(
    positionAtOffset(source, start),
    positionAtOffset(source, end),
  );
}

function positionAtOffset(source: string, offset: number): vscode.Position {
  const prefix = source.slice(0, offset);
  const line = (prefix.match(/\n/g) ?? []).length;
  const lastLineBreak = prefix.lastIndexOf('\n');
  return new vscode.Position(
    line,
    offset - (lastLineBreak + 1),
  );
}
