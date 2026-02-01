const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

// ✅ Dados do Infiltrado
const INFILTRADO_DATA = require("./data/infiltradoData");

const app = express();
const server = http.createServer(app);

// ✅ Socket.IO mais tolerante a “idle” / abas em background / wifi oscilando
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingInterval: 25000,
  pingTimeout: 120000, // 2 min
  connectionStateRecovery: {
    maxDisconnectionDuration: 10 * 60 * 1000, // 10 min
    skipMiddlewares: true,
  },
});

app.use(express.static("public"));

const MAX_PLAYERS_PER_ROOM = 8;

const EMPTY_ROOM_GRACE_MS = 60_000;
// ✅ antes: 90s. Agora: 10 min
const RECONNECT_GRACE_MS = 10 * 60_000;

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
//   qse: {...}
//   spy: {...}
//   infiltrado: {...}
//   nota: {...} // ✅ e a nota é...
// }

function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function generateSessionKey() {
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

function getCallerToken(room, socketId) {
  return Object.keys(room.players).find((t) => room.players[t].socketId === socketId) || null;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function pickDistinct(arr, n) {
  return shuffle(arr).slice(0, Math.min(n, arr.length));
}

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

    if (pp.online) {
      pp.disconnectTimer = null;
      return;
    }

    // Antes de remover de vez, ajusta estados de jogos que dependem do player
    if (r.nota) {
      notaHandlePlayerRemoved(roomId, token);
    }

    delete r.players[token];
    delete r.sessions[token];
    delete r.numbers[token];

    // remove de jogos
    if (r.qse) {
      r.qse.active.delete(token);
      delete r.qse.submittedByWriter[token];
      delete r.qse.submissionTextByWriter[token];
      delete r.qse.characterByTarget[token];
      delete r.qse.revealedToTarget[token];
      delete r.qse.writingTargetByWriter[token];
    }
    if (r.spy) {
      r.spy.active.delete(token);
      delete r.spy.answersByToken[token];
      delete r.spy.votesByVoter[token];
    }
    if (r.infiltrado) {
      r.infiltrado.active.delete(token);
      delete r.infiltrado.votesByVoter[token];
    }

    if (r.masterToken === token) {
      const remaining = Object.keys(r.players);
      if (remaining.length) {
        const onlineFirst = remaining.find((t) => r.players[t].online) || remaining[0];
        r.masterToken = onlineFirst;
        const sid = r.players[onlineFirst].socketId;
        if (sid) io.to(sid).emit("master");
      } else {
        r.masterToken = null;
      }
    }

    if (Object.keys(r.players).length === 0) {
      scheduleEmptyRoomDeletion(roomId);
    }

    emitPlayersUpdate(roomId);
    if (r.gameType === "quem-sou-eu") emitQseWritingStatus(roomId);
    if (r.gameType === "impostor") emitSpyState(roomId);
    if (r.gameType === "infiltrado") emitInfiltradoState(roomId);
    if (r.gameType === "e-a-nota-e") emitNotaState(roomId);
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

function kickPlayer(roomId, token, reason = "Você foi expulso pelo mestre.") {
  const room = rooms[roomId];
  if (!room) return;

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

  // Ajusta jogos
  if (room.nota) notaHandlePlayerRemoved(roomId, token);

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
  if (room.spy) {
    room.spy.active.delete(token);
    delete room.spy.answersByToken[token];
    delete room.spy.votesByVoter[token];
  }
  if (room.infiltrado) {
    room.infiltrado.active.delete(token);
    delete room.infiltrado.votesByVoter[token];
  }

  if (room.masterToken === token) {
    const remaining = Object.keys(room.players);
    if (remaining.length) {
      const onlineFirst = remaining.find((t) => room.players[t].online) || remaining[0];
      room.masterToken = onlineFirst;
      const sid = room.players[onlineFirst].socketId;
      if (sid) io.to(sid).emit("master");
    } else {
      room.masterToken = null;
    }
  }

  emitPlayersUpdate(roomId);
  if (room.gameType === "quem-sou-eu") emitQseWritingStatus(roomId);
  if (room.gameType === "impostor") emitSpyState(roomId);
  if (room.gameType === "infiltrado") emitInfiltradoState(roomId);
  if (room.gameType === "e-a-nota-e") emitNotaState(roomId);

  if (Object.keys(room.players).length === 0) {
    scheduleEmptyRoomDeletion(roomId);
  }
}

/* ------------------ QUEM SOU EU ------------------ */

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

function emitQsePhase(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  ensureQse(room);
  io.to(roomId).emit("qsePhase", { phase: room.qse.phase });
}

function emitQseWritingStatus(roomId) {
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

function emitQseOthersCharacters(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  ensureQse(room);

  const activeTokens = Array.from(room.qse.active);
  const byTarget = room.qse.characterByTarget;

  activeTokens.forEach((viewerToken) => {
    const viewerSid = room.players[viewerToken]?.socketId;
    if (!viewerSid) return;

    const list = activeTokens
      .filter((targetToken) => targetToken !== viewerToken)
      .map((targetToken) => ({
        token: targetToken,
        name: room.players[targetToken]?.name || "Jogador",
        character: byTarget[targetToken],
      }));

    io.to(viewerSid).emit("qseOthersCharacters", list);
  });

  Object.keys(room.players).forEach((token) => {
    if (!room.qse.active.has(token)) {
      const sid = room.players[token].socketId;
      if (sid) io.to(sid).emit("qseExcluded");
    }
  });
}

/* ------------------ ESPIÃO ------------------ */

// 50 pares (principal + paralela)
const SPY_QUESTION_PAIRS = [
  { principal: "Marcas de carros de luxo mais bonitos", paralela: "Carros caros que mais chamam atenção" },
  { principal: "Carros esportivos famosos", paralela: "Carros rápidos que você conhece" },
  { principal: "Comidas chiques de restaurante caro", paralela: "Comidas caras que você já comeu" },
  { principal: "Comidas para ocasiões especiais", paralela: "Comidas para comemorar algo" },
  { principal: "Sobremesas sofisticadas", paralela: "Sobremesas mais cara que você já comeu" },
  { principal: "Destinos de viagem famosos", paralela: "Lugares turísticos que você gostaria de conhecer" },
  { principal: "Lugares que parecem caros", paralela: "Lugar mais luxuosos que você já viu em fotos ou filmes" },
  { principal: "Cidades famosas pelo turismo", paralela: "Cidades que você viajaria sem pensar duas vezes" },
  { principal: "Coisas que passam status", paralela: "Coisas que as pessoas acham chique" },
  { principal: "Itens caros que as pessoas compram", paralela: "Itens caros que você gostaria de ter" },
  { principal: "Filmes que todo mundo conhece", paralela: "Filmes famosos que você já assistiu" },
  { principal: "Séries que muita gente já viu", paralela: "Séries populares que você gosta" },
  { principal: "Jogos famosos", paralela: "Jogos que muita gente já jogou" },
  { principal: "Jogos bons para jogar em grupo", paralela: "Jogos divertidos para jogar com amigos" },
  { principal: "Personagens famosos do cinema", paralela: "Personagens famoso que você gosta" },
  { principal: "Personagens icônicos da cultura pop", paralela: "Personagens icônicos que você odeia" },
  { principal: "Artistas para ouvir treinando", paralela: "Artistas que te dão energia" },
  { principal: "Músicas para por em uma viagem de carro", paralela: "Músicas para cantar cantar no chuveiro" },
  { principal: "Artistas famosos atualmente", paralela: "Artistas que você escuta bastante" },
  { principal: "Músicas que animam uma festa", paralela: "Músicas que fazem você se animar" },
  { principal: "Bandas/artistas conhecidos mundialmente", paralela: "Bandas/artistas que todo mundo ouve" },
  { principal: "Aplicativos que todo mundo usa", paralela: "Aplicativos que você usa todo dia" },
  { principal: "Redes sociais populares", paralela: "Redes sociais que você mais usa" },
  { principal: "Tecnologias modernas", paralela: "Tecnologias que você acha interessantes" },
  { principal: "Coisas essenciais para o dia a dia", paralela: "Coisas que você usa todo dia" },
  { principal: "Coisas que facilitam a rotina", paralela: "Coisas que tornam a vida mais fácil" },
  { principal: "Hábitos comuns", paralela: "Hábitos que você tem" },
  { principal: "Animais fofos", paralela: "Animais que as pessoas gostam" },
  { principal: "Animais perigosos", paralela: "Animais que dão medo" },
  { principal: "Animais famosos", paralela: "Animais que todo mundo conhece" },
  { principal: "Qualidades de uma boa amizade", paralela: "Qualidades que você valoriza em amigos" },
  { principal: "Coisas que deixam alguém nervoso", paralela: "Coisas que te deixam nervoso" },
  { principal: "Coisas que dão vergonha", paralela: "Situações constrangedoras" },
  { principal: "Coisas legais para fazer no fim de semana", paralela: "Coisas que você gosta de fazer no tempo livre" },
  { principal: "Programas para relaxar", paralela: "Coisas que te ajudam a relaxar" },
  { principal: "Coisas que distraem no trabalho ou estudo", paralela: "Coisas que te fazem perder o foco" },
  { principal: "Motivos comuns para procrastinar", paralela: "Coisas que fazem você procrastinar" },
  { principal: "Itens que todo mundo compra no mercado", paralela: "Itens que você sempre compra" },
  { principal: "Coisas que você compraria se tivesse dinheiro", paralela: "Coisas que você gostaria de comprar" },
  { principal: "Coisas que todo mundo reclama", paralela: "Coisas que você reclama" },
  { principal: "Coisas que dão preguiça", paralela: "Coisas que você evita fazer" },
  { principal: "Coisas que deixam alguém com fome", paralela: "Coisas que te dão vontade de comer" },
  { principal: "Lanches famosos", paralela: "Lanches que você sempre pediria" },
  { principal: "Doces que todo mundo gosta", paralela: "Doces que você gosta" },
  { principal: "Esportes populares", paralela: "Esportes que você já praticou ou assistiu" },
  { principal: "Coisas legais pra fazer em casa", paralela: "Coisas que você faz quando tá entediado" },
  { principal: "Hobbies comuns", paralela: "Hobbies que você teria" },
  { principal: "Coisas que deixam alguém bravo", paralela: "Coisas que te irritam" },
  { principal: "Coisas que todo mundo já esqueceu em casa", paralela: "Coisas que você esquece com frequência" },
  { principal: "Coisas que você leva numa viagem", paralela: "Coisas que você não pode esquecer numa viagem" },
  { principal: "Coisas boas de ter no quarto", paralela: "Coisas que você gostaria no seu quarto" },
  { principal: "Coisas que combinam com verão", paralela: "Coisas que você faz no calor" },
];

function ensureSpy(room) {
  if (!room.spy) {
    room.spy = {
      phase: "lobby", // lobby | answering | voting | revealed
      active: new Set(),
      principal: null,
      paralela: null,
      spyToken: null,
      answersByToken: {},
      votesByVoter: {},
      revealed: false,
      lastAnswersPublic: null,
    };
  }
}

function spyReset(room) {
  ensureSpy(room);
  room.spy.phase = "lobby";
  room.spy.active = new Set();
  room.spy.principal = null;
  room.spy.paralela = null;
  room.spy.spyToken = null;
  room.spy.answersByToken = {};
  room.spy.votesByVoter = {};
  room.spy.revealed = false;
  room.spy.lastAnswersPublic = null;
}

function emitSpyState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  ensureSpy(room);

  const players = Object.keys(room.players).map((token) => ({
    token,
    name: room.players[token].name,
    online: !!room.players[token].online,
    isActive: room.spy.active.has(token),
    hasAnswered: !!room.spy.answersByToken[token],
  }));

  io.to(roomId).emit("spyState", {
    phase: room.spy.phase,
    principal: room.spy.principal,
    players,
    votesByVoter: room.spy.votesByVoter,
    answersPublic: room.spy.lastAnswersPublic,
  });
}

function countVotes(room) {
  const tally = {};
  for (const voter in room.spy.votesByVoter) {
    const target = room.spy.votesByVoter[voter];
    if (!target) continue;
    if (!room.spy.active.has(voter)) continue;
    if (!room.spy.active.has(target)) continue;
    tally[target] = (tally[target] || 0) + 1;
  }
  return tally;
}

function topVoteResult(room) {
  const tally = countVotes(room);
  const entries = Object.keys(tally).map((t) => ({ token: t, count: tally[t] }));
  if (entries.length === 0) return { ok: false, reason: "Ninguém votou ainda." };

  entries.sort((a, b) => b.count - a.count);

  const top = entries[0];
  const second = entries[1];

  if (second && second.count === top.count) {
    return { ok: false, reason: "Empate nos votos! Alguém precisa mudar o voto até ficar um mais votado." };
  }

  return { ok: true, topToken: top.token, topCount: top.count, tally };
}

/* ------------------ INFILTRADO ------------------ */

function ensureInfiltrado(room) {
  if (!room.infiltrado) {
    room.infiltrado = {
      phase: "lobby", // lobby | round1 | round2 | round3 | voting | revealed
      active: new Set(),

      themeKey: null,
      themeName: null,
      concept: null,
      infiltradoHint: null,
      infiltradoToken: null,

      questions: [],
      currentRound: 0,
      orderByRound: {},

      votesByVoter: {},
      revealedInfiltrator: false,
      revealedConcepts: false,
    };
  }
}

function infiltradoReset(room) {
  ensureInfiltrado(room);
  room.infiltrado.phase = "lobby";
  room.infiltrado.active = new Set();
  room.infiltrado.themeKey = null;
  room.infiltrado.themeName = null;
  room.infiltrado.concept = null;
  room.infiltrado.infiltradoHint = null;
  room.infiltrado.infiltradoToken = null;
  room.infiltrado.questions = [];
  room.infiltrado.currentRound = 0;
  room.infiltrado.orderByRound = {};
  room.infiltrado.votesByVoter = {};
  room.infiltrado.revealedInfiltrator = false;
  room.infiltrado.revealedConcepts = false;
}

function emitInfiltradoState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  ensureInfiltrado(room);

  const players = Object.keys(room.players).map((token) => ({
    token,
    name: room.players[token].name,
    online: !!room.players[token].online,
    isActive: room.infiltrado.active.has(token),
  }));

  io.to(roomId).emit("infiltradoState", {
    phase: room.infiltrado.phase,
    themeName: room.infiltrado.themeName,
    players,
    votesByVoter: room.infiltrado.votesByVoter,
    currentRound: room.infiltrado.currentRound,
    currentQuestion:
      room.infiltrado.currentRound > 0
        ? room.infiltrado.questions[room.infiltrado.currentRound - 1]
        : null,
    orderNames:
      room.infiltrado.currentRound > 0
        ? (room.infiltrado.orderByRound[room.infiltrado.currentRound] || [])
            .map((t) => room.players[t]?.name)
            .filter(Boolean)
        : [],
    revealedInfiltrator: !!room.infiltrado.revealedInfiltrator,
    revealedConcepts: !!room.infiltrado.revealedConcepts,
  });
}

function countVotesInfiltrado(room) {
  const tally = {};
  for (const voter in room.infiltrado.votesByVoter) {
    const target = room.infiltrado.votesByVoter[voter];
    if (!target) continue;
    if (!room.infiltrado.active.has(voter)) continue;
    if (!room.infiltrado.active.has(target)) continue;
    tally[target] = (tally[target] || 0) + 1;
  }
  return tally;
}

function topVoteResultInfiltrado(room) {
  const tally = countVotesInfiltrado(room);
  const entries = Object.keys(tally).map((t) => ({ token: t, count: tally[t] }));
  if (entries.length === 0) return { ok: false, reason: "Ninguém votou ainda." };

  entries.sort((a, b) => b.count - a.count);
  const top = entries[0];
  const second = entries[1];

  if (second && second.count === top.count) {
    return { ok: false, reason: "Empate nos votos! Conversem e mudem o voto até ficar um mais votado." };
  }

  return { ok: true, topToken: top.token, topCount: top.count, tally };
}

function startInfiltradoRound(roomId) {
  const room = rooms[roomId];
  if (!room) return { ok: false, error: "Sala inválida." };
  ensureInfiltrado(room);
  infiltradoReset(room);

  const tokens = Object.keys(room.players).filter((t) => room.players[t].online);
  if (tokens.length < 2) return { ok: false, error: "Precisa de pelo menos 2 jogadores online para iniciar." };

  const themeKeys = Object.keys(INFILTRADO_DATA.themes);
  const themeKey = pickOne(themeKeys);
  const theme = INFILTRADO_DATA.themes[themeKey];

  const concept = pickOne(theme.concepts);
  const infiltradoHint = pickOne(theme.infiltratorHints);
  const questions = pickDistinct(theme.questions, 3);
  const infiltradoToken = pickOne(tokens);

  room.infiltrado.phase = "round1";
  room.infiltrado.active = new Set(tokens);
  room.infiltrado.themeKey = themeKey;
  room.infiltrado.themeName = theme.name;
  room.infiltrado.concept = concept;
  room.infiltrado.infiltradoHint = infiltradoHint;
  room.infiltrado.infiltradoToken = infiltradoToken;
  room.infiltrado.questions = questions;
  room.infiltrado.currentRound = 1;
  room.infiltrado.votesByVoter = {};
  room.infiltrado.revealedInfiltrator = false;
  room.infiltrado.revealedConcepts = false;

  room.infiltrado.orderByRound[1] = shuffle(tokens);

  tokens.forEach((t) => {
    const sid = room.players[t]?.socketId;
    if (!sid) return;

    if (t === infiltradoToken) {
      io.to(sid).emit("infiltradoSecret", {
        role: "infiltrado",
        themeName: room.infiltrado.themeName,
        hint: infiltradoHint,
      });
    } else {
      io.to(sid).emit("infiltradoSecret", {
        role: "jogador",
        themeName: room.infiltrado.themeName,
        concept,
      });
    }
  });

  io.to(roomId).emit("infiltradoRound", {
    round: 1,
    question: room.infiltrado.questions[0],
    order: room.infiltrado.orderByRound[1].map((t) => room.players[t]?.name).filter(Boolean),
  });

  emitInfiltradoState(roomId);
  return { ok: true };
}

function goNextInfiltradoRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  ensureInfiltrado(room);

  if (!["round1", "round2", "round3"].includes(room.infiltrado.phase)) return;

  const next = room.infiltrado.currentRound + 1;
  const tokens = Array.from(room.infiltrado.active).filter((t) => room.players[t]?.online);

  if (tokens.length < 2) {
    room.infiltrado.phase = "lobby";
    io.to(roomId).emit("infiltradoRoundCancelled", "Poucas pessoas online. Rodada cancelada.");
    emitInfiltradoState(roomId);
    return;
  }

  if (next > 3) {
    room.infiltrado.phase = "voting";
    room.infiltrado.currentRound = 3;
    io.to(roomId).emit("infiltradoVotingOpened");
    emitInfiltradoState(roomId);
    return;
  }

  room.infiltrado.currentRound = next;
  room.infiltrado.phase = next === 2 ? "round2" : "round3";
  room.infiltrado.orderByRound[next] = shuffle(tokens);

  io.to(roomId).emit("infiltradoRound", {
    round: next,
    question: room.infiltrado.questions[next - 1],
    order: room.infiltrado.orderByRound[next].map((t) => room.players[t]?.name).filter(Boolean),
  });

  emitInfiltradoState(roomId);
}

