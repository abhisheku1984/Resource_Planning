// Windows / private server transport. The static Pages build substitutes a
// dedicated in-tab worker here; it never falls back to the network API.
export const request = (...args) => fetch(...args);
// The explicit repository entry must prompt even if another tab has a session.
// Reading /login doesn't log that tab out or revoke anything on the server.
export const atLoginEntry = () => /^\/login\/?$/.test(location.pathname);
export const readToken = () => atLoginEntry() ? null : localStorage.getItem('rp.token') || null;
export function storeToken(token) {
  if (token) localStorage.setItem('rp.token', token);
  else localStorage.removeItem('rp.token');
}
