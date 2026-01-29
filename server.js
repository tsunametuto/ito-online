const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(express.static("public"));

const MAX_PLAYERS_PER_ROOM = 8;

const rooms = {};
// roomId -> {
//   password,
//   masterId,
//   players: {},   // socketId -> nome
//   numbers: {}    // socketId -> numero
// }

function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

io.on("connection", (socket) => {
  // ✅ Criar sala (mestre)
  socket.on("createRoom", ({ password, masterName }) => {
    if (!masterName || !password) {
      socket.emit("errorMessage", "Informe seu nome e uma senha para criar a sala.");
      return;
    }

    let roomId = generateRoomId();
    while (rooms[roomId]) roomId = generateRoomId();

    rooms[roomId] = {
      password,
      masterId: socket.id,
      players: {},
      numbers: {},
    };

    rooms[roomId].players[socket.id] = masterName;
    socket.join(roomId);

    socket.emit("master");
    socket.emit("roomCreated", roomId);

    io.to(roomId).emit("playersUpdate", Object.values(rooms[roomId].players));
  });

  // ✅ Entrar em sala (jogador)
  socket.on("joinRoom", ({ roomId, password, playerName }) => {
    roomId = (roomId || "").trim().toUpperCase();
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

    room.players[socket.id] = playerName;
    socket.join(roomId);

    socket.emit("joinedRoom", roomId);
    io.to(roomId).emit("playersUpdate", Object.values(room.players));
  });

  // 🎲 Distribuir números (por sala)
  socket.on("distribute", (roomId) => {
    roomId = (roomId || "").trim().toUpperCase();
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

  // 😈 Revelar números (por sala)
  socket.on("reveal", (roomId) => {
    roomId = (roomId || "").trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    if (socket.id !== room.masterId) return;

    const result = Object.keys(room.players).map((playerId) => ({
      name: room.players[playerId],
      number: room.numbers[playerId],
    }));

    io.to(roomId).emit("allNumbers", result);
  });

  // 🔌 Desconectar (limpa sala)
  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];

      if (room.players[socket.id]) {
        delete room.players[socket.id];
        delete room.numbers[socket.id];

        // Se o mestre saiu, passa o cargo
        if (room.masterId === socket.id) {
          const remaining = Object.keys(room.players);
          room.masterId = remaining.length ? remaining[0] : null;
          if (room.masterId) io.to(room.masterId).emit("master");
        }

        io.to(roomId).emit("playersUpdate", Object.values(room.players));

        // Apaga sala vazia
        if (Object.keys(room.players).length === 0) {
          delete rooms[roomId];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ITO Online rodando na porta ${PORT}`);
});
