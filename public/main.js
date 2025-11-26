// main.js — orquesta UI + sockets + store
import { socket, on, emit } from './socket.js';
import { store } from './store.js';

// Helpers DOM
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

let lastTurnIndex = null;
let lastHandSize  = 0;
let turnCountdownInterval = null;
let nJug = 0;  // número de jugadores en sala

function playerNameByIndex(idx){
  return store.state?.game?.players?.[idx]?.name ?? `Jugador ${idx+1}`;
}

function slotLabel(i){ return `espacio ${ (i??0) + 1 }`; }

function announceTurnChange(snap){
  if (lastTurnIndex === snap.turn) return;
  lastTurnIndex = snap.turn;
  const name = playerNameByIndex(snap.turn);
  toast(`🕐 Turno de ${name}. Juega una carta o descarta 1–3.`, 2400);
}

function announceHandChange(newHand){
  const n = newHand?.length ?? 0;
  if (lastHandSize === 0 && n > 0) {
    toast(`🃏 Tu mano lista: ${n} carta(s).`);
  } else if (n > lastHandSize) {
    toast(`➕ Robaste ${n - lastHandSize} carta(s). Ahora tienes ${n}.`);
  } else if (n < lastHandSize) {
    toast(`➖ Jugaste/descartaste. Te quedan ${n} carta(s).`);
  }
  lastHandSize = n;
}

function startTurnCountdown(turnDeadline){
  if (turnCountdownInterval) {
    clearInterval(turnCountdownInterval);
    turnCountdownInterval = null;
  }

  const snap = store.state.game;
  const baseName = snap?.players?.[snap.turn]?.name || '—';

  if (!turnDeadline) {
    turnInfo.textContent = `Turno: ${baseName}`;
    return;
  }

  const update = () => {
    const game = store.state.game;
    const name = game?.players?.[game.turn]?.name || baseName;
    const now = Date.now();
    const msLeft = turnDeadline - now;
    const sec = Math.max(0, Math.ceil(msLeft / 1000));

    turnInfo.textContent = `Turno: ${name} · ${sec}s`;

    if (msLeft <= 0) {
      clearInterval(turnCountdownInterval);
      turnCountdownInterval = null;
    }
  };

  update();
  turnCountdownInterval = setInterval(update, 500);
}

function describeTarget(t){
  if (t == null) return 'objetivo';
  const who = (typeof t.playerIndex === 'number') ? playerNameByIndex(t.playerIndex) : 'jugador';
  const where = (typeof t.slotIndex === 'number') ? `, ${slotLabel(t.slotIndex)}` : '';
  return `${who}${where}`;
}

// Nodos
const screenHome  = $('#screen-home');
const screenLobby = $('#screen-lobby');
const screenGame  = $('#screen-game');

const createBtn   = $('#createBtn');
const joinBtn     = $('#joinBtn');
const startBtn    = $('#startBtn');
const roomInfo    = $('#roomInfo');
const roomCodeEl  = $('#roomCode');
const playersList = $('#playersList');
const deckCount   = $('#deckCount');
const boards      = $('#boards');
const handDiv     = $('#hand');
const actionHint  = $('#actionHint');
const turnInfo    = $('#turnInfo');
const badgeCode   = $('#badgeCode');
const discardDiv  = $('#discard');
const toastEl     = $('#toast');
const logEl       = $('#log');
const discardSel  = $('#discardSel');
const fullBtn     = $('#fullscreenBtn');
const rotateHint  = $('#rotateHint');

// botones de la pantalla inicial + tutorial + atrás
const homeCreateBtn   = $('#homeCreateBtn');
const homeJoinBtn     = $('#homeJoinBtn');
const homeTutorialBtn = $('#homeTutorialBtn');
const tutorialModal   = $('#tutorialModal');
const tutorialBackdrop= $('#tutorialBackdrop');
const tutorialClose   = $('#tutorialClose');
const backCreateBtn   = $('#createBackBtn');
const backJoinBtn     = $('#joinBackBtn');

