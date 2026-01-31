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

const rooms = {};
// roomId -> { password, gameType, masterId, players:{}, numbers:{} }

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

function closeRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  io.to(roomId).emit("roomClosed");

  for (const id of Object.keys(room.players)) {
    const s = io.sockets.sockets.get(id);
    if (s) s.leave(roomId);
  }

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

    // valida roomId vindo do cliente (UX)
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

    // Se por acaso não existir mestre (pode acontecer se o mestre caiu),
    // o primeiro que entrar vira mestre
    if (!room.masterId) {
      room.masterId = socket.id;
      io.to(socket.id).emit("master");
    }

    emitPlayersUpdate(roomId);
  });

  // Distribuir (só mestre)
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

  // Revelar (só mestre) - maior -> menor
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

  // Sair (botão sair)
  socket.on("leaveRoom", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    // Se mestre clicou sair: FECHA sala (como você quer)
    if (socket.id === room.masterId) {
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
        delete rooms[roomId];
      }
    }
  });

  // Disconnect (reload/troca de página etc.)
  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];

      if (room.players[socket.id]) {
        const wasMaster = room.masterId === socket.id;

        delete room.players[socket.id];
        delete room.numbers[socket.id];

        // ✅ IMPORTANTE: NÃO fecha a sala no disconnect do mestre
        // (isso evita matar a sala quando ele muda de página)
        if (wasMaster) {
          const remaining = Object.keys(room.players);
          room.masterId = remaining.length ? remaining[0] : null;

          if (room.masterId) {
            io.to(room.masterId).emit("master");
          }
        }

        emitPlayersUpdate(roomId);

        if (Object.keys(room.players).length === 0) {
          delete rooms[roomId];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
