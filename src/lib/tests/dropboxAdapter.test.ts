// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DropboxAdapter } from '../server/cloud/dropboxAdapter';
import { mockHttp } from './helpers/http';

const options = {
  appKey: 'test-app',
  appSecret: 'private-secret',
  refreshToken: 'private-refresh',
  rootPath: '/Notes'
};
let http: ReturnType<typeof mockHttp>;

function metadata(name = 'note.md', rev = 'rev-a') {
  return {
    '.tag': 'file',
    name,
    path_lower: `/notes/${name.toLowerCase()}`,
    path_display: `/Notes/${name}`,
    id: 'id:file',
    rev,
    server_modified: '2026-10-19T00:00:00Z',
    size: 3
  };
}

beforeEach(() => {
  http = mockHttp();
  http.on('POST', 'https://api.dropboxapi.com/oauth2/token', () =>
    Response.json({ access_token: 'short-token', token_type: 'bearer', expires_in: 3600 })
  );
});

afterEach(() => http.assertHandled());

describe('Dropbox: server-only refresh authentication, exact bytes, complete listings and CAS', () => {
  it('advertises revisions, atomic write conditions and case-insensitive paths', () => {
    expect(new DropboxAdapter(options).getCapabilities()).toEqual({
      revisions: true,
      conditionalCreate: true,
      conditionalUpdate: true,
      caseSensitivePaths: false
    });
  });

  it('refreshes a token in the body and completes pagination, filtering folders/non-Markdown', async () => {
    http.on('POST', 'https://api.dropboxapi.com/2/files/list_folder', init => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ path: '/Notes', recursive: false });
      return Response.json({
        entries: [metadata(), { '.tag': 'folder', name: 'Folder', path_lower: '/notes/folder' }],
        cursor: 'next',
        has_more: true
      });
    });
    http.on('POST', 'https://api.dropboxapi.com/2/files/list_folder/continue', () =>
      Response.json({ entries: [metadata('other.md')], cursor: 'done', has_more: false })
    );
    expect(await new DropboxAdapter(options).list()).toEqual({
      status: 'success',
      entries: [
        { path: 'note.md', revision: 'rev-a', modifiedAt: Date.parse('2026-10-19T00:00:00Z') },
        { path: 'other.md', revision: 'rev-a', modifiedAt: Date.parse('2026-10-19T00:00:00Z') }
      ]
    });
    const auth = new URLSearchParams(String(http.fetch.mock.calls[0][1]?.body));
    expect(Object.fromEntries(auth)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'private-refresh',
      client_id: 'test-app',
      client_secret: 'private-secret'
    });
    expect(new Headers(http.fetch.mock.calls[1][1]?.headers).get('Authorization')).toBe(
      'Bearer short-token'
    );
  });

  it('does not publish a partial listing when continuation fails', async () => {
    http.on('POST', 'https://api.dropboxapi.com/2/files/list_folder', () =>
      Response.json({ entries: [metadata()], cursor: 'next', has_more: true })
    );
    http.on(
      'POST',
      'https://api.dropboxapi.com/2/files/list_folder/continue',
      () => new Response(null, { status: 503 })
    );
    expect(await new DropboxAdapter(options).list()).toEqual({
      status: 'unavailable',
      reason: 'remote'
    });
  });

  it('rejects case-colliding listing entries', async () => {
    http.on('POST', 'https://api.dropboxapi.com/2/files/list_folder', () =>
      Response.json({
        entries: [metadata('Note.md'), metadata('note.md')],
        cursor: 'x',
        has_more: false
      })
    );
    expect(await new DropboxAdapter(options).list()).toEqual({
      status: 'unavailable',
      reason: 'invalid-response'
    });
  });

  it('rejects a repeated pagination cursor instead of looping or returning a partial list', async () => {
    http.on('POST', 'https://api.dropboxapi.com/2/files/list_folder', () =>
      Response.json({ entries: [metadata()], cursor: 'same', has_more: true })
    );
    http.on('POST', 'https://api.dropboxapi.com/2/files/list_folder/continue', () =>
      Response.json({ entries: [], cursor: 'same', has_more: true })
    );
    expect(await new DropboxAdapter(options).list()).toEqual({
      status: 'unavailable',
      reason: 'invalid-response'
    });
  });

  it('reuses an unexpired token within one connection', async () => {
    http.on('POST', 'https://api.dropboxapi.com/2/files/list_folder', () =>
      Response.json({ entries: [], cursor: 'end', has_more: false })
    );
    const adapter = new DropboxAdapter(options);
    expect(await adapter.list()).toEqual({ status: 'success', entries: [] });
    expect(await adapter.list()).toEqual({ status: 'success', entries: [] });
    expect(
      http.fetch.mock.calls.filter(([url]) => String(url).endsWith('/oauth2/token'))
    ).toHaveLength(1);
  });

  it('refreshes an expired token', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    http.on('POST', 'https://api.dropboxapi.com/2/files/list_folder', () =>
      Response.json({ entries: [], cursor: 'end', has_more: false })
    );
    const adapter = new DropboxAdapter(options);
    await adapter.list();
    now.mockReturnValue(3600 * 1000);
    await adapter.list();
    expect(
      http.fetch.mock.calls.filter(([url]) => String(url).endsWith('/oauth2/token'))
    ).toHaveLength(2);
  });

  it('reads exact Unicode/BOM/CRLF and retains the returned revision', async () => {
    const source = '\uFEFF# Заметка\r\n✓\r\n';
    http.on(
      'POST',
      'https://content.dropboxapi.com/2/files/download',
      () =>
        new Response(source, {
          headers: { 'Dropbox-API-Result': JSON.stringify({ ...metadata(), '.tag': undefined }) }
        })
    );
    expect(await new DropboxAdapter(options).read('note.md')).toEqual({
      status: 'found',
      document: { path: 'note.md', source, revision: 'rev-a' }
    });
  });

  it('only interprets an explicit path/not_found as absence', async () => {
    http.on('POST', 'https://content.dropboxapi.com/2/files/download', () =>
      Response.json({ error: { '.tag': 'path', path: { '.tag': 'not_found' } } }, { status: 409 })
    );
    expect(await new DropboxAdapter(options).read('note.md')).toEqual({ status: 'not-found' });
  });

  it('does not confuse other download errors with absence', async () => {
    http.on('POST', 'https://content.dropboxapi.com/2/files/download', () =>
      Response.json({ error: { '.tag': 'path', path: { '.tag': 'not_file' } } }, { status: 409 })
    );
    expect(await new DropboxAdapter(options).read('note.md')).toEqual({
      status: 'unavailable',
      reason: 'remote'
    });
  });

  it('rejects invalid UTF-8 rather than replacing source bytes', async () => {
    http.on(
      'POST',
      'https://content.dropboxapi.com/2/files/download',
      () =>
        new Response(new Uint8Array([255]), {
          headers: { 'Dropbox-API-Result': JSON.stringify({ ...metadata(), '.tag': undefined }) }
        })
    );
    expect(await new DropboxAdapter(options).read('note.md')).toEqual({
      status: 'unavailable',
      reason: 'invalid-response'
    });
  });

  it('classifies a failed download connection as network unavailable', async () => {
    http.on('POST', 'https://content.dropboxapi.com/2/files/download', () => {
      throw new TypeError('offline');
    });
    expect(await new DropboxAdapter(options).read('note.md')).toEqual({
      status: 'unavailable',
      reason: 'network'
    });
  });

  it('bounds downloaded source size', async () => {
    http.on(
      'POST',
      'https://content.dropboxapi.com/2/files/download',
      () =>
        new Response('x'.repeat(1024 * 1024 + 1), {
          headers: { 'Dropbox-API-Result': JSON.stringify({ ...metadata(), '.tag': undefined }) }
        })
    );
    expect(await new DropboxAdapter(options).read('note.md')).toEqual({
      status: 'unavailable',
      reason: 'invalid-response'
    });
  });

  it('rejects metadata from another root rather than attributing its source to the requested note', async () => {
    http.on(
      'POST',
      'https://content.dropboxapi.com/2/files/download',
      () =>
        new Response('wrong', {
          headers: {
            'Dropbox-API-Result': JSON.stringify({ ...metadata(), path_lower: '/other/note.md' })
          }
        })
    );
    expect(await new DropboxAdapter(options).read('note.md')).toEqual({
      status: 'unavailable',
      reason: 'invalid-response'
    });
  });

  it('writes Unicode filenames through an ASCII JSON header with exact source bytes and no autorename', async () => {
    const source = '# Точный текст\r\n';
    http.on('POST', 'https://content.dropboxapi.com/2/files/upload', init => {
      const arg = new Headers(init?.headers).get('Dropbox-API-Arg')!;
      expect(arg).not.toMatch(/[^\x00-\x7f]/);
      expect(JSON.parse(arg)).toMatchObject({
        path: '/Notes/Заметка.md',
        mode: 'add',
        autorename: false,
        strict_conflict: true
      });
      expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe(source);
      return Response.json({ ...metadata('Заметка.md', 'rev-new'), '.tag': undefined });
    });
    expect(
      await new DropboxAdapter(options).write({ path: 'Заметка.md', source, createOnly: true })
    ).toEqual({ status: 'written', revision: 'rev-new' });
  });

  it('uses update(rev) for atomic compare-and-swap', async () => {
    http.on('POST', 'https://content.dropboxapi.com/2/files/upload', init => {
      expect(JSON.parse(new Headers(init?.headers).get('Dropbox-API-Arg')!)).toMatchObject({
        mode: { '.tag': 'update', update: 'expected' },
        strict_conflict: true
      });
      return Response.json(metadata('note.md', 'new'));
    });
    expect(
      await new DropboxAdapter(options).write({
        path: 'note.md',
        source: 'exact',
        expectedRevision: 'expected'
      })
    ).toEqual({ status: 'written', revision: 'new' });
  });

  it('preserves conflict separately from other 409 failures', async () => {
    http.on('POST', 'https://content.dropboxapi.com/2/files/upload', () =>
      Response.json(
        {
          error: {
            '.tag': 'path',
            path: {
              reason: { '.tag': 'conflict', conflict: { '.tag': 'file' } },
              upload_session_id: 'session'
            }
          }
        },
        { status: 409 }
      )
    );
    expect(
      await new DropboxAdapter(options).write({
        path: 'note.md',
        source: 'exact',
        expectedRevision: 'old'
      })
    ).toEqual({ status: 'conflict' });
  });

  it('keeps a non-conflict upload 409 as a known rejection rather than a content conflict', async () => {
    http.on('POST', 'https://content.dropboxapi.com/2/files/upload', () =>
      Response.json(
        {
          error: {
            '.tag': 'path',
            path: {
              reason: { '.tag': 'insufficient_space' },
              upload_session_id: 'session'
            }
          }
        },
        { status: 409 }
      )
    );
    expect(await new DropboxAdapter(options).write({ path: 'note.md', source: 'exact' })).toEqual({
      status: 'unavailable',
      reason: 'remote',
      outcome: 'not-written'
    });
  });

  it('does not retry an upload whose response was lost', async () => {
    http.on('POST', 'https://content.dropboxapi.com/2/files/upload', () => {
      throw new TypeError('lost acknowledgement');
    });
    expect(await new DropboxAdapter(options).write({ path: 'note.md', source: 'exact' })).toEqual({
      status: 'unavailable',
      reason: 'network',
      outcome: 'unknown'
    });
    expect(
      http.fetch.mock.calls.filter(([url]) => String(url).includes('/files/upload'))
    ).toHaveLength(1);
  });

  it('keeps a malformed successful upload acknowledgement uncertain', async () => {
    http.on('POST', 'https://content.dropboxapi.com/2/files/upload', () =>
      Response.json({ wrong: true })
    );
    expect(await new DropboxAdapter(options).write({ path: 'note.md', source: 'exact' })).toEqual({
      status: 'unavailable',
      reason: 'invalid-response',
      outcome: 'unknown'
    });
  });

  it('does not acknowledge an upload of a different file', async () => {
    http.on('POST', 'https://content.dropboxapi.com/2/files/upload', () =>
      Response.json(metadata('other.md'))
    );
    expect(await new DropboxAdapter(options).write({ path: 'note.md', source: 'exact' })).toEqual({
      status: 'unavailable',
      reason: 'invalid-response',
      outcome: 'unknown'
    });
  });

  it('rejects contradictory create and update conditions before authentication', async () => {
    expect(
      await new DropboxAdapter(options).write({
        path: 'note.md',
        source: 'exact',
        createOnly: true,
        expectedRevision: 'rev'
      })
    ).toEqual({ status: 'invalid', reason: 'invalid-revision' });
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('keeps an OAuth failure known-not-written', async () => {
    http.on(
      'POST',
      'https://api.dropboxapi.com/oauth2/token',
      () => new Response(null, { status: 400 })
    );
    expect(await new DropboxAdapter(options).write({ path: 'note.md', source: 'exact' })).toEqual({
      status: 'unavailable',
      reason: 'auth',
      outcome: 'not-written'
    });
  });

  it('verifies account and folder identity from provider responses', async () => {
    http.on('POST', 'https://api.dropboxapi.com/2/users/get_current_account', () =>
      Response.json({
        account_id: 'dbid:verified',
        root_info: { root_namespace_id: 'team', home_namespace_id: 'namespace' }
      })
    );
    http.on('POST', 'https://api.dropboxapi.com/2/files/get_metadata', () =>
      Response.json({ '.tag': 'folder', id: 'id:folder', path_lower: '/notes' })
    );
    expect(await new DropboxAdapter(options).identify()).toEqual({
      status: 'success',
      identity: {
        provider: 'dropbox',
        accountId: 'dbid:verified',
        rootId: JSON.stringify(['test-app', 'namespace', 'id:folder', '/notes'])
      }
    });
  });

  it('binds identity to the served home namespace, independently of team root', async () => {
    let home = 'home-1';
    let team = 'team-1';
    http.on('POST', 'https://api.dropboxapi.com/2/users/get_current_account', () =>
      Response.json({
        account_id: 'account',
        root_info: { root_namespace_id: team, home_namespace_id: home }
      })
    );
    http.on('POST', 'https://api.dropboxapi.com/2/files/get_metadata', () =>
      Response.json({ '.tag': 'folder', id: 'folder', path_lower: '/notes' })
    );
    const adapter = new DropboxAdapter(options);
    const before = await adapter.identify();
    team = 'team-2';
    expect(await adapter.identify()).toEqual(before);
    home = 'home-2';
    expect(await adapter.identify()).not.toEqual(before);
  });

  it.each([
    { '.tag': 'file', id: 'id:file', path_lower: '/notes' },
    { '.tag': 'folder', id: 'id:folder', path_lower: '/other' }
  ])('rejects identity metadata unrelated to the configured folder %j', async folder => {
    http.on('POST', 'https://api.dropboxapi.com/2/users/get_current_account', () =>
      Response.json({
        account_id: 'dbid:verified',
        root_info: { root_namespace_id: 'team', home_namespace_id: 'namespace' }
      })
    );
    http.on('POST', 'https://api.dropboxapi.com/2/files/get_metadata', () => Response.json(folder));
    expect(await new DropboxAdapter(options).identify()).toEqual({
      status: 'unavailable',
      reason: 'invalid-response'
    });
  });

  it.each([{ account_id: 'dbid:x' }, { root_info: { root_namespace_id: 'ns' } }])(
    'rejects incomplete account identity %j',
    async account => {
      http.on('POST', 'https://api.dropboxapi.com/2/users/get_current_account', () =>
        Response.json(account)
      );
      expect(await new DropboxAdapter(options).identify()).toEqual({
        status: 'unavailable',
        reason: 'invalid-response'
      });
    }
  );

  it.each(['../outside.md', 'sub/note.md', '.md'])(
    'rejects invalid path %j before authentication',
    async path => {
      expect(await new DropboxAdapter(options).read(path)).toEqual({
        status: 'invalid',
        reason: 'invalid-path'
      });
      expect(http.fetch).not.toHaveBeenCalled();
    }
  );

  it.each([{ appKey: '' }, { appSecret: '\r\n' }, { refreshToken: '' }, { rootPath: '/a/../b' }])(
    'rejects invalid config %j without secrets',
    overrides => {
      expect(() => new DropboxAdapter({ ...options, ...overrides })).toThrow(
        /^Invalid Dropbox configuration$/
      );
    }
  );
});
