const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

function uid(n=7){ return Math.random().toString(36).slice(2,2+n); }
function roomCode(){ 
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; 
  let c=''; 
  for(let i=0;i<5;i++) c+=chars[(Math.random()*chars.length)|0]; 
  return c; 
}

const rooms = {};

const TURN_MS = 30000; // 30 segundos por turno
// ---- Utilidad para enviar mensajes de log a todos los jugadores de una sala ----
function sendLog(room, text) {
  if (!room) return;
  io.in(room.code).emit('log', { text });
}


// ================== TURNOS CON TIEMPO ==================
function resetTurnTimer(room){
  if (!room) return;

  // Limpia timer previo si existiera
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }

  // Si la partida no está activa, no hacemos nada
  if (!room.started || !room.players || room.players.length === 0) return;

  const code = room.code;
  // Guardamos el momento en que termina el turno (para el cliente)
  room.turnDeadline = Date.now() + TURN_MS;

  room.turnTimer = setTimeout(() => {
    // Si en ese tiempo la partida terminó o se cerró la sala, salimos
    if (!room.started || !room.players || room.players.length === 0) return;

        const current = room.turn;
    const timedOutPlayer = room.players[current];

    // Pasamos al siguiente jugador
    room.turn = (room.turn + 1) % room.players.length;

    // Avisamos a todos que se acabó el tiempo de ese jugador
    io.in(code).emit('turnTimeout', { playerIndex: current });

    // Log compartido
    if (timedOutPlayer) {
      sendLog(room, `Se acabó el tiempo de ${timedOutPlayer.name}. Se pasó el turno al siguiente jugador.`);
    }

    // Enviamos nuevo estado y volvemos a armar el timer para el nuevo turno
    emitState(code);
    resetTurnTimer(room);
  }, TURN_MS + 100); // pequeño margen de seguridad
}