/* ------------------ E A NOTA É... (NOVO) ------------------ */

function ensureNota(room) {
  if (!room.nota) {
    room.nota = {
      phase: "lobby", // lobby | guessing | revealed
      active: new Set(), // tokens do ciclo atual
      turnOrder: [],     // ordem do ciclo
      turnIndex: 0,

      targetToken: null,
      targetRating: null,

      guessesByToken: {}, // token -> 1..10
      scores: {},         // token -> pontos (persistente enquanto sala existir)

      cycleId: 0,
    };
  }
}

function notaResetTurn(room) {
  ensureNota(room);
  room.nota.phase = "lobby";
  room.nota.targetToken = null;
  room.nota.targetRating = null;
  room.nota.guessesByToken = {};
}

function notaStartNewCycle(roomId) {
  const room = rooms[roomId];
  if (!room) return { ok: false, error: "Sala inválida." };
  ensureNota(room);

  const tokens = Object.keys(room.players).filter(t => room.players[t]?.online);
  if (tokens.length < 2) return { ok: false, error: "Precisa de pelo menos 2 jogadores online para iniciar." };

  room.nota.cycleId += 1;
  room.nota.active = new Set(tokens);
  room.nota.turnOrder = shuffle(tokens); // ✅ aleatório no início do ciclo
  room.nota.turnIndex = 0;
  notaResetTurn(room);

  // garante scores inicializados
  tokens.forEach(t => { if (room.nota.scores[t] == null) room.nota.scores[t] = 0; });

  io.to(roomId).emit("notaCycleStarted", {
    cycleId: room.nota.cycleId,
    order: room.nota.turnOrder.map(t => room.players[t]?.name).filter(Boolean),
  });

  emitNotaState(roomId);
  return { ok: true };
}