// ====== FONDO CON IMÁGENES ======
function setBodyBg(mode) {
  const bg = document.getElementById("bg-layer");
  if (!bg) return;

  let imgPath;

  if (mode === "game") {
    imgPath = "images/fondo-game.jpeg";
  } else {
    imgPath = "images/fondo-lobby.jpeg";
  }

  bg.style.backgroundImage = `url('${imgPath}')`;
}

function hex2rgba(hex, a=1){
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '#22c55e');
  const r = parseInt(m?.[1] ?? '22',16), g = parseInt(m?.[2] ?? 'c5',16), b = parseInt(m?.[3] ?? '5e',16);
  return `rgba(${r},${g},${b},${a})`;
}

// ====== TOAST ======
function toast(msg, ms = 2200){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl.__t);
  toastEl.__t = setTimeout(()=> toastEl.classList.remove('show'), ms);
}

// Registro de eventos en el panel "log"
function addLog(text) {
  if (!logEl) return;
  const line = document.createElement('div');
  const time = new Date().toLocaleTimeString('es-PE', {
    hour: '2-digit',
    minute: '2-digit'
  });
  line.textContent = `[${time}] ${text}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight; // baja al final
}

function setActionHint(text){
  if (!actionHint) return;
  actionHint.textContent = text || '';
}

// ====== PANTALLAS ======
function showScreen(id){
  if (screenHome)  screenHome.classList.toggle('shown',  id === 'home');
  if (screenLobby) screenLobby.classList.toggle('shown', id === 'lobby');
  if (screenGame)  screenGame.classList.toggle('shown',  id === 'game');

  // mismo fondo para home/lobby, otro para game
  setBodyBg(id === 'game' ? 'game' : 'lobby');

  if (id === 'game') {
    emit('requestState');
  }
}

// ====== SOCKET EVENTS ======
on('connect', ()=> store.set({ myId: socket.id }));

on('errorMsg', m => {
  toast(m);
  if (m === 'No es tu turno' && store.state.game) {
    const snap = store.state.game;
    const name = snap.players[snap.turn]?.name || 'otro jugador';
    setActionHint(`Esperando el turno de ${name}…`);
  }
});

on('lobby', data => {
  roomInfo.classList.remove('hidden');
  roomCodeEl.textContent = data.code;
  playersList.replaceChildren(...data.players.map(p=> {
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    chip.textContent = p.name + (p.id === data.hostId ? ' (anfitrión)' : '');
    return chip;
  }));
  startBtn.style.display = (data.hostId === store.state.myId && !data.started) ? 'inline-block' : 'none';
  badgeCode.textContent = `Sala ${data.code}`;

  const me = data.players.find(p => p.id === store.state.myId);
  if (me?.color) store.set({ accent: me.color });

  store.set({ lobby: data });
  showScreen('lobby');
  setBodyBg('lobby', store.state.accent);

  const yo = store.state.myId;
  const soyHost = yo && data.hostId === yo;
  nJug = data.players.length;

  toast(`${soyHost ? '✅ Sala creada' : '✅ Te uniste'} a la sala ${data.code}. Jugadores ${nJug}/5. ${soyHost ? 'Cuando quieras, inicia la partida.' : 'Espera a que el anfitrión la inicie.'}`, 2800);
});

on('gameStarted', ()=> {
  showScreen('game');
  logEl.innerHTML = '';
  addLog('La partida ha comenzado.');
  setActionHint('Selecciona una carta para jugarla o descartarla.');
  toast(`🎮 ¡La partida comenzó! ${nJug} jugador(es). Se repartieron 3 cartas por jugador.`, 2600);
  emit('requestState');
});

on('state', snap => {
  store.set({ game: snap });
  deckCount.textContent = snap.deckCount;
  badgeCode.textContent = `Sala ${snap.code}`;
  renderBoards(snap);
  renderDiscard(snap);
  announceTurnChange(snap);

  if (snap.turnDeadline) {
    startTurnCountdown(snap.turnDeadline);
  } else {
    turnInfo.textContent = `Turno: ${snap.players[snap.turn]?.name || '—'}`;
  }

  setActionHint('Selecciona una carta para jugarla o descartarla.');
});

on('yourHand', hand => {
  store.set({ hand });
  renderHand(hand);
  announceHandChange(hand);
});

on('gameOver', ({ winnerIndex, winnerName, stats }) => {
  toast(`🏆 Ganó ${winnerName}. Volviendo al lobby…`, 2600);

  if (stats) {
    addLog(`Resumen: contenedores reciclados = ${stats.reciclados}, contenedores contaminados = ${stats.contaminados}.`);
  }

  setTimeout(() => showScreen('lobby'), 2000);
});

on('turnTimeout', ({ playerIndex }) => {
  const name = playerNameByIndex(playerIndex);
  toast(`⏱ Se acabó el tiempo de ${name}. Turno pasado al siguiente jugador.`, 2600);
});

on('log', ({ text }) => {
  addLog(text);
});

// ====== ACCIONES UI BÁSICAS ======
createBtn.addEventListener('click', () => {
  const name = $('#hostName').value || 'Jugador';
  const color = $('#hostColor').value || '#22c55e';
  emit('createRoom', { name, color });
});

joinBtn.addEventListener('click', () => {
  const code = ($('#joinCode').value || '').toUpperCase();
  const name = $('#joinName').value || 'Jugador';
  const color = $('#joinColor').value || '#0ea5e9';
  emit('joinRoom', { code, name, color });
});

startBtn.addEventListener('click', () => emit('startGame'));

// ====== NAVEGACIÓN (home, lobby, tutorial, atrás) ======
function goHomeFromLobby() {
  if (!screenHome || !screenLobby) return;
  screenLobby.classList.remove('mode-create','mode-join');
  showScreen('home');
}

if (homeCreateBtn) {
  homeCreateBtn.addEventListener('click', () => {
    screenLobby?.classList.add('mode-create');
    screenLobby?.classList.remove('mode-join');
    showScreen('lobby');
  });
}

if (homeJoinBtn) {
  homeJoinBtn.addEventListener('click', () => {
    screenLobby?.classList.add('mode-join');
    screenLobby?.classList.remove('mode-create');
    showScreen('lobby');
  });
}

// Botones "Atrás" de crear y unirse
if (backCreateBtn) backCreateBtn.addEventListener('click', goHomeFromLobby);
if (backJoinBtn)   backJoinBtn.addEventListener('click', goHomeFromLobby);

// Abrir tutorial desde la pantalla inicial
if (homeTutorialBtn && tutorialModal) {
  homeTutorialBtn.addEventListener('click', () => {
    tutorialModal.classList.remove('hidden');
    tutorialModal.setAttribute('aria-hidden', 'false');
  });
}

// Función reutilizable para cerrar el tutorial y volver al inicio
function closeTutorial() {
  if (!tutorialModal) return;
  tutorialModal.classList.add('hidden');
  tutorialModal.setAttribute('aria-hidden', 'true');

  // volvemos a la pantalla inicial
  if (screenHome) {
    screenLobby?.classList.remove('mode-create', 'mode-join');
    showScreen('home');
  }
}

// Cerrar tutorial con la X
if (tutorialClose) {
  tutorialClose.addEventListener('click', closeTutorial);
}

// Cerrar tutorial haciendo clic en el fondo oscuro
if (tutorialBackdrop) {
  tutorialBackdrop.addEventListener('click', closeTutorial);
}

// Listener global extra por si acaso (por bubbling)
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t) return;
  if (t.id === 'tutorialClose' || t.closest?.('#tutorialClose')) {
    closeTutorial();
  }
  if (t.id === 'tutorialBackdrop') {
    closeTutorial();
  }
});

// ====== DESCARTAR (modo) ======
let discardMode = false;
const picks = new Set();

discardSel.addEventListener('click', () => {
  if (!discardMode) {
    if (store.state.hand.length === 0) return;
    discardMode = true;
    picks.clear();
    handDiv.classList.add('discard-mode');
    toast('🗑️ Modo descarte: toca 1–3 cartas para marcarlas. Vuelve a tocar “Descartar” para confirmar.', 3200);
  } else {
    discardMode = false;
    handDiv.classList.remove('discard-mode');
    if (picks.size > 0) {
      emit('discardCards', { indices: [...picks] });
      // 👇 NUEVO: registrar en el log el descarte
      addLog(`Descartaste ${picks.size} carta(s).`);
    } else {
      toast('Descartar cancelado.');
    }
    picks.clear();
  }
});

handDiv.addEventListener('click', (e) => {
  const face = e.target.closest('.face');
  if (!face) return;

  if (discardMode) {
    const idx = [...handDiv.children].indexOf(face);
    if (idx < 0) return;
    if (picks.has(idx)) picks.delete(idx); else if (picks.size < 3) picks.add(idx);
    face.classList.toggle('selecting', picks.has(idx));
    toast(`Marcadas ${picks.size}/3 carta(s) para descartar.`);
    return;
  }

  const idx = [...handDiv.children].indexOf(face);
  if (idx >= 0) onHandPick(idx);
});

// ====== MÁQUINA DE ESTADOS DE OBJETIVOS ======
const TargetSpec = {
  'Trasplante de contenedores': 2,
  'Ladrón de contenedores': 2,
  'Error de limpieza': 1,
  default: 1
};

let action = { handIndex:null, name:null, targets:[] };

function onHandPick(i){
  const hand = store.state.hand;
  const card = hand[i];
  action = { handIndex:i, name: card?.name, targets:[] };
  const need = TargetSpec[action.name] ?? TargetSpec.default;
  const cardName = card?.name || 'carta';
  toast(`Has seleccionado “${cardName}”. Ahora elige ${need} objetivo(s).`, 2400);

  if (!card) {
    setActionHint('Selecciona una carta para jugarla o descartarla.');
  } else if (card.type === 'organ') {
    setActionHint('Haz clic sobre un espacio vacío de tu tablero para colocar el contenedor.');
  } else if (card.type === 'virus') {
    setActionHint('Haz clic sobre un contenedor objetivo para contaminarlo.');
  } else if (card.type === 'medicine') {
    setActionHint('Haz clic sobre un contenedor compatible para limpiarlo o reciclarlo.');
  } else if (card.type === 'treatment') {
    setActionHint('Selecciona los contenedor/jugadores indicados para aplicar el tratamiento.');
  } else {
    setActionHint('Selecciona el objetivo para esta carta.');
  }
}

function onTargetClick(t){
  if (action.handIndex == null){
    toast('Primero elige una carta de tu mano.');
    return;
  }
  const need = TargetSpec[action.name] ?? 1;
  action.targets.push(t);
  const idx = action.targets.length;
  toast(`Objetivo ${idx}/${need} seleccionado: ${describeTarget(t)}.`);

  if (idx < need) return;

  // 👇 aquí ya tenemos todos los objetivos y vamos a jugar la carta
  const hand = store.state.hand;
  const card  = hand[action.handIndex];
  const cardName = card?.name || 'carta';

  const payload = buildPayload(action);
  toast(`Usando “${cardName}”  ${need===1 ? describeTarget(action.targets[0]) : 'los objetivos elegidos'}…`);

  emit('playCard', { handIndex: action.handIndex, target: payload });

  // 👇 registrar la acción en el log (solo sabemos que *tú* la jugaste)
  if (cardName) {
    if (need === 1 && action.targets[0]) {
      addLog(`Jugaste “${cardName}”  ${describeTarget(action.targets[0])}.`);
    } else {
      addLog(`Jugaste “${cardName}”  varios objetivos.`);
    }
  }

  action = { handIndex:null, name:null, targets:[] };
}

function buildPayload(a){
  const hand = store.state.hand;
  const card = hand[a.handIndex];
  if (!card) return {};

  if (card.type==='treatment' && card.name==='Trasplante de contenedores') {
    const [from,to] = a.targets;
    return { fromPlayer: from.playerIndex, fromSlot: from.slotIndex, toPlayer: to.playerIndex, toSlot: to.slotIndex };
  }
  if (card.type==='treatment' && card.name==='Ladrón de contenedores') {
    const [from,to] = a.targets;
    return { fromPlayer: from.playerIndex, fromSlot: from.slotIndex, toSlot: to.slotIndex };
  }
  if (card.type==='treatment' && card.name==='Error de limpieza') {
    const [who] = a.targets;
    return { playerIndex: who.playerIndex };
  }
  return a.targets[0] ?? {};
}

// ====== RENDER ======
function renderBoards(snap){
  boards.innerHTML = '';
  const frag = document.createDocumentFragment();

  snap.players.forEach((pl, idx)=>{
    const bd = document.createElement('div'); bd.className='board';
    const title = document.createElement('h4');
    const span = document.createElement('span'); span.textContent = pl.name;
    const small = document.createElement('small'); small.textContent = (idx===snap.turn ? ' • jugando' : '');
    title.append(span, small);

    const grid = document.createElement('div'); grid.className='slots';
    for(let s=0;s<4;s++){
      const slot = document.createElement('div'); slot.className='slot'; slot.tabIndex = 0;

      const content = pl.body?.[s];
      if(content?.organ){
        const card = renderFace(faceForOrgan(content.organ));
        slot.appendChild(card);
        const b = document.createElement('div'); b.className='badge';
        const o = content.organ;
        if(o.immune) { b.textContent='Inmunizado'; slot.classList.add('healthy'); }
        else if(o.infected>0) { b.textContent=`Infectado x${o.infected}`; slot.classList.add('infected'); }
        else if(o.vaccines>0) { b.textContent=`reciclado x${o.vaccines}`; slot.classList.add('healthy'); }
        else { b.textContent='limpio'; slot.classList.add('healthy'); }
        slot.appendChild(b);
      } else {
        slot.textContent = 'Vacío';
      }

      slot.addEventListener('click', ()=> onTargetClick({playerIndex: idx, slotIndex: s}));
      slot.addEventListener('keydown', (e)=> { if(e.key==='Enter' || e.key===' ') onTargetClick({playerIndex: idx, slotIndex: s}); });

      grid.appendChild(slot);
    }

    bd.append(title, grid);
    frag.appendChild(bd);
  });

  boards.appendChild(frag);
}

function renderDiscard(snap){
  discardDiv.innerHTML='';
  const top = snap.discardTop;
  if(!top) return;
  const card = renderFace(top);
  discardDiv.appendChild(card);
}

function renderHand(hand){
  handDiv.innerHTML='';
  const frag = document.createDocumentFragment();
  hand.forEach((c, i)=>{
    const face = renderFace(c);
    face.dataset.index = i;
    face.tabIndex = 0;
    face.addEventListener('keydown', (e)=> { if(e.key==='Enter' || e.key===' ') onHandPick(i); });
    frag.appendChild(face);
  });
  handDiv.appendChild(frag);
}

// ====== CARAS ======
function renderFace(c) {
  const el = document.createElement('div');
  el.classList.add('card', 'face', c.type);

  // Imagen por defecto si algo falla
  let src = 'images/fallback.jpeg';

  // Rutas de imágenes por tipo/color/nombre
  const IMG = {
    organ:   {
      red:    'organos/peligrosos.jpeg',
      green:  'organos/aprovechables.jpeg',
      blue:   'organos/organicos.jpeg',
      yellow: 'organos/no_aprovechables.jpeg'
    },
    virus:   {
      red:    'virus/peligrosos.jpeg',
      green:  'virus/aprovechables.jpeg',
      blue:   'virus/organicos.jpeg',
      yellow: 'virus/no_aprovechables.jpeg'
    },
    medicine:{
      red:    'medicinas/peligrosos.jpeg',
      green:  'medicinas/aprovechables.jpeg',
      blue:   'medicinas/organicos.jpeg',
      yellow: 'medicinas/no_aprovechables.jpeg'
    },
    treatment:{
      trasplante_de_contenedores: 'tratamientos/trasplante.jpeg',
      ladron_de_contenedores:     'tratamientos/ladron.jpeg',
      contagio:                   'tratamientos/contagio.jpeg',
      servicio_de_limpieza:       'tratamientos/guante.jpeg',
      error_de_limpieza:          'tratamientos/error_medico.jpeg'
    }
  };

  // ORGAN / VIRUS / MEDICINA por color
  if (c.type === 'organ' || c.type === 'virus' || c.type === 'medicine') {
    const color = (c.color || '').toLowerCase();
    const path = IMG[c.type]?.[color];
    if (path) src = `images/${path}`;
  }
  // TREATMENT por nombre adaptado (tu mazo tiene nombres reciclados)
  else if (c.type === 'treatment') {
    let key = null;
    switch (c.name) {
      case 'Trasplante de contenedores':
        key = 'trasplante_de_contenedores';
        break;
      case 'Ladrón de contenedores':
        key = 'ladron_de_contenedores';
        break;
      case 'Contagio':
        key = 'contagio';
        break;
      case 'Servicio de limpieza':
        key = 'servicio_de_limpieza';
        break;
      case 'Error de limpieza':
        key = 'error_de_limpieza';
        break;
      default:
        key = (c.name || '')
          .toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/\s+/g, '_');
        break;
    }

    const path = key ? IMG.treatment?.[key] : null;
    if (path) src = `images/${path}`;
  }

  const img = document.createElement('img');
  img.src = src;
  img.alt = c.name || c.type;
  img.style.width = '100%';
  img.style.height = '100%';
  img.style.objectFit = 'contain';
  img.style.borderRadius = '10px';
  el.appendChild(img);

  return el;
}

function faceForOrgan(o){
  const nameMap = {red:'Peligrosos', green:'Aprovechables', blue:'Organicos', yellow:'No aprovechables'};
  return {type:'organ', color:o.color, name:nameMap[o.color]||'Órgano'};
}

// ====== FULLSCREEN + ORIENTACIÓN ======
fullBtn.addEventListener('click', async () => {
  const el = document.documentElement;
  try{
    if (!document.fullscreenElement) {
      await el.requestFullscreen();
      fullBtn.textContent = "🡑 Salir";
      if (screen.orientation?.lock) {
        try { await screen.orientation.lock('landscape'); } catch(e){ /* ignore */ }
      }
      toast('Pantalla completa activada. Usa Esc o el botón para salir.', 2200);
    } else {
      await document.exitFullscreen();
      fullBtn.textContent = "⛶ Pantalla completa";
      toast('Saliste de pantalla completa.');
    }
  }catch(e){
    toast('No se pudo activar pantalla completa. Prueba con F11 o los ajustes del navegador.', 2600);
  }
});

function checkOrientation(){
  const portrait = window.matchMedia("(orientation: portrait)").matches;
  rotateHint.classList.toggle('hidden', !portrait);
  if (portrait) {
    toast('Para una mejor experiencia, gira tu dispositivo a horizontal.', 1800);
  }
}

window.addEventListener('orientationchange', checkOrientation);
window.addEventListener('resize', checkOrientation);
checkOrientation();

// ====== ACCESOS RÁPIDOS ======
$('#deck')?.addEventListener('click', () => {
  toast('Las cartas se roban automáticamente al jugar o descartar. No puedes robar manualmente.');
});
