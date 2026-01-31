const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(express.static("public"));

const MAX_PLAYERS_PER_ROOM = 8;

// Sala vazia: segurar por um tempo (troca de página / reload)
const EMPTY_ROOM_GRACE_MS = 60_000;

// Jogador desconectado (suspensão): tolerância para voltar sem perder lugar
const RECONNECT_GRACE_MS = 90_000;

const rooms = {};
// roomId -> {
//   password,
//   gameType,
//   masterToken,
//   players: { token: { name, socketId, online, disconnectTimer } },
//   sessions: { token: sessionKey },
//   banned: Set(token),
//   numbers: { token: number },
//   emptyTimer,
//
//   qse: {
//     phase,
//     active: Set(token),
//     submittedByWriter: { token: bool },
//     submissionTextByWriter: { token: string },
//     characterByTarget: { token: string },
//     revealedToTarget: { token: bool },
//     writingTargetByWriter: { token: token }, // só informativo durante writing
//   }
// }

function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function generateSessionKey() {
  // simples e suficiente pro nosso caso (não é login bancário)
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function cancelEmptyRoomDeletion(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.emptyTimer) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
  }
}

function scheduleEmptyRoomDeletion(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.emptyTimer) return;

  room.emptyTimer = setTimeout(() => {
    const r = rooms[roomId];
    if (!r) return;
    if (Object.keys(r.players).length === 0) {
      delete rooms[roomId];
    } else {
      r.emptyTimer = null;
    }
  }, EMPTY_ROOM_GRACE_MS);
}

function emitPlayersUpdate(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const players = Object.keys(room.players).map((token) => ({
    token,
    name: room.players[token].name,
    isMaster: token === room.masterToken,
    online: !!room.players[token].online,
  }));

  io.to(roomId).emit("playersUpdate", {
    roomId,
    players,
    masterToken: room.masterToken,
    gameType: room.gameType,
  });
}

function closeRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  io.to(roomId).emit("roomClosed");

  // desconecta todos sockets da sala (se existirem)
  for (const token of Object.keys(room.players)) {
    const sid = room.players[token].socketId;
    if (sid) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.leave(roomId);
    }
    if (room.players[token].disconnectTimer) {
      clearTimeout(room.players[token].disconnectTimer);
      room.players[token].disconnectTimer = null;
    }
  }

  cancelEmptyRoomDeletion(roomId);
  delete rooms[roomId];
}

/** Derangement (ninguém aponta pra si).
 * Se não achar em tentativas, usa ciclo.
 */
function derangement(ids) {
  const n = ids.length;
  if (n < 2) return null;

  for (let attempt = 0; attempt < 50; attempt++) {
    const perm = [...ids].sort(() => Math.random() - 0.5);
    let ok = true;
    for (let i = 0; i < n; i++) {
      if (perm[i] === ids[i]) { ok = false; break; }
    }
    if (ok) {
      const map = {};
      for (let i = 0; i < n; i++) map[ids[i]] = perm[i];
      return map;
    }
  }

  const map = {};
  for (let i = 0; i < n; i++) map[ids[i]] = ids[(i + 1) % n];
  return map;
}

/* ---------- QSE helpers ---------- */

function ensureQse(room) {
  if (!room.qse) {
    room.qse = {
      phase: "lobby",
      active: new Set(),
      submittedByWriter: {},
      submissionTextByWriter: {},
      characterByTarget: {},
      revealedToTarget: {},
      writingTargetByWriter: {},
    };
  }
}

function qseResetRound(room) {
  ensureQse(room);
  room.qse.phase = "lobby";
  room.qse.active = new Set();
  room.qse.submittedByWriter = {};
  room.qse.submissionTextByWriter = {};
  room.qse.characterByTarget = {};
  room.qse.revealedToTarget = {};
  room.qse.writingTargetByWriter = {};
}

function qseEmitPhase(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  ensureQse(room);
  io.to(roomId).emit("qsePhase", { phase: room.qse.phase });
}

function qseEmitWritingStatus(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  ensureQse(room);

  const status = Object.keys(room.players).map((token) => ({
    token,
    name: room.players[token].name,
    submitted: !!room.qse.submittedByWriter[token],
    active: room.qse.active.has(token),
    online: !!room.players[token].online,
  }));

  io.to(roomId).emit("qseWritingStatus", status);
}