function clearTurnTimer(room){
  if (room && room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (room) {
    room.turnDeadline = null;
  }
}

// ================== NOMBRES ÚNICOS ==================
function makeUniqueName(room, rawName){
  const existing = room.players.map(p => p.name.toLowerCase());
  let base = (rawName || '').trim();

  // Si no escribió nada, usamos "Jugador" como base
  if (!base) {
    base = 'Jugador';
  }

  let candidate = base;
  let suffix = 2;

  // Evitar nombres repetidos dentro de la misma sala
  while (existing.includes(candidate.toLowerCase())) {
    candidate = `${base} ${suffix}`;
    suffix++;
  }

  return candidate;
}

// ================== SOCKET.IO ==================
io.on('connection', (socket)=>{

  // ----- Crear sala -----
  socket.on('createRoom', ({name, color})=>{
  // Si ya estaba en una sala, primero cerramos o abandonamos la anterior
    const oldCode = socket.data.room;
    if (oldCode && rooms[oldCode]) {
      const oldRoom = rooms[oldCode];

      if (oldRoom.hostId === socket.id) {
        // Era anfitrión: cerrar completamente la sala anterior
        io.in(oldCode).emit(
          'errorMsg',
          'La sala anterior se cerró porque el anfitrión creó una nueva sala.'
        );
        clearTurnTimer(oldRoom);
        delete rooms[oldCode];
      } else {
        // Era solo jugador: lo sacamos de la sala anterior
        const idx = oldRoom.players.findIndex(p => p.id === socket.id);
        if (idx >= 0) {
          oldRoom.players.splice(idx, 1);
          socket.leave(oldCode);

          if (oldRoom.players.length === 0) {
            clearTurnTimer(oldRoom);
            delete rooms[oldCode];
          } else {
            emitLobby(oldCode);
          }
        }
      }

      socket.data.room = null;
    }

    const code = roomCode();
    const room = rooms[code] = {
      code,
      hostId: socket.id,
      started: false,
      players: [],
      deck: [],
      discard: [],
      turn: 0,
      // 👇 estadísticas ambientales básicas
      stats: { reciclados: 0, contaminados: 0 },
      turnTimer: null,
      turnDeadline: null
    };

    const playerName = makeUniqueName(room, name);
    const player = {
      id: socket.id,
      name: playerName,
      color: color || '#22c55e',
      hand: [],
      body: [null, null, null, null],
      immune: false
    };

    room.players.push(player);
    socket.join(code);
    socket.data.room = code;
    emitLobby(code);
  });

  // ----- Unirse a sala -----
  socket.on('joinRoom', ({code, name, color})=>{
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];

    if (!room) return socket.emit('errorMsg', 'No existe la sala');
    if (room.started) return socket.emit('errorMsg', 'La partida ya empezó');
    if (room.players.length >= 5) return socket.emit('errorMsg', 'Sala llena (máximo 5)');

    // 1) Si YA está en esta sala, no lo duplicamos
    let existing = room.players.find(p => p.id === socket.id);
    if (existing) {
      // Si ahora sí manda nombre/color, puedes actualizarlo
      if (name && name.trim()) {
        existing.name = makeUniqueName(room, name.trim());
      }
      if (color) {
        existing.color = color;
      }

      socket.data.room = code;
      socket.join(code);
      emitLobby(code);
      return;
    }

    // 2) Si estaba en OTRA sala, lo sacamos de allí primero
    const oldCode = socket.data.room;
    if (oldCode && oldCode !== code && rooms[oldCode]) {
      const oldRoom = rooms[oldCode];
      const idx = oldRoom.players.findIndex(p => p.id === socket.id);
      if (idx >= 0) oldRoom.players.splice(idx, 1);
      socket.leave(oldCode);

      if (oldRoom.players.length === 0) {
        clearTurnTimer(oldRoom);
        delete rooms[oldCode];
      } else {
        emitLobby(oldCode);
      }
    }

    // 3) Ahora sí lo añadimos como nuevo jugador
    const playerName = makeUniqueName(room, name);
    const player = {
      id: socket.id,
      name: playerName,
      color: color || '#0ea5e9',
      hand: [],
      body: [null, null, null, null],
      immune: false
    };

    room.players.push(player);
    socket.join(code);
    socket.data.room = code;
    emitLobby(code);
  });


  // ----- Iniciar partida -----
  socket.on('startGame', ()=>{
    const code = socket.data.room; const room = rooms[code]; if(!room) return;
    if(room.hostId !== socket.id) return socket.emit('errorMsg','Solo el anfitrión puede iniciar');
    if(room.players.length < 2) return socket.emit('errorMsg','Mínimo 2 jugadores');
    setupGame(room);
    io.in(code).emit('gameStarted');

    // Log compartido
    sendLog(room, `La partida ha comenzado con ${room.players.length} jugadores.`);

    resetTurnTimer(room);      // ⏱ arrancamos el contador del primer turno
    emitState(code);
  });


  // ----- Jugar carta -----
  socket.on('playCard', ({handIndex, target})=>{
    const code = socket.data.room; 
    const room = rooms[code]; 
    if(!room || !room.started) return;

    const pIndex = room.players.findIndex(p=>p.id===socket.id);
    if(pIndex !== room.turn) 
      return socket.emit('errorMsg','No es tu turno');

    if(!handlePlay(room, pIndex, handIndex, target)) 
      return socket.emit('errorMsg','Jugada no permitida');

    drawToThree(room, pIndex);

    const winner = checkWinner(room);
    if (winner != null) {
      const winnerName = room.players[winner].name;
      io.in(code).emit('gameOver', { winnerIndex: winner, winnerName });
      sendLog(room, `La partida ha terminado. Ganó ${winnerName}.`);
      room.started = false;
      clearTurnTimer(room);   // 🔚 apagamos el cronómetro
      emitState(code);
      return;
    }


    room.turn = (room.turn + 1) % room.players.length;
    resetTurnTimer(room);     // ⏱ nuevo turno, nuevo cronómetro
  emitState(code);
  });

  // ----- Descartar cartas -----
  socket.on('discardCards', ({indices})=>{
    const code = socket.data.room; const room = rooms[code]; if(!room || !room.started) return;
    const pIndex = room.players.findIndex(p=>p.id===socket.id);
    if(pIndex !== room.turn) return socket.emit('errorMsg','No es tu turno');
    const player = room.players[pIndex];
    if(!Array.isArray(indices) || indices.length<1 || indices.length>3) return socket.emit('errorMsg','Puedes descartar 1 a 3 cartas');

    indices = Array.from(new Set(indices)).sort((a,b)=>b-a);
    for(const i of indices){
      if(player.hand[i]){
        room.discard.push(player.hand[i]);
        player.hand.splice(i,1);
      }
    }
    for(let i=0;i<indices.length;i++){
      draw(room, pIndex);
    }

    // Log compartido del descarte
    sendLog(room, `${player.name} descartó ${indices.length} carta(s).`);

    room.turn = (room.turn + 1) % room.players.length;
    resetTurnTimer(room);     // ⏱ después de descartar también corre el tiempo del siguiente
    emitState(code);
  });


  // ----- Pedir estado -----
  socket.on('requestState', ()=>{ 
    const code = socket.data.room; 
    if(code) emitState(code); 
  });

  // ----- Desconexión -----
  socket.on('disconnect', ()=>{
    const code = socket.data.room; 
    if(!code) return;

    const room = rooms[code]; 
    if(!room) return;

    const idx = room.players.findIndex(p=>p.id===socket.id);
    if(idx>=0){
      room.players.splice(idx,1);

      // Si la sala queda vacía, limpieza total
      if(room.players.length===0){
        clearTurnTimer(room);     
        delete rooms[code];
        return;
      }

      // 👇 Si la partida estaba iniciada y ahora solo queda un jugador,
      // lo declaramos ganador automático.
      if (room.started && room.players.length === 1) {
        const winnerIndex = 0;
        const winnerName  = room.players[0].name;

        io.in(code).emit('gameOver', {
          winnerIndex,
          winnerName,
          stats: room.stats || null
        });

        room.started = false;
        clearTurnTimer(room);
        emitState(code);
        return; // ya no hace falta reajustar turno/host
      }

      if(room.turn >= room.players.length) room.turn = 0;
      if(room.hostId === socket.id) room.hostId = room.players[0].id;
      if(room.started) resetTurnTimer(room);  // rearmar timer con la nueva cantidad de jugadores
    }

    emitLobby(code); 
    emitState(code);
  });

});

