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

// tempo pra segurar sala vazia (troca de página / reload)
const EMPTY_ROOM_GRACE_MS = 60_000;

const rooms = {};
// roomId -> {
//   password,
//   gameType,
//   masterId,
//   players: {},
//   numbers: {},
//   emptyTimer: Timeout|null
// }

function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
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

function scheduleEmptyRoomDeletion(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // já tem timer
  if (room.emptyTimer) return;

  room.emptyTimer = setTimeout(() => {
    const r = rooms[roomId];
    if (!r) return;

    // se ainda estiver vazia, apaga
    if (Object.keys(r.players).length === 0) {
      delete rooms[roomId];
    } else {
      // alguém entrou, não apaga
      r.emptyTimer = null;
    }
  }, EMPTY_ROOM_GRACE_MS);
}

function cancelEmptyRoomDeletion(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.emptyTimer) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
  }
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

    // se alguém entrou, cancela o timer de sala vazia
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

    // se por algum motivo não existir mestre, o primeiro vira
    if (!room.masterId) {
      room.masterId = socket.id;
      io.to(socket.id).emit("master");
    }

    emitPlayersUpdate(roomId);
  });

  // Distribuir
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

  // Revelar (maior -> menor)
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

  // Sair (botão)
  socket.on("leaveRoom", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    if (socket.id === room.masterId) {
      // mestre clicou sair: fecha geral
      closeRoom(roomId);
      return;
    }

    // jogador saindo
    if (room.players[socket.id]) {
      delete room.players[socket.id];
      delete room.numbers[socket.id];
      socket.leave(roomId);

      emitPlayersUpdate(roomId);

      if (Object.keys(room.players).length === 0) {
        // aqui pode apagar direto, porque foi "sair" explícito
        cancelEmptyRoomDeletion(roomId);
        delete rooms[roomId];
      }
    }
  });

  // Disconnect (troca de página / reload)
  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (!room.players[socket.id]) continue;

      const wasMaster = room.masterId === socket.id;

      delete room.players[socket.id];
      delete room.numbers[socket.id];

      // se mestre caiu, passa o cargo (não fecha!)
      if (wasMaster) {
        const remaining = Object.keys(room.players);
        room.masterId = remaining.length ? remaining[0] : null;
        if (room.masterId) io.to(room.masterId).emit("master");
      }

      emitPlayersUpdate(roomId);

      // ✅ se ficou vazia, NÃO apaga na hora: dá tempo pra voltar
      if (Object.keys(room.players).length === 0) {
        scheduleEmptyRoomDeletion(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