function qseEmitOthersCharacters(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  ensureQse(room);

  const activeTokens = Array.from(room.qse.active);
  const byTarget = room.qse.characterByTarget;

  // cada jogador ativo recebe a lista dos outros (nome + personagem), menos o próprio
  activeTokens.forEach((viewerToken) => {
    const viewerSid = room.players[viewerToken]?.socketId;
    if (!viewerSid) return; // offline

    const list = activeTokens
      .filter((targetToken) => targetToken !== viewerToken)
      .map((targetToken) => ({
        token: targetToken,
        name: room.players[targetToken]?.name || "Jogador",
        character: byTarget[targetToken],
      }));

    io.to(viewerSid).emit("qseOthersCharacters", list);
  });

  // quem ficou fora recebe aviso (se online)
  Object.keys(room.players).forEach((token) => {
    if (!room.qse.active.has(token)) {
      const sid = room.players[token].socketId;
      if (sid) io.to(sid).emit("qseExcluded");
    }
  });
}

/* ---------- Disconnect grace ---------- */

function schedulePlayerRemoval(roomId, token) {
  const room = rooms[roomId];
  if (!room) return;
  const p = room.players[token];
  if (!p) return;

  if (p.disconnectTimer) return;

  p.disconnectTimer = setTimeout(() => {
    const r = rooms[roomId];
    if (!r) return;
    const pp = r.players[token];
    if (!pp) return;

    // se voltou online, não remove
    if (pp.online) {
      pp.disconnectTimer = null;
      return;
    }

    // remove definitivo
    delete r.players[token];
    delete r.sessions[token];
    delete r.numbers[token];

    if (r.qse) {
      r.qse.active.delete(token);
      delete r.qse.submittedByWriter[token];
      delete r.qse.submissionTextByWriter[token];
      delete r.qse.characterByTarget[token];
      delete r.qse.revealedToTarget[token];
      delete r.qse.writingTargetByWriter[token];
    }

    // se era mestre: transfere para alguém que restou (preferência online)
    if (r.masterToken === token) {
      const remaining = Object.keys(r.players);
      if (remaining.length) {
        const onlineFirst = remaining.find(t => r.players[t].online) || remaining[0];
        r.masterToken = onlineFirst;
        const sid = r.players[onlineFirst].socketId;
        if (sid) io.to(sid).emit("master");
      } else {
        r.masterToken = null;
      }
    }

    // se sala vazia, agenda delete
    if (Object.keys(r.players).length === 0) {
      scheduleEmptyRoomDeletion(roomId);
    }

    emitPlayersUpdate(roomId);
    if (r.gameType === "quem-sou-eu") {
      qseEmitWritingStatus(roomId);
    }
  }, RECONNECT_GRACE_MS);
}

function cancelPlayerRemoval(roomId, token) {
  const room = rooms[roomId];
  if (!room) return;
  const p = room.players[token];
  if (!p) return;

  if (p.disconnectTimer) {
    clearTimeout(p.disconnectTimer);
    p.disconnectTimer = null;
  }
}

/* ---------- Kick ---------- */

function kickPlayer(roomId, token, reason = "Você foi expulso pelo mestre.") {
  const room = rooms[roomId];
  if (!room) return;

  // ban até a sala fechar
  room.banned.add(token);

  const p = room.players[token];
  if (p) {
    const sid = p.socketId;
    if (sid) {
      io.to(sid).emit("kicked", { reason });
      const s = io.sockets.sockets.get(sid);
      if (s) s.disconnect(true);
    }
  }

  // remove imediatamente
  delete room.players[token];
  delete room.sessions[token];
  delete room.numbers[token];

  if (room.qse) {
    room.qse.active.delete(token);
    delete room.qse.submittedByWriter[token];
    delete room.qse.submissionTextByWriter[token];
    delete room.qse.characterByTarget[token];
    delete room.qse.revealedToTarget[token];
    delete room.qse.writingTargetByWriter[token];
  }

  // se expulsou o mestre (não deveria acontecer), ajusta
  if (room.masterToken === token) {
    const remaining = Object.keys(room.players);
    if (remaining.length) {
      const onlineFirst = remaining.find(t => room.players[t].online) || remaining[0];
      room.masterToken = onlineFirst;
      const sid = room.players[onlineFirst].socketId;
      if (sid) io.to(sid).emit("master");
    } else {
      room.masterToken = null;
    }
  }

  emitPlayersUpdate(roomId);
  if (room.gameType === "quem-sou-eu") qseEmitWritingStatus(roomId);

  if (Object.keys(room.players).length === 0) {
    scheduleEmptyRoomDeletion(roomId);
  }
}