function notaPickNextOnlineTarget(room) {
  // tenta achar próximo alvo online dentro do turnOrder
  for (let tries = 0; tries < room.nota.turnOrder.length; tries++) {
    const idx = room.nota.turnIndex % room.nota.turnOrder.length;
    const token = room.nota.turnOrder[idx];
    if (token && room.players[token]?.online && room.nota.active.has(token)) {
      return token;
    }
    room.nota.turnIndex += 1;
  }
  return null;
}

function notaStartTurn(roomId) {
  const room = rooms[roomId];
  if (!room) return { ok: false, error: "Sala inválida." };
  ensureNota(room);

  // se não tem ciclo, cria um
  if (!room.nota.turnOrder.length || room.nota.active.size < 2) {
    const res = notaStartNewCycle(roomId);
    if (!res.ok) return res;
  }

  // se terminou o ciclo, cria outro
  if (room.nota.turnIndex >= room.nota.turnOrder.length) {
    const res = notaStartNewCycle(roomId);
    if (!res.ok) return res;
  }

  // escolhe próximo alvo online
  const targetToken = notaPickNextOnlineTarget(room);
  if (!targetToken) {
    notaResetTurn(room);
    emitNotaState(roomId);
    return { ok: false, error: "Poucas pessoas online para continuar." };
  }

  // começa turno
  room.nota.phase = "guessing";
  room.nota.targetToken = targetToken;
  room.nota.targetRating = Math.floor(Math.random() * 10) + 1; // 1..10
  room.nota.guessesByToken = {};

  // inicializa scores se necessário
  if (room.nota.scores[targetToken] == null) room.nota.scores[targetToken] = 0;

  // envia segredo pro alvo
  const targetSid = room.players[targetToken]?.socketId;
  if (targetSid) {
    io.to(targetSid).emit("notaSecret", {
      rating: room.nota.targetRating,
      targetName: room.players[targetToken]?.name || "Jogador",
    });
  }

  // envia prompt pros outros
  const targetName = room.players[targetToken]?.name || "Jogador";
  Object.keys(room.players).forEach((t) => {
    const sid = room.players[t]?.socketId;
    if (!sid) return;

    // só participantes do ciclo
    if (!room.nota.active.has(t)) return;

    if (t !== targetToken) {
      io.to(sid).emit("notaPromptGuess", { targetName });
    }
  });

  io.to(roomId).emit("notaTurnStarted", { targetName });

  emitNotaState(roomId);
  return { ok: true };
}

