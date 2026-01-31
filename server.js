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

// segurar sala vazia por um tempo (troca de página)
const EMPTY_ROOM_GRACE_MS = 60_000;

const rooms = {};
// roomId -> {
//   password,
//   gameType,
//   masterId,
//   players: {},   // socketId -> nome
//   numbers: {},   // ITO: socketId -> numero
//   emptyTimer: Timeout|null,
//
//   // Quem sou eu:
//   qse: {
//     phase: "lobby"|"writing"|"playing",
//     active: Set<string>,                 // participantes ativos da rodada
//     writingTargetByWriter: {},           // writerId -> targetId (apenas info durante writing)
//     submittedByWriter: {},               // writerId -> true/false
//     submissionTextByWriter: {},          // writerId -> string
//     characterByTarget: {},               // targetId -> character
//     revealedToTarget: {},                // targetId -> true/false
//   }
// }

function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
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

function closeRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  io.to(roomId).emit("roomClosed");

  for (const id of Object.keys(room.players)) {
    const s = io.sockets.sockets.get(id);
    if (s) s.leave(roomId);
  }

  cancelEmptyRoomDeletion(roomId);
  delete rooms[roomId];
}

function emitPlayersUpdate(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const players = Object.keys(room.players).map((id) => ({
    id,
    name: room.players[id],
    isMaster: id === room.masterId,
  }));

  io.to(roomId).emit("playersUpdate", {
    roomId,
    players,
    masterId: room.masterId,
    gameType: room.gameType,
  });
}

/** Gera uma permutação sem ninguém apontar pra si mesmo (derangement).
 * Se não conseguir em algumas tentativas (raro), usa um ciclo simples.
 */
function derangement(ids) {
  const n = ids.length;
  if (n < 2) return null;

  // tentativa aleatória
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

  // fallback determinístico: ciclo
  const map = {};
  for (let i = 0; i < n; i++) {
    map[ids[i]] = ids[(i + 1) % n];
  }
  return map;
}

/* ---------------- Quem sou eu: helpers ---------------- */

function ensureQse(room) {
  if (!room.qse) {
    room.qse = {
      phase: "lobby",
      active: new Set(),
      writingTargetByWriter: {},
      submittedByWriter: {},
      submissionTextByWriter: {},
      characterByTarget: {},
      revealedToTarget: {},
    };
  }
}

function qseResetRound(room) {
  ensureQse(room);
  room.qse.phase = "lobby";
  room.qse.active = new Set();
  room.qse.writingTargetByWriter = {};
  room.qse.submittedByWriter = {};
  room.qse.submissionTextByWriter = {};
  room.qse.characterByTarget = {};
  room.qse.revealedToTarget = {};
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

  const status = Object.keys(room.players).map((id) => ({
    id,
    name: room.players[id],
    submitted: !!room.qse.submittedByWriter[id],
    active: room.qse.active.has(id),
  }));

  io.to(roomId).emit("qseWritingStatus", status);
}

function qseEmitOthersCharacters(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  ensureQse(room);

  const activeIds = Array.from(room.qse.active);

  // monta lista "targetId -> character"
  const byTarget = room.qse.characterByTarget;

  // para cada jogador ativo: envia lista dos outros (nome + character)
  activeIds.forEach((viewerId) => {
    const list = activeIds
      .filter((targetId) => targetId !== viewerId)
      .map((targetId) => ({
        id: targetId,
        name: room.players[targetId],
        character: byTarget[targetId],
      }));

    io.to(viewerId).emit("qseOthersCharacters", list);
  });

  // jogador excluído recebe aviso
  Object.keys(room.players).forEach((id) => {
    if (!room.qse.active.has(id)) {
      io.to(id).emit("qseExcluded");
    }
  });
}

/* ---------------- Socket ---------------- */

