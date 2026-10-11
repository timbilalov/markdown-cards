import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, vi } from 'vitest';

let connections: IDBDatabase[] = [];
let unexpectedRequests: string[] = [];
const blockedFetch = () => vi.fn<typeof fetch>(async (input) => {
  // An explicit session check may receive a guest response without installing
  // a full HTTP fixture. Every other request must be registered by its test.
  if (String(input) === '/api/auth/status') return Response.json({ authenticated: false });
  unexpectedRequests.push(String(input));
  throw new Error('Unexpected HTTP request: install an explicit test response');
});
vi.stubGlobal('fetch', blockedFetch());

beforeEach(() => {
  unexpectedRequests = [];
  // A new database namespace per test, including tests that reload singletons.
  const factory = new IDBFactory();
  const open = factory.open.bind(factory);
  factory.open = (...args) => {
    const request = open(...args);
    request.addEventListener('success', () => connections.push(request.result));
    return request;
  };
  vi.stubGlobal('indexedDB', factory);
  vi.stubGlobal('fetch', blockedFetch());
  if (typeof window !== 'undefined') window.localStorage.clear();
});

afterEach(() => {
  for (const connection of connections) connection.close();
  connections = [];
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  expect(unexpectedRequests, 'Unexpected fetch calls caught by production code').toEqual([]);
});
