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
  });
}

function closeRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // avisa todo mundo que a sala fechou
  io.to(roomId).emit("roomClosed");

  // faz os sockets saírem da sala (limpeza)
  for (const id of Object.keys(room.players)) {
    const s = io.sockets.sockets.get(id);
    if (s) s.leave(roomId);
  }

  delete rooms[roomId];
}

io.on("connection", (socket) => {
  // ✅ Criar sala (mestre)
  socket.on("roomCreated", ({ roomId, gameType }) => {
  // redireciona para a página do jogo
  const url = `/games/${gameType}.html?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(nickname)}`;
  window.location.href = url;
});

  // se o cliente mandou um código (UX etapa 2), usamos ele
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
    // fallback: gerar no servidor (caso futuro)
    let newId = generateRoomId();
    while (rooms[newId]) newId = generateRoomId();
    roomId = newId;
  }

  rooms[roomId] = {
    password,
    gameType: gameType || "ito",
    masterId: socket.id,
    players: {},
    numbers: {},
  };

  rooms[roomId].players[socket.id] = masterName;
  socket.join(roomId);

  socket.emit("master");
  socket.emit("roomCreated", { roomId, gameType: rooms[roomId].gameType });

  // Se você ainda usa playersUpdate simples, pode manter assim:
  io.to(roomId).emit("playersUpdate", Object.values(rooms[roomId].players));
});


  // ✅ Entrar em sala (jogador)
  socket.on("joinedRoom", (roomId) => {
  // como o joinRoom do server devolve roomId (string)
  const gameType = selectedGame;
  const url = `/games/${gameType}.html?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(nickname)}`;
  window.location.href = url;
});

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
    emitPlayersUpdate(roomId);
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

  // 😈 Revelar números (por sala) - ordenado do maior pro menor
  socket.on("reveal", (roomId) => {
    roomId = (roomId || "").trim().toUpperCase();
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

  // 🚪 Sair da sala (botão Sair)
  socket.on("leaveRoom", (roomId) => {
    roomId = (roomId || "").trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    // Se for o mestre: fecha a sala pra todo mundo
    if (socket.id === room.masterId) {
      closeRoom(roomId);
      return;
    }

    // Se for jogador: remove só ele
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

  // 🔌 Desconectar (limpa sala)
  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];

      if (room.players[socket.id]) {
        const wasMaster = room.masterId === socket.id;

        delete room.players[socket.id];
        delete room.numbers[socket.id];

        // Se o mestre caiu/desconectou: fecha a sala
        if (wasMaster) {
          closeRoom(roomId);
          continue;
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
server.listen(PORT, () => {
  console.log(`ITO Online rodando na porta ${PORT}`);
});