io.on("connection", (socket) => {
  // Criar sala
  socket.on("createRoom", ({ roomId, password, masterName, gameType }) => {
    if (!masterName || !password) {
      socket.emit("errorMessage", "Informe seu nome e uma senha.");
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
      masterId: socket.id,
      players: {},
      numbers: {},
      emptyTimer: null,
      qse: null,
    };

    rooms[roomId].players[socket.id] = masterName;
    socket.join(roomId);

    socket.emit("master");
    socket.emit("roomCreated", { roomId, gameType: gt });

    emitPlayersUpdate(roomId);
  });

  // Entrar na sala
  socket.on("joinRoom", ({ roomId, password, playerName }) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];

    if (!room) {
      socket.emit("errorMessage", "Sala não existe");
      return;
    }

    cancelEmptyRoomDeletion(roomId);

    if (room.password !== password) {
      socket.emit("errorMessage", "Senha incorreta");
      return;
    }

    if (Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) {
      socket.emit("errorMessage", "Sala cheia");
      return;
    }

    room.players[socket.id] = (playerName || "Jogador").trim();
    socket.join(roomId);

    socket.emit("joinedRoom", { roomId, gameType: room.gameType });

    // se não tiver mestre
    if (!room.masterId) {
      room.masterId = socket.id;
      io.to(socket.id).emit("master");
    }

    // se o jogo for quem-sou-eu, garante estrutura
    if (room.gameType === "quem-sou-eu") {
      ensureQse(room);
      // se entrar no meio da rodada, ele fica fora (rodada atual não inclui)
      qseEmitPhase(roomId);
      qseEmitWritingStatus(roomId);
    }

    emitPlayersUpdate(roomId);
  });

  /* -------- ITO -------- */

  socket.on("distribute", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    if (socket.id !== room.masterId) return;

    room.numbers = {};
    const pool = Array.from({ length: 100 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);

    Object.keys(room.players).forEach((playerId, index) => {
      room.numbers[playerId] = pool[index];
      io.to(playerId).emit("number", pool[index]);
    });
  });

  socket.on("reveal", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    if (socket.id !== room.masterId) return;

    const result = Object.keys(room.players)
      .map((playerId) => ({
        name: room.players[playerId],
        number: room.numbers[playerId],
      }))
      .sort((a, b) => (b.number ?? -1) - (a.number ?? -1));

    io.to(roomId).emit("allNumbers", result);
  });

  /* -------- QUEM SOU EU -------- */

  // Mestre inicia rodada: começa a fase de escrita com pareamento aleatório
  socket.on("qseStartRound", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    if (socket.id !== room.masterId) return;
    if (room.gameType !== "quem-sou-eu") return;

    ensureQse(room);
    qseResetRound(room);

    const ids = Object.keys(room.players);
    if (ids.length < 2) {
      socket.emit("errorMessage", "Precisa de pelo menos 2 jogadores para iniciar.");
      return;
    }

    const map = derangement(ids);
    if (!map) {
      socket.emit("errorMessage", "Não foi possível iniciar a rodada agora. Tente novamente.");
      return;
    }

    room.qse.phase = "writing";
    room.qse.active = new Set(ids);
    room.qse.writingTargetByWriter = map;
    room.qse.submittedByWriter = {};
    room.qse.submissionTextByWriter = {};
    room.qse.characterByTarget = {};
    room.qse.revealedToTarget = {};

    // manda pra cada writer pra quem ele vai escrever
    ids.forEach((writerId) => {
      const targetId = map[writerId];
      const targetName = room.players[targetId];
      io.to(writerId).emit("qseYourTarget", { targetId, targetName });
    });

    qseEmitPhase(roomId);
    qseEmitWritingStatus(roomId);
  });

  // Jogador envia personagem
  socket.on("qseSubmit", ({ roomId, text }) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    if (room.gameType !== "quem-sou-eu") return;

    ensureQse(room);
    if (room.qse.phase !== "writing") {
      socket.emit("errorMessage", "Não estamos na fase de escrita.");
      return;
    }

    if (!room.qse.active.has(socket.id)) {
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

    room.qse.submittedByWriter[socket.id] = true;
    room.qse.submissionTextByWriter[socket.id] = clean;

    // feedback pro jogador
    socket.emit("qseSubmittedOK");

    qseEmitWritingStatus(roomId);
  });

  // Mestre fecha escrita: exclui quem não enviou e recalcula rodada só com quem enviou
  socket.on("qseCloseWriting", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;
    if (socket.id !== room.masterId) return;
    if (room.gameType !== "quem-sou-eu") return;

    ensureQse(room);
    if (room.qse.phase !== "writing") return;

    const allIds = Array.from(room.qse.active);

    // mantém apenas quem enviou
    const activeIds = allIds.filter((id) => !!room.qse.submittedByWriter[id]);

    if (activeIds.length < 2) {
      // não dá pra jogar
      room.qse.active = new Set(activeIds);
      room.qse.phase = "lobby";
      qseEmitPhase(roomId);
      qseEmitWritingStatus(roomId);
      io.to(roomId).emit("qseRoundCancelled", "Poucas pessoas enviaram. Rodada cancelada.");
      return;
    }

    // agora fazemos um novo embaralhamento ENTRE QUEM ENVIOU
    const map = derangement(activeIds);
    if (!map) {
      room.qse.phase = "lobby";
      qseEmitPhase(roomId);
      io.to(roomId).emit("qseRoundCancelled", "Não foi possível recalcular. Tente iniciar de novo.");
      return;
    }

    // define participantes ativos finais
    room.qse.active = new Set(activeIds);

    // monta personagens finais por alvo:
    // cada writer mantém o texto enviado, mas agora ele vai para um alvo do novo embaralhamento
    room.qse.characterByTarget = {};
    activeIds.forEach((writerId) => {
      const targetId = map[writerId];
      room.qse.characterByTarget[targetId] = room.qse.submissionTextByWriter[writerId];
    });

    room.qse.revealedToTarget = {};

    // muda fase
    room.qse.phase = "playing";

    qseEmitPhase(roomId);
    qseEmitWritingStatus(roomId);

    // manda lista de personagens dos outros pra cada um
    qseEmitOthersCharacters(roomId);
  });

  // Mestre revela para um jogador específico
  socket.on("qseRevealTo", ({ roomId, targetId }) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    if (socket.id !== room.masterId) return;
    if (room.gameType !== "quem-sou-eu") return;

    ensureQse(room);
    if (room.qse.phase !== "playing") return;

    if (!room.qse.active.has(targetId)) {
      socket.emit("errorMessage", "Esse jogador não está ativo nessa rodada.");
      return;
    }

    const character = room.qse.characterByTarget[targetId];
    if (!character) {
      socket.emit("errorMessage", "Sem personagem para esse jogador.");
      return;
    }

    room.qse.revealedToTarget[targetId] = true;
    io.to(targetId).emit("qseYourCharacter", { character });

    // atualiza lista pro mestre (marca revelados)
    io.to(roomId).emit("qseRevealedUpdate", {
      revealedToTarget: room.qse.revealedToTarget,
    });
  });

  /* -------- Sair / disconnect -------- */

  socket.on("leaveRoom", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    // mestre sai: fecha sala
    if (socket.id === room.masterId) {
      closeRoom(roomId);
      return;
    }

    if (room.players[socket.id]) {
      delete room.players[socket.id];
      delete room.numbers[socket.id];

      // limpa qse se existir
      if (room.qse) {
        room.qse.active.delete(socket.id);
        delete room.qse.submittedByWriter[socket.id];
        delete room.qse.submissionTextByWriter[socket.id];
        delete room.qse.characterByTarget[socket.id];
        delete room.qse.revealedToTarget[socket.id];
      }

      socket.leave(roomId);

      emitPlayersUpdate(roomId);
      if (room.gameType === "quem-sou-eu") {
        qseEmitWritingStatus(roomId);
      }

      if (Object.keys(room.players).length === 0) {
        cancelEmptyRoomDeletion(roomId);
        delete rooms[roomId];
      }
    }
  });

  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (!room.players[socket.id]) continue;

      const wasMaster = room.masterId === socket.id;

      delete room.players[socket.id];
      delete room.numbers[socket.id];

      if (room.qse) {
        room.qse.active.delete(socket.id);
        delete room.qse.submittedByWriter[socket.id];
        delete room.qse.submissionTextByWriter[socket.id];
        delete room.qse.characterByTarget[socket.id];
        delete room.qse.revealedToTarget[socket.id];
      }

      // se mestre caiu, passa cargo
      if (wasMaster) {
        const remaining = Object.keys(room.players);
        room.masterId = remaining.length ? remaining[0] : null;
        if (room.masterId) io.to(room.masterId).emit("master");
      }

      emitPlayersUpdate(roomId);
      if (room.gameType === "quem-sou-eu") {
        qseEmitWritingStatus(roomId);
      }

      if (Object.keys(room.players).length === 0) {
        scheduleEmptyRoomDeletion(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