/* ---------- Socket ---------- */

io.on("connection", (socket) => {
  // Criar sala
  socket.on("createRoom", ({ roomId, password, masterName, gameType, playerToken }) => {
    if (!masterName || !password) {
      socket.emit("errorMessage", "Informe seu nome e uma senha.");
      return;
    }
    if (!playerToken) {
      socket.emit("errorMessage", "Token inválido. Recarregue a página.");
      return;
    }

    const gt = (gameType || "ito").toString().trim().toLowerCase();

    if (roomId) {
      roomId = String(roomId).trim().toUpperCase();
      const valid = /^[A-Z2-9]{6}$/.test(roomId);
      if (!valid) {
        socket.emit("errorMessage", "Código inválido. Use 6 caracteres (A-Z e 2-9).");
        return;
      }
      if (rooms[roomId]) {
        socket.emit("errorMessage", "Esse código já está em uso. Gere outro.");
        return;
      }
    } else {
      let newId = generateRoomId();
      while (rooms[newId]) newId = generateRoomId();
      roomId = newId;
    }

    rooms[roomId] = {
      password,
      gameType: gt,
      masterToken: playerToken,
      players: {},
      sessions: {},
      banned: new Set(),
      numbers: {},
      emptyTimer: null,
      qse: null,
    };

    rooms[roomId].players[playerToken] = {
      name: masterName.trim(),
      socketId: socket.id,
      online: true,
      disconnectTimer: null,
    };

    const sessionKey = generateSessionKey();
    rooms[roomId].sessions[playerToken] = sessionKey;

    socket.join(roomId);

    socket.emit("master");
    socket.emit("roomCreated", { roomId, gameType: gt, sessionKey });

    emitPlayersUpdate(roomId);

    if (gt === "quem-sou-eu") {
      ensureQse(rooms[roomId]);
      qseEmitPhase(roomId);
      qseEmitWritingStatus(roomId);
    }
  });

  // Entrar/Reconectar na sala
  socket.on("joinRoom", ({ roomId, password, playerName, playerToken, sessionKey }) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];

    if (!room) {
      socket.emit("errorMessage", "Sala não existe");
      return;
    }
    if (!playerToken) {
      socket.emit("errorMessage", "Token inválido. Recarregue a página.");
      return;
    }
    if (room.banned.has(playerToken)) {
      socket.emit("errorMessage", "Você foi expulso dessa sala.");
      return;
    }

    cancelEmptyRoomDeletion(roomId);

    // Reconnect por sessionKey (sem senha)
    const hasSession = room.sessions[playerToken] && sessionKey && room.sessions[playerToken] === sessionKey;

    if (!hasSession) {
      // primeira entrada: exige senha
      if (room.password !== password) {
        socket.emit("errorMessage", "Senha incorreta");
        return;
      }

      // sala cheia: conta tokens (mesmo offline) — você pode mudar para só online se quiser
      if (!room.players[playerToken] && Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) {
        socket.emit("errorMessage", "Sala cheia");
        return;
      }

      // gera sessionKey e guarda
      room.sessions[playerToken] = generateSessionKey();
    }

    // se já existia jogador, só atualiza; senão cria
    if (!room.players[playerToken]) {
      room.players[playerToken] = {
        name: (playerName || "Jogador").trim(),
        socketId: socket.id,
        online: true,
        disconnectTimer: null,
      };
    } else {
      room.players[playerToken].name = (playerName || room.players[playerToken].name || "Jogador").trim();
      room.players[playerToken].socketId = socket.id;
      room.players[playerToken].online = true;
      cancelPlayerRemoval(roomId, playerToken);
    }

    socket.join(roomId);

    // se não tiver mestre, define
    if (!room.masterToken) {
      room.masterToken = playerToken;
      socket.emit("master");
    }

    // se o jogador que entrou é o mestre
    if (room.masterToken === playerToken) {
      socket.emit("master");
    }

    socket.emit("joinedRoom", { roomId, gameType: room.gameType, sessionKey: room.sessions[playerToken] });

    emitPlayersUpdate(roomId);

    if (room.gameType === "quem-sou-eu") {
      ensureQse(room);
      qseEmitPhase(roomId);
      qseEmitWritingStatus(roomId);

      // se a rodada já está em playing e ele é ativo, reenvia lista dos outros
      if (room.qse.phase === "playing" && room.qse.active.has(playerToken)) {
        // manda novamente lista dos outros pra ele (apenas ele)
        const activeTokens = Array.from(room.qse.active);
        const list = activeTokens
          .filter(t => t !== playerToken)
          .map(t => ({
            token: t,
            name: room.players[t]?.name || "Jogador",
            character: room.qse.characterByTarget[t],
          }));
        io.to(socket.id).emit("qseOthersCharacters", list);

        // se já foi revelado, manda também
        if (room.qse.revealedToTarget[playerToken]) {
          io.to(socket.id).emit("qseYourCharacter", { character: room.qse.characterByTarget[playerToken] });
        }
      }
    }
  });

  // Mestre expulsa jogador
  socket.on("kickPlayer", ({ roomId, targetToken }) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    // identificar quem é este socket (token)
    const kickerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!kickerToken) return;

    if (room.masterToken !== kickerToken) return;
    if (!targetToken) return;
    if (targetToken === room.masterToken) return;

    kickPlayer(roomId, targetToken);
  });

  /* -------- ITO (De 1 a 100) -------- */

  socket.on("distribute", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    const callerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!callerToken) return;
    if (callerToken !== room.masterToken) return;

    room.numbers = {};
    const tokens = Object.keys(room.players).filter(t => room.players[t].online);
    const pool = Array.from({ length: 100 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);

    tokens.forEach((token, index) => {
      room.numbers[token] = pool[index];
      const sid = room.players[token].socketId;
      if (sid) io.to(sid).emit("number", pool[index]);
    });
  });

  socket.on("reveal", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    const callerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!callerToken) return;
    if (callerToken !== room.masterToken) return;

    const result = Object.keys(room.players)
      .map((token) => ({
        name: room.players[token].name,
        number: room.numbers[token],
      }))
      .sort((a, b) => (b.number ?? -1) - (a.number ?? -1));

    io.to(roomId).emit("allNumbers", result);
  });

  /* -------- EU SOU... (Quem sou eu?) -------- */

  socket.on("qseStartRound", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    if (room.gameType !== "quem-sou-eu") return;

    const callerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!callerToken) return;
    if (callerToken !== room.masterToken) return;

    ensureQse(room);
    qseResetRound(room);

    const tokens = Object.keys(room.players).filter(t => room.players[t].online);
    if (tokens.length < 2) {
      socket.emit("errorMessage", "Precisa de pelo menos 2 jogadores online para iniciar.");
      return;
    }

    const map = derangement(tokens);
    if (!map) {
      socket.emit("errorMessage", "Não foi possível iniciar a rodada. Tente novamente.");
      return;
    }

    room.qse.phase = "writing";
    room.qse.active = new Set(tokens);
    room.qse.writingTargetByWriter = map;

    tokens.forEach((writerToken) => {
      const targetToken = map[writerToken];
      const targetName = room.players[targetToken]?.name || "Jogador";
      const sid = room.players[writerToken].socketId;
      if (sid) io.to(sid).emit("qseYourTarget", { targetToken, targetName });
    });

    qseEmitPhase(roomId);
    qseEmitWritingStatus(roomId);
  });

  socket.on("qseSubmit", ({ roomId, text }) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    if (room.gameType !== "quem-sou-eu") return;

    const token = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!token) return;

    ensureQse(room);
    if (room.qse.phase !== "writing") {
      socket.emit("errorMessage", "Não estamos na fase de escrita.");
      return;
    }
    if (!room.qse.active.has(token)) {
      socket.emit("errorMessage", "Você não está ativo nessa rodada.");
      return;
    }

    const clean = (text || "").toString().trim();
    if (!clean) {
      socket.emit("errorMessage", "Digite um personagem antes de enviar.");
      return;
    }
    if (clean.length > 60) {
      socket.emit("errorMessage", "Texto muito grande. Use até 60 caracteres.");
      return;
    }

    room.qse.submittedByWriter[token] = true;
    room.qse.submissionTextByWriter[token] = clean;

    socket.emit("qseSubmittedOK");
    qseEmitWritingStatus(roomId);
  });

  socket.on("qseCloseWriting", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    if (room.gameType !== "quem-sou-eu") return;

    const callerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!callerToken) return;
    if (callerToken !== room.masterToken) return;

    ensureQse(room);
    if (room.qse.phase !== "writing") return;

    const allActive = Array.from(room.qse.active);

    // mantém apenas quem enviou
    const survivors = allActive.filter(t => !!room.qse.submittedByWriter[t]);

    if (survivors.length < 2) {
      room.qse.active = new Set(survivors);
      room.qse.phase = "lobby";
      qseEmitPhase(roomId);
      qseEmitWritingStatus(roomId);
      io.to(roomId).emit("qseRoundCancelled", "Poucas pessoas enviaram. Rodada cancelada.");
      return;
    }

    // recalcula embaralhamento apenas entre quem enviou
    const map = derangement(survivors);
    if (!map) {
      room.qse.phase = "lobby";
      qseEmitPhase(roomId);
      io.to(roomId).emit("qseRoundCancelled", "Não foi possível recalcular. Inicie novamente.");
      return;
    }

    room.qse.active = new Set(survivors);
    room.qse.characterByTarget = {};
    room.qse.revealedToTarget = {};

    survivors.forEach((writerToken) => {
      const targetToken = map[writerToken];
      room.qse.characterByTarget[targetToken] = room.qse.submissionTextByWriter[writerToken];
    });

    room.qse.phase = "playing";

    qseEmitPhase(roomId);
    qseEmitWritingStatus(roomId);
    qseEmitOthersCharacters(roomId);
  });

  socket.on("qseRevealTo", ({ roomId, targetToken }) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    if (room.gameType !== "quem-sou-eu") return;

    const callerToken = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!callerToken) return;
    if (callerToken !== room.masterToken) return;

    ensureQse(room);
    if (room.qse.phase !== "playing") return;

    if (!room.qse.active.has(targetToken)) {
      socket.emit("errorMessage", "Esse jogador não está ativo nessa rodada.");
      return;
    }

    const character = room.qse.characterByTarget[targetToken];
    if (!character) {
      socket.emit("errorMessage", "Sem personagem para esse jogador.");
      return;
    }

    room.qse.revealedToTarget[targetToken] = true;

    const sid = room.players[targetToken]?.socketId;
    if (sid) io.to(sid).emit("qseYourCharacter", { character });

    io.to(roomId).emit("qseRevealedUpdate", { revealedToTarget: room.qse.revealedToTarget });
  });

  /* -------- Sair / disconnect -------- */

  socket.on("leaveRoom", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    const token = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
    if (!token) return;

    // mestre saiu explicitamente -> fecha sala
    if (token === room.masterToken) {
      closeRoom(roomId);
      return;
    }

    // remove jogador imediatamente
    cancelPlayerRemoval(roomId, token);

    delete room.players[token];
    delete room.sessions[token];
    delete room.numbers[token];

    if (room.qse) {
      room.qse.active.delete(token);
      delete room.qse.submittedByWriter[token];
      delete room.qse.submissionTextByWriter[token];
      delete room.qse.characterByTarget[token];
      delete room.qse.revealedToTarget[token];
      delete room.qse.writingTargetByWriter[token];
    }

    socket.leave(roomId);

    emitPlayersUpdate(roomId);
    if (room.gameType === "quem-sou-eu") qseEmitWritingStatus(roomId);

    if (Object.keys(room.players).length === 0) {
      scheduleEmptyRoomDeletion(roomId);
    }
  });

  socket.on("disconnect", () => {
    // acha em quais salas esse socket estava
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const token = Object.keys(room.players).find(t => room.players[t].socketId === socket.id);
      if (!token) continue;

      room.players[token].online = false;
      room.players[token].socketId = null;

      // NÃO remove imediatamente: dá tempo para reconectar sem perder lugar
      schedulePlayerRemoval(roomId, token);

      emitPlayersUpdate(roomId);
      if (room.gameType === "quem-sou-eu") qseEmitWritingStatus(roomId);

      if (Object.keys(room.players).length === 0) {
        scheduleEmptyRoomDeletion(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
