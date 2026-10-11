import { stateField } from './appState';
import { get } from 'svelte/store';

export const isAuthenticated = stateField('authenticated');
let generation = 0;
let delivery = new AbortController();
export function sessionGeneration(): number { return generation; }
export function sessionDeliverySignal(): AbortSignal { return delivery.signal; }
export function expireSession(requestGeneration: number): void {
  if (requestGeneration === generation) setAuthenticationStatus(false);
}
// Rechecking the current cookie is not a new login and must not cancel a Save.
export function confirmAuthenticationStatus(authenticated: boolean): void {
  if (generation === 0 || authenticated !== get(isAuthenticated)) setAuthenticationStatus(authenticated);
}
// Explicit login/logout establishes a new period, including login while the
// client still displays true for an older cookie.
export function setAuthenticationStatus(authenticated: boolean): void {
  generation++;
  delivery.abort(); delivery = new AbortController();
  if (!authenticated) delivery.abort();
  isAuthenticated.set(authenticated);
}