function notaReveal(roomId) {
  const room = rooms[roomId];
  if (!room) return { ok: false, error: "Sala inválida." };
  ensureNota(room);

  if (room.nota.phase !== "guessing") return { ok: false, error: "Nenhum turno em andamento." };
  const targetToken = room.nota.targetToken;
  const rating = room.nota.targetRating;

  if (!targetToken || !rating) return { ok: false, error: "Estado inválido do turno." };

  // conta acertos
  const guesses = [];
  let hits = 0;

  for (const t of Object.keys(room.nota.guessesByToken)) {
    if (!room.nota.active.has(t)) continue; // já saiu do ciclo
    const g = room.nota.guessesByToken[t];
    if (typeof g !== "number") continue;

    const name = room.players[t]?.name || "(desconectado)";
    guesses.push({ token: t, name, guess: g, hit: g === rating });

    if (g === rating) hits += 1;
  }

  // ✅ pontuação (Opção B)
  // quem acertou: +1
  guesses.forEach(x => {
    if (x.hit) {
      if (room.nota.scores[x.token] == null) room.nota.scores[x.token] = 0;
      room.nota.scores[x.token] += 1;
    }
  });

  // alvo: 1 + acertos
  if (room.nota.scores[targetToken] == null) room.nota.scores[targetToken] = 0;
  room.nota.scores[targetToken] += (1 + hits);

  room.nota.phase = "revealed";

  const targetName = room.players[targetToken]?.name || "(desconectado)";

  io.to(roomId).emit("notaRevealed", {
    targetToken,
    targetName,
    rating,
    hits,
    guesses: guesses.sort((a, b) => a.name.localeCompare(b.name)),
    addedToTarget: 1 + hits,
  });

  emitNotaState(roomId);
  return { ok: true };
}

