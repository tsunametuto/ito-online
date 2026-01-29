const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const MAX_PLAYERS = 8;

let players = {};      // socket.id -> nome
let numbers = {};      // socket.id -> numero
let masterId = null;

io.on("connection", (socket) => {

  socket.on("join", (name) => {
    if (Object.keys(players).length >= MAX_PLAYERS) {
      socket.emit("full");
      return;
    }

    players[socket.id] = name;

    if (!masterId) {
      masterId = socket.id;
      socket.emit("master");
    }

    io.emit("players", Object.values(players));
  });

  socket.on("distribute", () => {
    if (socket.id !== masterId) return;

    numbers = {};
    let pool = Array.from({ length: 100 }, (_, i) => i + 1)
      .sort(() => Math.random() - 0.5);

    Object.keys(players).forEach((id, index) => {
      numbers[id] = pool[index];
      io.to(id).emit("number", pool[index]);
    });
  });

  socket.on("reveal", () => {
    if (socket.id !== masterId) return;

    let result = [];
    for (let id in players) {
      result.push({
        name: players[id],
        number: numbers[id]
      });
    }

    io.emit("allNumbers", result);
  });

  socket.on("leave", () => {
    socket.disconnect();
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    delete numbers[socket.id];

    if (socket.id === masterId) {
      masterId = Object.keys(players)[0] || null;
      if (masterId) io.to(masterId).emit("master");
    }

    io.emit("players", Object.values(players));
  });
});

server.listen(3000, () => {
  console.log("ITO Online rodando na porta 3000");
});
