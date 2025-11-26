// socket.js — "singleton" de módulo para Socket.IO
export const socket = io(); // usa la global 'io' del script /socket.io/socket.io.js

export const on = (event, handler) => socket.on(event, handler);
export const emit = (event, payload, ack) => socket.emit(event, payload, ack);