// ================== EMIT LOBBY / STATE ==================
function emitLobby(code){
  const room = rooms[code]; 
  if(!room) return;

  io.in(code).emit('lobby', {
    code: room.code,
    hostId: room.hostId,
    players: room.players.map(p=>({
      id: p.id, 
      name: p.name, 
      color: p.color
    })),
    started: room.started
  });
}

function emitState(code){
  const room = rooms[code]; 
  if(!room) return;

  const snapshot = {
    code: room.code,
    started: room.started,
    turn: room.turn,
    deckCount: room.deck.length,
    discardTop: room.discard[room.discard.length-1]||null,
    turnDeadline: room.turnDeadline || null,
    players: room.players.map(p=>({
      name: p.name,
      color: p.color,
      handCount: p.hand.length,
      body: p.body,
      immune: p.immune
    }))
    // podrías añadir aquí stats si quieres verlas en tiempo real:
    // stats: room.stats
  };

  io.in(code).emit('state', snapshot);
  room.players.forEach(p=> io.to(p.id).emit('yourHand', p.hand));
}

// ================== REGLAS DEL JUEGO ==================
function setupGame(room){
  room.deck = buildDeck(); 
  shuffle(room.deck);
  room.discard = []; 
  room.turn = 0; 
  room.started = true;

  // 👇 reset de stats al comenzar una nueva partida
  room.stats = { reciclados: 0, contaminados: 0 };

  room.players.forEach((p,i)=>{ 
    p.hand=[]; 
    p.body=[null,null,null,null]; 
    p.immune=false; 
    for(let k=0;k<3;k++) draw(room,i); 
  });
}

