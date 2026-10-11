import type { Handle, RequestEvent } from '@sveltejs/kit';
import { vi } from 'vitest';

type HandleInput = Parameters<Handle>[0];
type TestRequestStore = {
  event: RequestEvent;
  state: { tracing: { record_span<T>(options: { fn: (span: undefined) => T }): T } };
};

// SvelteKit 2.70 sequence() requires request-local tracing state. Use its real
// context runner; stub only tracing, never the production middleware sequence.
// This internal API is intentionally isolated here for future Kit upgrades.
export async function runHandle(handle: Handle, input: HandleInput): Promise<Response> {
  const { with_request_store } = await vi.importActual<{
    with_request_store<T>(store: TestRequestStore, callback: () => T): T;
  }>('@sveltejs/kit/internal/server');
  return with_request_store({
    event: input.event,
    state: { tracing: { record_span: ({ fn }) => fn(undefined) } }
  }, () => handle(input));
}
