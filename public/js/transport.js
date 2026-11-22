// Windows / private server transport. The static Pages build substitutes a
// dedicated in-tab worker here; it never falls back to the network API.
export const request = (...args) => fetch(...args);
export const readToken = () => localStorage.getItem('rp.token') || null;
export function storeToken(token) {
  if (token) localStorage.setItem('rp.token', token);
  else localStorage.removeItem('rp.token');
}
