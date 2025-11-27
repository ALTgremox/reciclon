// store.js — mini store reactivo
const subs = new Set();

export const store = {
  state: {
    myId: null,
    lobby: null,   // { code, players, hostId, started }
    game: null,    // snapshot de state del servidor
    hand: [],      // cartas del cliente
    accent: '#22c55e'
  },
  set(patch) {
    Object.assign(this.state, patch);
    subs.forEach(fn => fn(this.state));
  },
  subscribe(fn) {
    subs.add(fn);
    // devuelve un unsubscribe
    return () => subs.delete(fn);
  }
};


