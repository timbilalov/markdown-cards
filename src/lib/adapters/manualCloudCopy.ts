import type { StorageDescriptor } from '../server/cloud/storageRegistry';
import type { NoteStorage } from '../ports/noteStorage';
import type { CloudWriteResult } from '../ports/cloudStorage';
import { checkIsMarkdownFilename } from '../domain/markdownFilename';
import { cloudRequestSignal } from '../utils/cloudRequestSignal';
import { expireSession, sessionGeneration } from '../stores/sessionState';

export async function copyCloudNote(
  descriptor: StorageDescriptor,
  input: Parameters<NoteStorage['copy']>[0]
): Promise<CloudWriteResult> {
  const captured = structuredClone({ descriptor, input });
  const { path, source, expectedTarget } = captured.input;
  if (!checkIsMarkdownFilename(path)) return { status: 'invalid', reason: 'invalid-path' };
  if (typeof source !== 'string' || !source.isWellFormed())
    return { status: 'invalid', reason: 'invalid-source' };
  const body = new TextEncoder().encode(source);
  if (body.byteLength > 1024 * 1024) return { status: 'invalid', reason: 'invalid-source' };
  const headers: Record<string, string> = {
    'Content-Type': 'text/markdown;charset=utf-8',
    'X-Storage-Context': captured.descriptor.contextId
  };
  if (expectedTarget.status === 'missing') headers['X-Create-Only'] = 'true';
  else {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(expectedTarget.source)
    );
    headers['X-Expected-Source-Hash'] = Array.from(new Uint8Array(digest), byte =>
      byte.toString(16).padStart(2, '0')
    ).join('');
    if (expectedTarget.revision !== null) headers['X-Expected-Revision'] = expectedTarget.revision;
  }
  const authentication = sessionGeneration();
  const unknown: CloudWriteResult = {
    status: 'unavailable',
    reason: 'network',
    outcome: 'unknown'
  };
  try {
    const response = await fetch(
      `/api/storages/${captured.descriptor.id}/copy?path=${encodeURIComponent(path)}`,
      {
        method: 'POST',
        headers,
        body,
        signal: cloudRequestSignal()
      }
    );
    if (response.status === 401) expireSession(authentication);
    if (response.status === 401 || response.status === 403)
      return { status: 'unavailable', reason: 'auth', outcome: 'not-written' };
    const value = await response.json();
    if (!response.ok)
      return value?.outcome === 'not-written'
        ? { status: 'unavailable', reason: 'remote', outcome: 'not-written' }
        : unknown;
    if (
      value?.status === 'written' &&
      (value.revision === null || (typeof value.revision === 'string' && value.revision.trim()))
    ) {
      if (captured.descriptor.capabilities.revisions && value.revision === null) return unknown;
      return { status: 'written', revision: value.revision };
    }
    if (value?.status === 'conflict') return { status: 'conflict' };
    if (
      value?.status === 'unsupported' &&
      ['create-only', 'conditional-update'].includes(value.operation)
    )
      return { status: 'unsupported', operation: value.operation };
    if (
      value?.status === 'invalid' &&
      ['invalid-create-only', 'invalid-path', 'invalid-source', 'invalid-revision'].includes(
        value.reason
      )
    )
      return { status: 'invalid', reason: value.reason };
    if (
      value?.status === 'unavailable' &&
      ['auth', 'network', 'remote', 'invalid-response'].includes(value.reason) &&
      ['not-written', 'unknown'].includes(value.outcome)
    )
      return { status: 'unavailable', reason: value.reason, outcome: value.outcome };
    return unknown;
  } catch {
    return unknown;
  }
}
