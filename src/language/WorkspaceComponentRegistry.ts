import * as vscode from 'vscode';
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
  private readonly callsByUri = new Map<
    string,
    readonly IndexedEcodeComponentCall[]
  >();
  private readonly uriRevisions = new Map<string, number>();
  private readonly ready: Promise<void>;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB);
    this.disposables = [
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

  async getDefinitions(
    call: EcodeComponentCall,
  ): Promise<vscode.Location[]> {
    const available = this.findDefinitions(call);
    if (available.length > 0) {
      return available;
    }
    await this.ready;
    return this.findDefinitions(call);
  }

  async getReferences(
    call: EcodeComponentCall,
    includeDeclaration: boolean,
  ): Promise<vscode.Location[]> {
    await this.ready;
    return this.currentCalls()
      .filter(candidate =>
        sameComponent(candidate, call)
        && (includeDeclaration || candidate.kind === 'reference'))
      .map(candidate => new vscode.Location(candidate.uri, candidate.range));
  }

  private findDefinitions(call: EcodeComponentCall): vscode.Location[] {
    return this.currentCalls()
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
        this.callsByUri.delete(key);
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
    this.callsByUri.delete(key);
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
    if (calls.length > 0) {
      this.callsByUri.set(key, calls);
    } else {
      this.callsByUri.delete(key);
    }
  }

  private async getCalls(): Promise<readonly IndexedEcodeComponentCall[]> {
    await this.ready;
    return this.currentCalls();
  }

  private currentCalls(): readonly IndexedEcodeComponentCall[] {
    return [...this.callsByUri.values()].flat();
  }
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
