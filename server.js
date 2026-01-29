const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});


app.use(express.static("public"));

const MAX_PLAYERS_PER_ROOM = 8;

const rooms = {}; 
// roomId -> {
//   password,
//   masterId,
//   players: {},
//   numbers: {}
// }

io.on("connection", (socket) => {
  
  socket.on("createRoom", ({ roomId, password, masterName }) => {
  if (rooms[roomId]) {
    socket.emit("errorMessage", "Sala já existe");
    return;
  }
    
  rooms[roomId] = {
    password,
    masterId: socket.id,
    players: {},
    numbers: {}
  };

  rooms[roomId].players[socket.id] = masterName;

  socket.join(roomId);

  socket.emit("master");
  socket.emit("roomCreated", roomId);
  io.to(roomId).emit(
    "playersUpdate",
    Object.values(rooms[roomId].players)
  );
});

  socket.on("joinRoom", ({ roomId, password, playerName }) => {
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

    io.to(roomId).emit(
      "playersUpdate",
      Object.values(room.players)
    );
  });
socket.on("distribute", (roomId) => {
  const room = rooms[roomId];

  if (!room) return;

  // Só o mestre pode distribuir
  if (socket.id !== room.masterId) return;

  room.numbers = {};

  // Cria números de 1 a 100 e embaralha
  let pool = Array.from({ length: 100 }, (_, i) => i + 1)
    .sort(() => Math.random() - 0.5);

  Object.keys(room.players).forEach((playerId, index) => {
    room.numbers[playerId] = pool[index];
    io.to(playerId).emit("number", pool[index]);
  });
});

  socket.on("reveal", (roomId) => {
  const room = rooms[roomId];
  if (!room) return;

  // Só o mestre pode revelar
  if (socket.id !== room.masterId) return;

  const result = [];

  for (let playerId in room.players) {
    result.push({
      name: room.players[playerId],
      number: room.numbers[playerId]
    });
  }

  io.to(roomId).emit("allNumbers", result);
});

  socket.on("disconnect", () => {
  for (let roomId in rooms) {
    const room = rooms[roomId];

    if (room.players[socket.id]) {
      delete room.players[socket.id];
      delete room.numbers[socket.id];

      // Se o mestre saiu, passa o cargo
      if (room.masterId === socket.id) {
        const remaining = Object.keys(room.players);
        room.masterId = remaining.length ? remaining[0] : null;
        if (room.masterId) {
          io.to(room.masterId).emit("master");
        }
      }

      // Atualiza lista da sala
      io.to(roomId).emit(
        "playersUpdate",
        Object.values(room.players)
      );

      // Remove sala vazia
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