function notaNextTurn(roomId) {
  const room = rooms[roomId];
  if (!room) return { ok: false, error: "Sala inválida." };
  ensureNota(room);

  // avança índice do ciclo (o alvo atual já foi)
  room.nota.turnIndex += 1;
  notaResetTurn(room);

  // tenta começar o próximo imediatamente
  return notaStartTurn(roomId);
}

function emitNotaState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  ensureNota(room);

  // placar (só players existentes)
  const scoreboard = Object.keys(room.players).map(t => ({
    token: t,
    name: room.players[t]?.name || "Jogador",
    points: room.nota.scores[t] || 0,
    online: !!room.players[t]?.online,
  })).sort((a, b) => b.points - a.points);

  const submitted = {};
  Object.keys(room.nota.guessesByToken).forEach(t => {
    submitted[t] = true;
  });

  const activeNames = Array.from(room.nota.active || []).map(t => room.players[t]?.name).filter(Boolean);

  io.to(roomId).emit("notaState", {
    phase: room.nota.phase,
    cycleId: room.nota.cycleId,
    activeNames,
    turnIndex: room.nota.turnIndex,
    turnOrderNames: (room.nota.turnOrder || []).map(t => room.players[t]?.name).filter(Boolean),
    targetToken: room.nota.targetToken,
    targetName: room.nota.targetToken ? (room.players[room.nota.targetToken]?.name || "Jogador") : null,
    submitted,
    scoreboard,
  });
}

function notaHandlePlayerRemoved(roomId, token) {
  const room = rooms[roomId];
  if (!room || !room.nota) return;

  // remove do ciclo e da ordem
  room.nota.active.delete(token);
  room.nota.turnOrder = (room.nota.turnOrder || []).filter(t => t !== token);
  delete room.nota.guessesByToken[token];
  delete room.nota.scores[token];

  // se ficou menos de 2 no ciclo, volta pra lobby
  if (room.nota.active.size < 2 || room.nota.turnOrder.length < 2) {
    notaResetTurn(room);
    emitNotaState(roomId);
    io.to(roomId).emit("notaTurnCancelled", "Poucas pessoas online/na sala. Turno cancelado.");
    return;
  }

  // se o removido era o alvo e o turno estava rolando, passa pro próximo automaticamente
  if (room.nota.phase === "guessing" && room.nota.targetToken === token) {
    io.to(roomId).emit("notaTargetLeft", "O alvo saiu/desconectou. Pulando para o próximo...");
    // garante que o índice do ciclo avance (o alvo perdeu a vez)
    room.nota.turnIndex += 1;
    notaResetTurn(room);
    // tenta iniciar próximo
    notaStartTurn(roomId);
    return;
  }

  emitNotaState(roomId);
}

/* ------------------ SOCKETS ------------------ */