function buildDeck(){
  const deck=[];
  for(let i=0;i<5;i++) deck.push(card('organ','red','Peligrosos'));
  for(let i=0;i<5;i++) deck.push(card('organ','green','Aprovechables'));
  for(let i=0;i<5;i++) deck.push(card('organ','blue','Organicos'));
  for(let i=0;i<5;i++) deck.push(card('organ','yellow','No Aprovechables'));

  for(let i=0;i<4;i++) deck.push(card('virus','red','Contaminante de Peligrosos'));
  for(let i=0;i<4;i++) deck.push(card('virus','green','Contaminante de Aprovechables'));
  for(let i=0;i<4;i++) deck.push(card('virus','blue','Contaminante de Organicos'));
  for(let i=0;i<4;i++) deck.push(card('virus','yellow','Contaminante de No Aprovechables'));

  for(let i=0;i<4;i++) deck.push(card('medicine','red','Reciclable de Peligrosos'));
  for(let i=0;i<4;i++) deck.push(card('medicine','green','Reciclable de Aprovechables'));
  for(let i=0;i<4;i++) deck.push(card('medicine','blue','Reciclable de Organicos'));
  for(let i=0;i<4;i++) deck.push(card('medicine','yellow','Reciclable de No Aprovechables'));

  const treatments = [
    'Trasplante de contenedores',
    'Ladrón de contenedores',
    'Contagio',
    'Servicio de limpieza',
    'Error de limpieza'
  ];
  treatments.forEach(t=>{
    deck.push(card('treatment',null,t)); 
    deck.push(card('treatment',null,t)); 
  });

  return deck.map(c=>({...c, id: uid()}));
}

function card(type, color, name){ 
  return { type, color: color||null, name }; 
}

function shuffle(a){ 
  for(let i=a.length-1;i>0;i--){ 
    const j=(Math.random()*(i+1))|0; 
    [a[i],a[j]]=[a[j],a[i]]; 
  } 
}

function draw(room, pIndex){
  if(room.deck.length===0){
    if(room.discard.length===0) return null;
    room.deck = room.discard.splice(0, room.discard.length-1);
    shuffle(room.deck);
  }
  const card = room.deck.pop();
  room.players[pIndex].hand.push(card);
  return card;
}

function drawToThree(room, pIndex){ 
  while(room.players[pIndex].hand.length<3){ 
    if(!draw(room, pIndex)) break; 
  } 
}

function getBodyColors(body){
  const colors = []; 
  for(const slot of body){ 
    if(slot && slot.organ){ 
      const c=slot.organ.color; 
      if(c!=='wild' && !colors.includes(c)) colors.push(c);
    } 
  } 
  return colors;
}
function canPlaceOrgan(body, color){ 
  return color==='wild' ? true : !getBodyColors(body).includes(color); 
}

