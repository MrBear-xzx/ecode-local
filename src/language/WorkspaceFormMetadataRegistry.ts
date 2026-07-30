import * as path from 'path';
import * as vscode from 'vscode';
import { resolveEnvironmentSourceRoot } from '../domain/paths';
import { serverFingerprint, hashText } from '../domain/text';
import type {
  CachedFileFormMetadata,
  FormContext,
} from '../domain/formMetadata';
import type { ConnectionProfile } from '../domain/types';
import type { WorkspaceStore } from '../storage/WorkspaceStore';
import type { EcodeApiObject } from './knowledge';

export const ECODE_FORM_SCHEME = 'ecode-form';

export class WorkspaceFormMetadataRegistry implements vscode.Disposable {
  private syncRoot: string | undefined;
  private files = new Map<string, CachedFileFormMetadata>();
  private documents = new Map<string, CachedFileFormMetadata>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChangeDocument = this.changeEmitter.event;

  async reload(
    profile: ConnectionProfile | undefined,
    store: WorkspaceStore,
  ): Promise<void> {
    const previousDocumentIds = new Set(this.documents.keys());
    this.files.clear();
    this.documents.clear();
    this.syncRoot = profile
      ? resolveEnvironmentSourceRoot(
          profile.workspaceFolder,
          profile.environmentDirectory,
        )
      : undefined;
    if (profile && this.syncRoot) {
      const cache = await store.loadFormMetadataCache(
        serverFingerprint(profile.serverUrl, profile.username),
        this.syncRoot,
      );
      for (const [remotePath, file] of Object.entries(cache.files)) {
        this.files.set(normalizeLookupPath(remotePath), file);
        this.documents.set(this.documentId(file), file);
      }
    }

    for (const documentId of new Set([
      ...previousDocumentIds,
      ...this.documents.keys(),
    ])) {
      this.changeEmitter.fire(formDocumentUri(documentId));
    }
  }

  getFile(document: vscode.TextDocument | vscode.Uri): CachedFileFormMetadata | undefined {
    const uri = 'uri' in document ? document.uri : document;
    if (!this.syncRoot || uri.scheme !== 'file') {
      return undefined;
    }
    const relative = path.relative(this.syncRoot, uri.fsPath);
    if (
      !relative
      || relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      return undefined;
    }
    return this.files.get(normalizeLookupPath(relative));
  }

  getContexts(
    document: vscode.TextDocument | vscode.Uri,
    object: EcodeApiObject,
  ): FormContext[] {
    const file = this.getFile(document);
    if (!file || (object !== 'WfForm' && object !== 'ModeForm')) {
      return [];
    }
    const kind = object === 'WfForm' ? 'workflow' : 'mode';
    return file.contexts.filter(context =>
      context.kind === kind || context.kind === 'shared');
  }

  getFileByDocumentUri(uri: vscode.Uri): CachedFileFormMetadata | undefined {
    if (uri.scheme !== ECODE_FORM_SCHEME) {
      return undefined;
    }
    return this.documents.get(uri.path.split('/').at(-1)?.replace(/\.md$/, '') ?? '');
  }

  getDocumentUri(file: CachedFileFormMetadata): vscode.Uri {
    return formDocumentUri(this.documentId(file));
  }

  getSnapshot(): CachedFileFormMetadata[] {
    return [...this.files.values()]
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.files.clear();
    this.documents.clear();
  }

  private documentId(file: CachedFileFormMetadata): string {
    return hashText(`${file.remoteId}\0${file.path}`).slice(0, 32);
  }
}

function formDocumentUri(documentId: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: ECODE_FORM_SCHEME,
    path: `/${documentId}.md`,
  });
}

function normalizeLookupPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