io.on("connection", (socket) => {
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
      spy: null,
      infiltrado: null,
      nota: null, // ✅ novo
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
      emitQsePhase(roomId);
      emitQseWritingStatus(roomId);
    }
    if (gt === "impostor") {
      ensureSpy(rooms[roomId]);
      emitSpyState(roomId);
    }
    if (gt === "infiltrado") {
      ensureInfiltrado(rooms[roomId]);
      emitInfiltradoState(roomId);
    }
    if (gt === "e-a-nota-e") {
      ensureNota(rooms[roomId]);
      emitNotaState(roomId);
    }
  });

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

    const hasSession =
      room.sessions[playerToken] && sessionKey && room.sessions[playerToken] === sessionKey;

    if (!hasSession) {
      if (room.password !== password) {
        socket.emit("errorMessage", "Senha incorreta");
        return;
      }
      if (!room.players[playerToken] && Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) {
        socket.emit("errorMessage", "Sala cheia");
        return;
      }
      room.sessions[playerToken] = generateSessionKey();
    }

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

    if (!room.masterToken) {
      room.masterToken = playerToken;
      socket.emit("master");
    }
    if (room.masterToken === playerToken) {
      socket.emit("master");
    }

    socket.emit("joinedRoom", { roomId, gameType: room.gameType, sessionKey: room.sessions[playerToken] });

    emitPlayersUpdate(roomId);

    if (room.gameType === "quem-sou-eu") {
      ensureQse(room);
      emitQsePhase(roomId);
      emitQseWritingStatus(roomId);

      if (room.qse.phase === "playing" && room.qse.active.has(playerToken)) {
        const activeTokens = Array.from(room.qse.active);
        const list = activeTokens
          .filter((t) => t !== playerToken)
          .map((t) => ({
            token: t,
            name: room.players[t]?.name || "Jogador",
            character: room.qse.characterByTarget[t],
          }));
        io.to(socket.id).emit("qseOthersCharacters", list);

        if (room.qse.revealedToTarget[playerToken]) {
          io.to(socket.id).emit("qseYourCharacter", { character: room.qse.characterByTarget[playerToken] });
        }
      }
    }

    if (room.gameType === "impostor") {
      ensureSpy(room);
      emitSpyState(roomId);

      if (room.spy.phase === "answering" && room.spy.active.has(playerToken)) {
        const question = playerToken === room.spy.spyToken ? room.spy.paralela : room.spy.principal;
        io.to(socket.id).emit("spyQuestion", { question });
      }
    }

    if (room.gameType === "infiltrado") {
      ensureInfiltrado(room);
      emitInfiltradoState(roomId);

      if (room.infiltrado.phase !== "lobby" && room.infiltrado.active.has(playerToken)) {
        const isInf = playerToken === room.infiltrado.infiltradoToken;
        if (isInf) {
          io.to(socket.id).emit("infiltradoSecret", {
            role: "infiltrado",
            themeName: room.infiltrado.themeName,
            hint: room.infiltrado.infiltradoHint,
          });
        } else {
          io.to(socket.id).emit("infiltradoSecret", {
            role: "jogador",
            themeName: room.infiltrado.themeName,
            concept: room.infiltrado.concept,
          });
        }

        if (room.infiltrado.currentRound > 0) {
          const r = room.infiltrado.currentRound;
          const q = room.infiltrado.questions[r - 1] || null;
          const order = (room.infiltrado.orderByRound[r] || [])
            .map((t) => room.players[t]?.name)
            .filter(Boolean);
          io.to(socket.id).emit("infiltradoRound", { round: r, question: q, order });
        }
      }
    }

    if (room.gameType === "e-a-nota-e") {
      ensureNota(room);
      emitNotaState(roomId);

      // Se estiver rolando turno, reenvia o papel do usuário
      if (room.nota.phase === "guessing" && room.nota.targetToken === playerToken) {
        io.to(socket.id).emit("notaSecret", {
          rating: room.nota.targetRating,
          targetName: room.players[playerToken]?.name || "Jogador",
        });
      } else if (room.nota.phase === "guessing" && room.nota.targetToken && room.nota.active.has(playerToken)) {
        const targetName = room.players[room.nota.targetToken]?.name || "Jogador";
        io.to(socket.id).emit("notaPromptGuess", { targetName });
      }
    }
  });

  socket.on("kickPlayer", ({ roomId, targetToken }) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    const kickerToken = getCallerToken(room, socket.id);
    if (!kickerToken) return;
    if (room.masterToken !== kickerToken) return;

    if (!targetToken) return;
    if (targetToken === room.masterToken) return;

    kickPlayer(roomId, targetToken);
  });

  /* ------------------ ITO ------------------ */

  socket.on("distribute", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    const callerToken = getCallerToken(room, socket.id);
    if (!callerToken) return;
    if (callerToken !== room.masterToken) return;

    // ✅ avisa UI pra limpar revelação anterior
    io.to(roomId).emit("itoNewRound");

    room.numbers = {};
    const tokens = Object.keys(room.players).filter((t) => room.players[t].online);
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

    const callerToken = getCallerToken(room, socket.id);
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

  /* ------------------ QUEM SOU EU ------------------ */

  socket.on("qseStartRound", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "quem-sou-eu") return;

    const callerToken = getCallerToken(room, socket.id);
    if (!callerToken || callerToken !== room.masterToken) return;

    ensureQse(room);
    qseResetRound(room);

    // ✅ limpa a UI do "seu personagem" da rodada anterior
    io.to(roomId).emit("qseNewRound");

    const tokens = Object.keys(room.players).filter((t) => room.players[t].online);
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

    emitQsePhase(roomId);
    emitQseWritingStatus(roomId);
  });

  socket.on("qseSubmit", ({ roomId, text }) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "quem-sou-eu") return;

    const token = getCallerToken(room, socket.id);
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
    emitQseWritingStatus(roomId);
  });

  socket.on("qseCloseWriting", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "quem-sou-eu") return;

    const callerToken = getCallerToken(room, socket.id);
    if (!callerToken || callerToken !== room.masterToken) return;

    ensureQse(room);
    if (room.qse.phase !== "writing") return;

    const allActive = Array.from(room.qse.active);
    const survivors = allActive.filter((t) => !!room.qse.submittedByWriter[t]);

    if (survivors.length < 2) {
      room.qse.active = new Set(survivors);
      room.qse.phase = "lobby";
      emitQsePhase(roomId);
      emitQseWritingStatus(roomId);
      io.to(roomId).emit("qseRoundCancelled", "Poucas pessoas enviaram. Rodada cancelada.");
      return;
    }

    const map = derangement(survivors);
    if (!map) {
      room.qse.phase = "lobby";
      emitQsePhase(roomId);
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

    emitQsePhase(roomId);
    emitQseWritingStatus(roomId);
    emitQseOthersCharacters(roomId);
  });

  socket.on("qseRevealTo", ({ roomId, targetToken }) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "quem-sou-eu") return;

    const callerToken = getCallerToken(room, socket.id);
    if (!callerToken || callerToken !== room.masterToken) return;

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

  /* ------------------ ESPIÃO ------------------ */

  socket.on("spyStartRound", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "impostor") return;

    const callerToken = getCallerToken(room, socket.id);
    if (!callerToken || callerToken !== room.masterToken) return;

    ensureSpy(room);
    spyReset(room);

    const tokens = Object.keys(room.players).filter((t) => room.players[t].online);
    if (tokens.length < 2) {
      socket.emit("errorMessage", "Precisa de pelo menos 2 jogadores online para iniciar.");
      return;
    }

    const pair = SPY_QUESTION_PAIRS[Math.floor(Math.random() * SPY_QUESTION_PAIRS.length)];
    const spyToken = tokens[Math.floor(Math.random() * tokens.length)];

    room.spy.phase = "answering";
    room.spy.active = new Set(tokens);
    room.spy.principal = pair.principal;
    room.spy.paralela = pair.paralela;
    room.spy.spyToken = spyToken;

    tokens.forEach((t) => {
      const sid = room.players[t]?.socketId;
      if (!sid) return;
      const question = t === spyToken ? pair.paralela : pair.principal;
      io.to(sid).emit("spyQuestion", { question });
    });

    emitSpyState(roomId);
  });

  socket.on("spySubmitAnswer", ({ roomId, text }) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "impostor") return;

    const token = getCallerToken(room, socket.id);
    if (!token) return;

    ensureSpy(room);
    if (room.spy.phase !== "answering") {
      socket.emit("errorMessage", "Não estamos na fase de resposta.");
      return;
    }
    if (!room.spy.active.has(token)) {
      socket.emit("errorMessage", "Você não está ativo nessa rodada.");
      return;
    }

    const clean = (text || "").toString().trim();
    if (!clean) {
      socket.emit("errorMessage", "Digite uma resposta antes de enviar.");
      return;
    }
    if (clean.length > 80) {
      socket.emit("errorMessage", "Resposta muito grande. Use até 80 caracteres.");
      return;
    }

    room.spy.answersByToken[token] = clean;
    socket.emit("spyAnsweredOK");
    emitSpyState(roomId);
  });

  socket.on("spyRevealAnswers", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "impostor") return;

    const callerToken = getCallerToken(room, socket.id);
    if (!callerToken || callerToken !== room.masterToken) return;

    ensureSpy(room);
    if (room.spy.phase !== "answering") return;

    const allActive = Array.from(room.spy.active);
    const survivors = allActive.filter((t) => !!room.spy.answersByToken[t]);
    room.spy.active = new Set(survivors);

    if (survivors.length < 2) {
      room.spy.phase = "lobby";
      room.spy.lastAnswersPublic = null;
      io.to(roomId).emit("spyRoundCancelled", "Poucas pessoas responderam. Rodada cancelada.");
      emitSpyState(roomId);
      return;
    }

    room.spy.lastAnswersPublic = survivors.map((t) => ({
      token: t,
      name: room.players[t]?.name || "Jogador",
      answer: room.spy.answersByToken[t],
    }));

    room.spy.phase = "voting";
    room.spy.votesByVoter = {};

    io.to(roomId).emit("spyAnswersRevealed", {
      principal: room.spy.principal,
      answers: room.spy.lastAnswersPublic,
    });

    emitSpyState(roomId);
  });

  socket.on("spyVote", ({ roomId, targetToken }) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "impostor") return;

    const voterToken = getCallerToken(room, socket.id);
    if (!voterToken) return;

    ensureSpy(room);
    if (room.spy.phase !== "voting") {
      socket.emit("errorMessage", "A votação não está aberta.");
      return;
    }

    if (!room.spy.active.has(voterToken)) {
      socket.emit("errorMessage", "Você não está ativo nesta rodada.");
      return;
    }

    if (!room.spy.active.has(targetToken)) {
      socket.emit("errorMessage", "Você só pode votar em alguém da rodada.");
      return;
    }

    room.spy.votesByVoter[voterToken] = targetToken;
    emitSpyState(roomId);
  });

  socket.on("spyRevealSpy", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "impostor") return;

    const callerToken = getCallerToken(room, socket.id);
    if (!callerToken || callerToken !== room.masterToken) return;

    ensureSpy(room);
    if (room.spy.phase !== "voting") return;

    const res = topVoteResult(room);
    if (!res.ok) {
      io.to(roomId).emit("spyNeedResolve", res.reason);
      return;
    }

    room.spy.phase = "revealed";
    room.spy.revealed = true;

    const spyToken = room.spy.spyToken;
    const spyName = room.players[spyToken]?.name || "(desconectado)";

    io.to(roomId).emit("spyRevealed", {
      spyToken,
      spyName,
      principal: room.spy.principal,
      paralela: room.spy.paralela,
      topVotedToken: res.topToken,
      topVotedName: room.players[res.topToken]?.name || "Jogador",
      tally: res.tally,
    });

    emitSpyState(roomId);
  });

  /* ------------------ INFILTRADO ------------------ */

  socket.on("infiltradoStartRound", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "infiltrado") return;

    const callerToken = getCallerToken(room, socket.id);
    if (!callerToken || callerToken !== room.masterToken) return;

    const res = startInfiltradoRound(roomId);
    if (!res.ok) socket.emit("errorMessage", res.error || "Não foi possível iniciar.");
  });

  socket.on("infiltradoNextQuestion", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "infiltrado") return;

    const callerToken = getCallerToken(room, socket.id);
    if (!callerToken || callerToken !== room.masterToken) return;

    ensureInfiltrado(room);
    if (room.infiltrado.phase === "lobby") return;

    goNextInfiltradoRound(roomId);
  });

  socket.on("infiltradoVote", ({ roomId, targetToken }) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "infiltrado") return;

    const voterToken = getCallerToken(room, socket.id);
    if (!voterToken) return;

    ensureInfiltrado(room);

    if (!["round1", "round2", "round3", "voting"].includes(room.infiltrado.phase)) {
      socket.emit("errorMessage", "A rodada ainda não começou.");
      return;
    }

    if (!room.infiltrado.active.has(voterToken)) {
      socket.emit("errorMessage", "Você não está ativo nesta rodada.");
      return;
    }

    if (!room.infiltrado.active.has(targetToken)) {
      socket.emit("errorMessage", "Você só pode votar em alguém ativo.");
      return;
    }

    room.infiltrado.votesByVoter[voterToken] = targetToken;
    emitInfiltradoState(roomId);
  });

  socket.on("infiltradoReveal", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "infiltrado") return;

    const callerToken = getCallerToken(room, socket.id);
    if (!callerToken || callerToken !== room.masterToken) return;

    ensureInfiltrado(room);
    if (!["round1", "round2", "round3", "voting"].includes(room.infiltrado.phase)) return;

    const res = topVoteResultInfiltrado(room);
    if (!res.ok) {
      io.to(roomId).emit("infiltradoNeedResolve", res.reason);
      return;
    }

    room.infiltrado.phase = "revealed";
    room.infiltrado.revealedInfiltrator = true;
    room.infiltrado.revealedConcepts = false;

    const infToken = room.infiltrado.infiltradoToken;
    const infName = room.players[infToken]?.name || "(desconectado)";

    io.to(roomId).emit("infiltradoInfiltratorRevealed", {
      infiltradoToken: infToken,
      infiltradoName: infName,
      topVotedToken: res.topToken,
      topVotedName: room.players[res.topToken]?.name || "Jogador",
      tally: res.tally,
    });

    emitInfiltradoState(roomId);
  });

  socket.on("infiltradoRevealConcepts", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "infiltrado") return;

    const callerToken = getCallerToken(room, socket.id);
    if (!callerToken || callerToken !== room.masterToken) return;

    ensureInfiltrado(room);
    if (room.infiltrado.phase !== "revealed") {
      socket.emit("errorMessage", "Revele o infiltrado primeiro.");
      return;
    }

    room.infiltrado.revealedConcepts = true;

    io.to(roomId).emit("infiltradoConceptsRevealed", {
      themeName: room.infiltrado.themeName,
      concept: room.infiltrado.concept,
      infiltradoHint: room.infiltrado.infiltradoHint,
    });

    emitInfiltradoState(roomId);
  });

  /* ------------------ E A NOTA É... ------------------ */

  socket.on("notaStartTurn", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "e-a-nota-e") return;

    const callerToken = getCallerToken(room, socket.id);
    if (!callerToken || callerToken !== room.masterToken) return;

    ensureNota(room);
    const res = notaStartTurn(roomId);
    if (!res.ok) socket.emit("errorMessage", res.error || "Não foi possível iniciar.");
  });

  socket.on("notaSubmitGuess", ({ roomId, guess }) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "e-a-nota-e") return;

    const token = getCallerToken(room, socket.id);
    if (!token) return;

    ensureNota(room);

    if (room.nota.phase !== "guessing") {
      socket.emit("errorMessage", "Não estamos na fase de chute.");
      return;
    }

    if (!room.nota.active.has(token)) {
      socket.emit("errorMessage", "Você não está no ciclo atual.");
      return;
    }

    if (token === room.nota.targetToken) {
      socket.emit("errorMessage", "O alvo não pode chutar a própria nota.");
      return;
    }

    const n = Number(guess);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      socket.emit("errorMessage", "Chute inválido. Use um número de 1 a 10.");
      return;
    }

    room.nota.guessesByToken[token] = n;
    socket.emit("notaGuessOK");
    emitNotaState(roomId);
  });

  socket.on("notaReveal", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "e-a-nota-e") return;

    const callerToken = getCallerToken(room, socket.id);
    if (!callerToken || callerToken !== room.masterToken) return;

    ensureNota(room);
    const res = notaReveal(roomId);
    if (!res.ok) socket.emit("errorMessage", res.error || "Não foi possível revelar.");
  });

  socket.on("notaNextTurn", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "e-a-nota-e") return;

    const callerToken = getCallerToken(room, socket.id);
    if (!callerToken || callerToken !== room.masterToken) return;

    ensureNota(room);
    const res = notaNextTurn(roomId);
    if (!res.ok) socket.emit("errorMessage", res.error || "Não foi possível avançar.");
  });

  socket.on("notaResetScores", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room || room.gameType !== "e-a-nota-e") return;

    const callerToken = getCallerToken(room, socket.id);
    if (!callerToken || callerToken !== room.masterToken) return;

    ensureNota(room);
    room.nota.scores = {};
    emitNotaState(roomId);
    io.to(roomId).emit("notaScoresReset");
  });

  /* ------------------ sair / disconnect ------------------ */

  socket.on("leaveRoom", (roomId) => {
    roomId = (roomId || "").toString().trim().toUpperCase();
    const room = rooms[roomId];
    if (!room) return;

    const token = getCallerToken(room, socket.id);
    if (!token) return;

    if (token === room.masterToken) {
      closeRoom(roomId);
      return;
    }

    cancelPlayerRemoval(roomId, token);

    // Ajusta jogos que dependem desse token
    if (room.nota) notaHandlePlayerRemoved(roomId, token);

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
    if (room.spy) {
      room.spy.active.delete(token);
      delete room.spy.answersByToken[token];
      delete room.spy.votesByVoter[token];
    }
    if (room.infiltrado) {
      room.infiltrado.active.delete(token);
      delete room.infiltrado.votesByVoter[token];
    }

    socket.leave(roomId);

    emitPlayersUpdate(roomId);
    if (room.gameType === "quem-sou-eu") emitQseWritingStatus(roomId);
    if (room.gameType === "impostor") emitSpyState(roomId);
    if (room.gameType === "infiltrado") emitInfiltradoState(roomId);
    if (room.gameType === "e-a-nota-e") emitNotaState(roomId);

    if (Object.keys(room.players).length === 0) {
      scheduleEmptyRoomDeletion(roomId);
    }
  });

  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const token = getCallerToken(room, socket.id);
      if (!token) continue;

      room.players[token].online = false;
      room.players[token].socketId = null;

      // se for o jogo de nota e o cara é o alvo,
      // a gente NÃO pula imediatamente — só pula quando for removido de fato (10 min)
      // (isso evita pular turno por oscilação curta)
      schedulePlayerRemoval(roomId, token);

      emitPlayersUpdate(roomId);
      if (room.gameType === "quem-sou-eu") emitQseWritingStatus(roomId);
      if (room.gameType === "impostor") emitSpyState(roomId);
      if (room.gameType === "infiltrado") emitInfiltradoState(roomId);
      if (room.gameType === "e-a-nota-e") emitNotaState(roomId);

      if (Object.keys(room.players).length === 0) {
        scheduleEmptyRoomDeletion(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