function handlePlay(room, pIndex, handIndex, target){
  const player = room.players[pIndex];
  const card   = player.hand[handIndex];
  if (!card) return false;

  // Aseguramos que exista estructura de stats
  if (!room.stats) {
    room.stats = { reciclados: 0, contaminados: 0 };
  }

  // --- Contenedores (organ) ---
  if (card.type === 'organ') {
    if (!target || target.playerIndex !== pIndex) return false;
    const s = target.slotIndex;
    if (s == null || s < 0 || s > 3) return false;
    if (player.body[s] !== null) return false;
    if (!canPlaceOrgan(player.body, card.color)) return false;

    player.body[s] = {
      organ: {
        color: card.color,
        infected: 0,
        vaccines: 0,
        immune: false
      }
    };

    room.discard.push(card);
    player.hand.splice(handIndex, 1);

    sendLog(room, `${player.name} colocó un contenedor ${card.color} en su espacio ${s + 1}.`);
    return true;
  }

  // --- Contaminante (virus) ---
  // --- Contaminante (virus) ---
  if (card.type === 'virus') {
    if (!target) return false;

    // No permitir infectar tus propios contenedores
    if (target.playerIndex === pIndex) return false;

    const tp = room.players[target.playerIndex];
    if (!tp) return false;
    const s = target.slotIndex;
    if (s == null || !tp.body[s] || !tp.body[s].organ) return false;

    const org = tp.body[s].organ;
    if (org.immune) return false;

    // Color debe ser compatible (salvo comodines)
    if (card.color !== 'wild' && org.color !== 'wild' && card.color !== org.color) return false;

    if (org.vaccines > 0) {
      // Un reciclaje previo bloquea la contaminación
      org.vaccines -= 1;
      sendLog(
        room,
        `${player.name} intentó contaminar un contenedor de ${tp.name} en el espacio ${s + 1}, ` +
        `pero el reciclaje previo lo protegió.`
      );
    } else {
      org.infected += 1;

      if (org.infected >= 2) {
        // El contenedor se pierde y el espacio queda vacío, pero NO se genera una carta especial
        tp.body[s] = null;

        room.stats.contaminados += 1;
        sendLog(
          room,
          `${player.name} contaminó totalmente un contenedor de ${tp.name} en el espacio ${s + 1}. ` +
          `El contenedor se perdió.`
        );
      } else {
        sendLog(
          room,
          `${player.name} contaminó un contenedor de ${tp.name} en el espacio ${s + 1}. ` +
          `Nivel de contaminación: x${org.infected}.`
        );
      }
    }

    room.discard.push(card);
    player.hand.splice(handIndex, 1);
    return true;
  }


  // --- Reciclable (medicine) ---
  if (card.type === 'medicine') {
    // Solo puedes reciclar tus propios contenedores
    if (!target || target.playerIndex !== pIndex) return false;

    const tp = room.players[target.playerIndex];
    if (!tp) return false;

    const s = target.slotIndex;
    if (s == null || !tp.body[s] || !tp.body[s].organ) return false;

    const org = tp.body[s].organ;
    const match = card.color === 'wild' || org.color === 'wild' || card.color === org.color;
    if (!match) return false;

    if (org.infected > 0) {
      // Quita un nivel de contaminación
      org.infected -= 1;
      room.stats.reciclados += 1;
      sendLog(
        room,
        `${player.name} redujo la contaminación de su contenedor en el espacio ${s + 1}. ` +
        `Nivel de contaminación ahora x${org.infected}.`
      );
    } else {
      // Añade un marcador de reciclaje / protección
      org.vaccines += 1;
      if (org.vaccines >= 2) {
        org.immune = true;
        sendLog(
          room,
          `${player.name} recicló y protegió por completo su contenedor en el espacio ${s + 1}. ` +
          `El contenedor quedó inmune.`
        );
      } else {
        sendLog(
          room,
          `${player.name} aplicó reciclaje a su contenedor en el espacio ${s + 1}. ` +
          `Marcadores de reciclaje: x${org.vaccines}.`
        );
      }
      room.stats.reciclados += 1;
    }

    room.discard.push(card);
    player.hand.splice(handIndex, 1);
    return true;
  }


  // --- Tratamientos especiales ---
  if (card.type === 'treatment') {
    const ok = applyTreatment(room, pIndex, card.name, target);
    if (!ok) return false;
    room.discard.push(card);
    player.hand.splice(handIndex, 1);
    // El log se hace dentro de applyTreatment
    return true;
  }

  return false;
}


