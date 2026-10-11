// Model exclusive ownership shared by all clients in a test browser.
export function installWebLocks(): void {
  let locked = false;
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    async request(_name: string, _options: unknown, run: (lock: object | null) => Promise<unknown>) {
      if (locked) return run(null);
      locked = true;
      try { return await run({ name: 'markdown-cards-sync' }); } finally { locked = false; }
    }
  } });
}