function applyTreatment(room, pIndex, name, target){
  const me = room.players[pIndex];

  if (name === 'Trasplante de contenedores') {
    if (!target) return false;
    const A = room.players[target.fromPlayer];
    const B = room.players[target.toPlayer];
    if (!A || !B) return false;
    const sA = target.fromSlot, sB = target.toSlot;
    if (sA == null || sB == null) return false;
    if (!A.body[sA] || !A.body[sA].organ) return false;
    if (!B.body[sB] || !B.body[sB].organ) return false;
    if (A.body[sA].organ.immune || B.body[sB].organ.immune) return false;

    const tmp = A.body[sA];
    A.body[sA] = B.body[sB];
    B.body[sB] = tmp;

    sendLog(room, `${me.name} intercambió contenedores entre ${A.name} (espacio ${sA + 1}) y ${B.name} (espacio ${sB + 1}).`);
    return true;
  }

  if (name === 'Ladrón de contenedores') {
    if (!target) return false;
    const from = room.players[target.fromPlayer];
    if (!from) return false;
    const sFrom = target.fromSlot;
    const sTo   = target.toSlot;
    if (sFrom == null || sTo == null) return false;
    if (!from.body[sFrom] || !from.body[sFrom].organ) return false;

    const organ = from.body[sFrom].organ;
    if (organ.color !== 'wild' && !canPlaceOrgan(me.body, organ.color)) return false;
    if (me.body[sTo] !== null) return false;

    me.body[sTo] = { organ: { ...organ } };
    from.body[sFrom] = null;

    sendLog(room, `${me.name} robó un contenedor de ${from.name} y lo colocó en su espacio ${sTo + 1}.`);
    return true;
  }

  if (name === 'Contagio') {
    let moved = 0;
    for (let s = 0; s < 4; s++) {
      const slot = me.body[s];
      if (slot && slot.organ && slot.organ.infected > 0) {
        outer: for (let pi = 0; pi < room.players.length; pi++) {
          if (pi === pIndex) continue;
          const pl = room.players[pi];
          for (let sj = 0; sj < 4; sj++) {
            const t = pl.body[sj];
            if (!t || !t.organ) continue;
            if (t.organ.immune || t.organ.infected > 0 || t.organ.vaccines > 0) continue;
            const match = t.organ.color === 'wild' || slot.organ.color === 'wild' || t.organ.color === slot.organ.color;
            if (match) {
              slot.organ.infected -= 1;
              t.organ.infected += 1;
              moved++;
              break outer;
            }
          }
        }
      }
    }
    if (moved > 0) {
      room.stats.contaminados += moved;
      sendLog(room, `${me.name} propagó contaminación a otros contenedores (${moved} movimiento(s)).`);
      return true;
    }
    return false;
  }

  if (name === 'Servicio de limpieza') {
    for (let i = 0; i < room.players.length; i++) {
      if (i === pIndex) continue;
      const pl = room.players[i];
      room.discard.push(...pl.hand);
      pl.hand = [];
      for (let k = 0; k < 3; k++) draw(room, i);
    }
    sendLog(room, `${me.name} activó un servicio de limpieza: todos los jugadores reciclaron sus cartas de mano.`);
    return true;
  }

  if (name === 'Error de limpieza') {
    if (!target) return false;
    const other = room.players[target.playerIndex];
    if (!other) return false;

    const tmp = me.body;
    me.body = other.body;
    other.body = tmp;

    sendLog(room, `${me.name} intercambió todos sus contenedores con ${other.name} por un error de limpieza.`);
    return true;
  }

  return false;
}

function checkWinner(room){
  for(let i=0;i<room.players.length;i++){
    const pl = room.players[i];
    let colors = new Set();
    for(const slot of pl.body){
      if(slot && slot.organ){
        const o = slot.organ;
        const healthy = (o.infected===0) || o.vaccines>0 || o.immune;
        if(healthy){
          const c = o.color==='wild' ? uid(1) : o.color;
          colors.add(c);
        }
      }
    }
    if(colors.size >= 4) return i;
  }
  return null;
}

http.listen(PORT, ()=> console.log('Servidor escuchando en puerto', PORT));
