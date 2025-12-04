// ===================================
// IMPORT LIBRARY
// ===================================
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const multer = require('multer');
const xlsx = require('xlsx');
require('dotenv').config();

// ===================================
// INISIALISASI EXPRESS & HTTP SERVER
// ===================================
const app = express();
const server = http.createServer(app);

// ===================================
// INISIALISASI WEBSOCKET SERVER
// ===================================
const wss = new WebSocket.Server({ server });

// ===================================
// IN-MEMORY DATABASE
// ===================================
const rooms = {}; // { roomCode: { code, host, players, quiz, chat, createdAt, lastActivity } }
const users = {}; // { clientId: { clientId, username, currentRoom, ws } }

// Counter untuk generate unique client ID
let clientIdCounter = 0;

// Bank soal quiz
const quizBank = [
  {
    question: 'Berapa hasil 5 + 3?',
    options: ['6', '7', '8', '9'],
    correct: 2,
    timer: 15
  },
  {
    question: 'Ibu kota Indonesia adalah?',
    options: ['Bandung', 'Jakarta', 'Surabaya', 'Medan'],
    correct: 1,
    timer: 15
  },
  {
    question: 'Planet terdekat dengan matahari?',
    options: ['Venus', 'Merkurius', 'Bumi', 'Mars'],
    correct: 1,
    timer: 15
  },
  {
    question: 'Berapa jumlah hari dalam 1 tahun kabisat?',
    options: ['364', '365', '366', '367'],
    correct: 2,
    timer: 15
  },
  {
    question: '2 x 8 = ?',
    options: ['14', '16', '18', '20'],
    correct: 1,
    timer: 10
  },
  {
    question: 'Bahasa pemrograman untuk web frontend?',
    options: ['Python', 'JavaScript', 'Java', 'C++'],
    correct: 1,
    timer: 12
  },
  {
    question: 'HTTP adalah singkatan dari?',
    options: ['HyperText Transfer Protocol', 'High Transfer Text Protocol', 'HyperText Transport Protocol', 'High Text Transfer Protocol'],
    correct: 0,
    timer: 15
  },
  {
    question: 'Berapa hasil 12 x 12?',
    options: ['124', '144', '154', '164'],
    correct: 1,
    timer: 10
  }
];

const QUESTION_TRANSITION_DELAY = 3000;

// ===================================
// EXPRESS MIDDLEWARE
// ===================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Multer (memory storage) untuk upload file sementara
const upload = multer({ storage: multer.memoryStorage() });

// API: Upload questions (Excel/CSV) - only host can upload for a room
app.post('/api/upload-questions', upload.single('file'), (req, res) => {
  try {
    const file = req.file;
    const { roomCode, clientId } = req.body || {};

    if (!file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    if (!roomCode) return res.status(400).json({ success: false, message: 'Missing roomCode' });
    if (!clientId) return res.status(400).json({ success: false, message: 'Missing clientId' });

    const room = rooms[roomCode];
    if (!room) return res.status(404).json({ success: false, message: 'Room not found' });

    // Verify uploader is host of the room
    if (room.host !== clientId) {
      return res.status(403).json({ success: false, message: 'Only host can upload questions' });
    }

    // Parse file buffer with xlsx
    const workbook = xlsx.read(file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    const parsedQuestions = [];

    // Expected columns: question, optionA, optionB, optionC, optionD, correct, timer
    rows.forEach((r, idx) => {
      const questionText = (r.question || r.Question || r['Question'] || '').toString().trim();
      const optA = (r.optionA || r.OptionA || r['A'] || r['option A'] || r['Option A'] || r['OptionA'] || '').toString().trim();
      const optB = (r.optionB || r.OptionB || r['B'] || r['option B'] || r['Option B'] || r['OptionB'] || '').toString().trim();
      const optC = (r.optionC || r.OptionC || r['C'] || r['option C'] || r['Option C'] || r['OptionC'] || '').toString().trim();
      const optD = (r.optionD || r.OptionD || r['D'] || r['option D'] || r['Option D'] || r['OptionD'] || '').toString().trim();
      let correct = r.correct ?? r.Correct ?? r['Correct'] ?? r.answer ?? r.Answer ?? '';
      let timer = r.timer ?? r.Timer ?? r['Time'] ?? r['time'] ?? 15;

      if (!questionText) return; // skip empty rows

      // Normalize correct: allow 'A'/'B'/'C'/'D' or 0-3
      if (typeof correct === 'string') {
        correct = correct.trim().toUpperCase();
        if (['A','B','C','D'].includes(correct)) {
          correct = ['A','B','C','D'].indexOf(correct);
        } else if (!isNaN(Number(correct))) {
          correct = parseInt(correct, 10);
        } else {
          correct = 0;
        }
      } else if (typeof correct === 'number') {
        correct = parseInt(correct, 10);
      } else {
        correct = 0;
      }

      timer = parseInt(timer, 10) || 15;

      const questionObj = {
        question: questionText,
        options: [optA || 'A', optB || 'B', optC || 'C', optD || 'D'],
        correct: Math.max(0, Math.min(3, correct || 0)),
        timer: Math.max(10, Math.min(300, timer))
      };

      parsedQuestions.push(questionObj);
    });

    if (parsedQuestions.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid questions found in file' });
    }

    // Return parsed questions to client (client will add to room via start-quiz)
    return res.json({ success: true, questions: parsedQuestions });
  } catch (err) {
    console.error('❌ Error parsing uploaded questions:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to parse file' });
  }
});

// ===================================
// EXPRESS ROUTES
// ===================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API: Server status
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    totalRooms: Object.keys(rooms).length,
    totalUsers: Object.keys(users).length,
    wsConnections: wss.clients.size,
    timestamp: new Date().toISOString()
  });
});

// API: Get room info (untuk debugging)
app.get('/api/room/:code', (req, res) => {
  const room = rooms[req.params.code];
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  res.json({
    code: room.code,
    totalPlayers: room.players.length,
    players: room.players.map(p => p.username),
    status: room.quiz.status,
    currentQuestion: room.quiz.currentQuestion,
    questionStartTime: room.quiz.questionStartTime || null,
    questionTimer: (room.quiz.currentQuestion >= 0 && room.quiz.questions[room.quiz.currentQuestion]) ? room.quiz.questions[room.quiz.currentQuestion].timer : null,
    createdAt: new Date(room.createdAt).toISOString()
  });
});

// ===================================
// HELPER FUNCTIONS
// ===================================

// Generate random room code
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  if (rooms[code]) {
    return generateRoomCode();
  }
  return code;
}

// Generate unique client ID
function generateClientId() {
  return `client_${++clientIdCounter}_${Date.now()}`;
}

// Send message to specific client
function sendToClient(clientId, type, data) {
  const user = users[clientId];
  if (user && user.ws && user.ws.readyState === WebSocket.OPEN) {
    try {
      user.ws.send(JSON.stringify({ type, data }));
      return true;
    } catch (error) {
      console.error(`❌ Error sending to ${clientId}:`, error.message);
      return false;
    }
  }
  return false;
}

// Broadcast to all clients in a room
function broadcastToRoom(roomCode, type, data, excludeClientId = null) {
  const room = rooms[roomCode];
  if (!room) return;

  let sentCount = 0;
  room.players.forEach(player => {
    if (player.clientId !== excludeClientId) {
      if (sendToClient(player.clientId, type, data)) {
        sentCount++;
      }
    }
  });

  console.log(`📤 Broadcast [${type}] to room ${roomCode}: ${sentCount} clients`);
}

// Broadcast to ALL clients in a room (including sender)
function broadcastToRoomAll(roomCode, type, data) {
  const room = rooms[roomCode];
  if (!room) return;

  let sentCount = 0;
  room.players.forEach(player => {
    if (sendToClient(player.clientId, type, data)) {
      sentCount++;
    }
  });

  console.log(`📤 Broadcast [${type}] to ALL in room ${roomCode}: ${sentCount} clients`);
}

// Cleanup empty rooms (hanya hapus room yang kosong lebih dari 5 menit)
function cleanupEmptyRooms() {
  const now = Date.now();
  const EMPTY_ROOM_TIMEOUT = 5 * 60 * 1000; // 5 menit

  for (const code in rooms) {
    const room = rooms[code];
    if (room.players.length === 0) {
      const timeSinceLastActivity = now - room.lastActivity;
      if (timeSinceLastActivity > EMPTY_ROOM_TIMEOUT) {
        console.log(`🗑️  Cleaning up empty room: ${code} (inactive for ${Math.round(timeSinceLastActivity / 1000 / 60)} minutes)`);
        delete rooms[code];
      }
    }
  }
}

// Send question to room
function sendQuestion(roomCode, questionIndex) {
  const room = rooms[roomCode];
  if (!room) return;

  const question = room.quiz.questions[questionIndex];

  room.quiz.answeredCount = 0;
  room.quiz.totalPlayers = room.players.length;
  room.quiz.questionStartTime = Date.now();

  broadcastToRoomAll(roomCode, 'new-question', {
    questionNumber: questionIndex + 1,
    totalQuestions: room.quiz.questions.length,
    question: question.question,
    options: question.options,
    timer: question.timer,
    startTime: room.quiz.questionStartTime
  });

  console.log(`📤 Sent Q${questionIndex + 1} to room ${roomCode}`);

  if (room.quiz.transitionTimeout) {
    clearTimeout(room.quiz.transitionTimeout);
  }

  room.quiz.transitionTimeout = setTimeout(() => {
    goToNextQuestion(roomCode);
  }, (question.timer + 2) * 1000); // timer + 2 detik buffer
}

// Pindah ke soal berikutnya otomatis
function goToNextQuestion(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const nextIndex = room.quiz.currentQuestion + 1;

  if (nextIndex >= room.quiz.questions.length) {
    finishQuiz(roomCode);
  } else {
    room.quiz.currentQuestion = nextIndex;
    sendQuestion(roomCode, nextIndex);
  }
}

// Broadcast leaderboard
function broadcastLeaderboard(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const leaderboard = room.players
    .map(p => ({
      username: p.username,
      score: p.score,
      answeredCount: p.answers.length
    }))
    .sort((a, b) => b.score - a.score);

  broadcastToRoomAll(roomCode, 'leaderboard-update', { leaderboard });
}

// Finish quiz
function finishQuiz(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.quiz.status = 'finished';

  const leaderboard = room.players
    .map(p => ({
      username: p.username,
      score: p.score,
      correctAnswers: p.answers.filter(a => a.isCorrect).length,
      totalAnswers: p.answers.length,
      accuracy: p.answers.length > 0
        ? Math.round((p.answers.filter(a => a.isCorrect).length / p.answers.length) * 100)
        : 0
    }))
    .sort((a, b) => b.score - a.score);

  broadcastToRoomAll(roomCode, 'quiz-finished', {
    leaderboard: leaderboard,
    message: 'Quiz selesai! Terima kasih sudah bermain 🎉'
  });

  console.log(`🏁 Quiz finished in room ${roomCode}`);
  if (leaderboard[0]) {
    console.log(`   Winner: ${leaderboard[0].username} (${leaderboard[0].score} pts)`);
  }
}

// ===================================
// WEBSOCKET CONNECTION HANDLER
// ===================================
wss.on('connection', (ws) => {
  // Generate unique client ID
  const clientId = generateClientId();

  console.log(`✅ WebSocket connected: ${clientId}`);

  // Simpan WebSocket connection sementara
  let tempClientId = clientId;

  // Kirim client ID ke client
  ws.send(JSON.stringify({
    type: 'connected',
    data: { clientId }
  }));

  // ===================================
  // WEBSOCKET MESSAGE HANDLER
  // ===================================
  ws.on('message', (message) => {
    try {
      const { type, data } = JSON.parse(message);

      console.log(`📩 Received [${type}] from ${tempClientId}`);

      // ===================================
      // HANDLER: CREATE ROOM
      // ===================================
      if (type === 'create-room') {
        const { username } = data;
        const roomCode = generateRoomCode();

        // Buat room baru
        rooms[roomCode] = {
          code: roomCode,
          host: tempClientId,
          hostUsername: username,
          players: [
            {
              clientId: tempClientId,
              username: username,
              score: 0,
              answers: []
            }
          ],
          quiz: {
            currentQuestion: -1,
            questions: [...quizBank],
            status: 'waiting',
            startTime: null
          },
          chat: [],
          createdAt: Date.now(),
          lastActivity: Date.now()
        };

        // Update user data
        users[tempClientId] = {
          clientId: tempClientId,
          username: username,
          currentRoom: roomCode,
          ws: ws
        };

        console.log(`🏠 Room created: ${roomCode} by ${username} (${tempClientId})`);
        console.log(`   📊 Total rooms: ${Object.keys(rooms).length}, users: ${Object.keys(users).length}`);

        // Kirim response
        ws.send(JSON.stringify({
          type: 'room-created',
          data: {
            success: true,
            roomCode: roomCode,
            isHost: true
          }
        }));
      }

      // ===================================
      // HANDLER: JOIN ROOM
      // ===================================
      else if (type === 'join-room') {
        const { roomCode, username } = data;

        console.log(`🚪 Join attempt: ${username} → ${roomCode}`);

        if (!rooms[roomCode]) {
          console.log(`   ❌ Room ${roomCode} not found`);
          ws.send(JSON.stringify({
            type: 'join-error',
            data: { message: 'Room tidak ditemukan!' }
          }));
          return;
        }

        if (rooms[roomCode].players.length >= 10) {
          ws.send(JSON.stringify({
            type: 'join-error',
            data: { message: 'Room sudah penuh!' }
          }));
          return;
        }

        if (rooms[roomCode].quiz.status === 'playing') {
          ws.send(JSON.stringify({
            type: 'join-error',
            data: { message: 'Quiz sudah dimulai!' }
          }));
          return;
        }

        const usernameExists = rooms[roomCode].players.some(p => p.username === username);
        if (usernameExists) {
          ws.send(JSON.stringify({
            type: 'join-error',
            data: { message: 'Username sudah dipakai!' }
          }));
          return;
        }

        // Tambahkan player
        rooms[roomCode].players.push({
          clientId: tempClientId,
          username: username,
          score: 0,
          answers: []
        });

        // Update last activity
        rooms[roomCode].lastActivity = Date.now();

        users[tempClientId] = {
          clientId: tempClientId,
          username: username,
          currentRoom: roomCode,
          ws: ws
        };

        console.log(`👋 ${username} joined room: ${roomCode} (${tempClientId})`);
        console.log(`   📊 Room ${roomCode} now has ${rooms[roomCode].players.length} players`);

        // Kirim response ke player yang join
        ws.send(JSON.stringify({
          type: 'room-joined',
          data: {
            success: true,
            roomCode: roomCode,
            isHost: tempClientId === rooms[roomCode].host
          }
        }));

        // Broadcast ke semua player
        broadcastToRoomAll(roomCode, 'player-joined', {
          username: username,
          players: rooms[roomCode].players.map(p => ({
            username: p.username,
            score: p.score,
            clientId: p.clientId
          }))
        });
      }

      // ===================================
      // HANDLER: GET ROOM DATA
      // ===================================
      else if (type === 'get-room-data') {
        // Handle jika data adalah object atau string
        const roomCode = typeof data === 'string' ? data : data.roomCode;
        const username = data.username || null; // Untuk handle reconnect

        console.log(`📦 Get room data: ${roomCode} by ${tempClientId}`);

        if (!rooms[roomCode]) {
          console.log(`   ❌ Room ${roomCode} not found`);
          ws.send(JSON.stringify({
            type: 'error',
            data: { message: 'Room tidak ditemukan!' }
          }));
          return;
        }

        const room = rooms[roomCode];

        // Handle reconnect: cari player berdasarkan username di room yang sama
        if (username) {
          const existingPlayer = room.players.find(p => p.username === username);
          if (existingPlayer) {
            console.log(`🔄 Reconnect detected: ${username} (${existingPlayer.clientId} → ${tempClientId})`);

            // Hapus user data lama jika ada
            if (users[existingPlayer.clientId]) {
              delete users[existingPlayer.clientId];
            }

            // Update client ID di room
            existingPlayer.clientId = tempClientId;

            // Jika ini adalah host, update host ID juga
            if (existingPlayer.username === room.hostUsername) {
              room.host = tempClientId;
            }

            // Update user data
            users[tempClientId] = {
              clientId: tempClientId,
              username: username,
              currentRoom: roomCode,
              ws: ws
            };

            console.log(`   ✅ Reconnected player: ${username}`);
          } else {
            // Jika tidak ada existing player dengan username ini, buat player baru
            console.log(`🆕 New player detected: ${username} in room ${roomCode}`);
            room.players.push({
              clientId: tempClientId,
              username: username,
              score: 0,
              answers: []
            });

            users[tempClientId] = {
              clientId: tempClientId,
              username: username,
              currentRoom: roomCode,
              ws: ws
            };

            // Update last activity
            room.lastActivity = Date.now();
          }
        }

        console.log(`   ✅ Sending room data for ${roomCode}`);

        ws.send(JSON.stringify({
          type: 'room-data',
          data: {
            room: {
              code: room.code,
              players: room.players.map(p => ({
                username: p.username,
                score: p.score,
                clientId: p.clientId
              })),
              quiz: {
                status: room.quiz.status,
                currentQuestion: room.quiz.currentQuestion,
                totalQuestions: room.quiz.questions.length,
                // If a question is active we include its server start time and the timer value
                questionStartTime: room.quiz.questionStartTime || null,
                questionTimer: (room.quiz.currentQuestion >= 0 && room.quiz.questions[room.quiz.currentQuestion])
                  ? room.quiz.questions[room.quiz.currentQuestion].timer
                  : null
              },
              chat: room.chat
            },
            isHost: tempClientId === room.host
          }
        }));
      }

      // ===================================
      // HANDLER: SEND CHAT
      // ===================================
      else if (type === 'send-chat') {
        const { roomCode, message } = data;
        let user = users[tempClientId];

        console.log(`💬 Chat from ${tempClientId} in room ${roomCode}`);

        if (!rooms[roomCode]) {
          console.log(`   ❌ Room ${roomCode} not found`);
          return;
        }

        // Handle reconnect jika user tidak ditemukan
        if (!user && rooms[roomCode]) {
          const room = rooms[roomCode];
          const existingPlayer = room.players.find(p => p.clientId === tempClientId);
          if (existingPlayer) {
            console.log(`🔄 Reconnect detected in chat: ${existingPlayer.username} (${tempClientId})`);
            users[tempClientId] = {
              clientId: tempClientId,
              username: existingPlayer.username,
              currentRoom: roomCode,
              ws: ws
            };
            user = users[tempClientId];
          }
        }

        if (!user) {
          console.log(`   ❌ User ${tempClientId} not found even after reconnect check`);
          return;
        }

        const chatMessage = {
          username: user.username,
          message: message.trim(),
          timestamp: Date.now()
        };

        rooms[roomCode].chat.push(chatMessage);

        console.log(`   💬 [${roomCode}] ${user.username}: ${message}`);

        // Broadcast ke semua player di room
        broadcastToRoomAll(roomCode, 'new-chat', chatMessage);
      }

      // ===================================
      // HANDLER: START QUIZ
      // ===================================
      else if (type === 'start-quiz') {
        const { roomCode, questions } = data;
        let room = rooms[roomCode];

        if (!room) {
          ws.send(JSON.stringify({
            type: 'error',
            data: { message: 'Room tidak ditemukan!' }
          }));
          return;
        }

        // Handle reconnect dan verifikasi host
        let isHost = tempClientId === room.host;
        if (!isHost) {
          const player = room.players.find(p => p.clientId === tempClientId);
          if (player) {
            console.log(`🔄 Reconnect detected in start-quiz: ${player.username} (${tempClientId})`);
            // Update user data jika belum ada
            if (!users[tempClientId]) {
              users[tempClientId] = {
                clientId: tempClientId,
                username: player.username,
                currentRoom: roomCode,
                ws: ws
              };
            }
            // Cek apakah player ini sebenarnya host
            isHost = player.clientId === room.host;
          }
        }

        if (!isHost) {
          ws.send(JSON.stringify({
            type: 'error',
            data: { message: 'Hanya host yang bisa start!' }
          }));
          return;
        }

        if (room.quiz.status !== 'waiting') {
          ws.send(JSON.stringify({
            type: 'error',
            data: { message: 'Quiz sudah dimulai!' }
          }));
          return;
        }

        // Jika custom questions disediakan, validasi dan gunakan
        if (questions && Array.isArray(questions) && questions.length > 0) {
          // Validasi format questions
          const isValid = questions.every(q =>
            q.question && typeof q.question === 'string' &&
            q.options && Array.isArray(q.options) && q.options.length === 4 &&
            typeof q.correct === 'number' && q.correct >= 0 && q.correct <= 3 &&
            typeof q.timer === 'number' && q.timer >= 10 && q.timer <= 300
          );

          if (!isValid) {
            ws.send(JSON.stringify({
              type: 'error',
              data: { message: 'Format soal tidak valid!' }
            }));
            return;
          }

          room.quiz.questions = questions;
          console.log(`📝 Using ${questions.length} custom questions in room ${roomCode}`);
        } else {
          // Gunakan default quizBank
          room.quiz.questions = [...quizBank];
          console.log(`📚 Using default questions (${quizBank.length}) in room ${roomCode}`);
        }

        room.quiz.status = 'playing';
        room.quiz.currentQuestion = 0;
        room.quiz.startTime = Date.now();

        console.log(`🎯 Quiz started in room: ${roomCode}`);

        broadcastToRoomAll(roomCode, 'quiz-started', {
          message: 'Quiz dimulai! Bersiap...',
          totalQuestions: room.quiz.questions.length
        });

        setTimeout(() => {
          sendQuestion(roomCode, 0);
        }, 3000);
      }

      // ===================================
      // HANDLER: SUBMIT ANSWER
      // ===================================
      else if (type === 'submit-answer') {
          const { roomCode, answerIndex } = data; // client-supplied timeToAnswer is ignored for fairness
        const room = rooms[roomCode];
        const user = users[tempClientId];

        if (!room || !user) return;

        if (room.quiz.status !== 'playing') {
          ws.send(JSON.stringify({
            type: 'error',
            data: { message: 'Quiz belum dimulai!' }
          }));
          return;
        }

        const currentQ = room.quiz.currentQuestion;
        const question = room.quiz.questions[currentQ];
        const player = room.players.find(p => p.clientId === tempClientId);

        if (!player) return;

        const alreadyAnswered = player.answers.find(a => a.questionIndex === currentQ);
        if (alreadyAnswered) {
          ws.send(JSON.stringify({
            type: 'error',
            data: { message: 'Sudah menjawab!' }
          }));
          return;
        }

        // Compute timeToAnswer using server's questionStartTime (fair and authoritative)
        const serverTimeToAnswer = room.quiz.questionStartTime
          ? Math.round(((Date.now() - room.quiz.questionStartTime) / 100) ) / 10 // round to 0.1s
          : 0;

        const isCorrect = answerIndex === question.correct;

        let points = 0;
        if (isCorrect) {
          const bonus = Math.max(0, Math.floor((question.timer - serverTimeToAnswer) / 2));
          points = 10 + bonus;
          player.score += points;
        }

        player.answers.push({
          questionIndex: currentQ,
          question: question.question,
          options: question.options,
          selectedAnswer: answerIndex,
          correctAnswer: question.correct,
          isCorrect: isCorrect,
          timeToAnswer: serverTimeToAnswer,
          pointsEarned: points
        });

        room.quiz.answeredCount = (room.quiz.answeredCount || 0) + 1;

        console.log(`📝 ${user.username} answered Q${currentQ + 1}: ${isCorrect ? '✅' : '❌'} (+${points}) | ${room.quiz.answeredCount}/${room.quiz.totalPlayers}`);

        ws.send(JSON.stringify({
          type: 'answer-submitted',
          data: {
            isCorrect: isCorrect,
            correctAnswer: question.correct,
            correctAnswerText: question.options[question.correct],
            points: points,
            newScore: player.score,
            answeredCount: room.quiz.answeredCount,
            totalPlayers: room.quiz.totalPlayers
          }
        }));

        broadcastToRoomAll(roomCode, 'answer-progress', {
          answeredCount: room.quiz.answeredCount,
          totalPlayers: room.quiz.totalPlayers,
          questionNumber: currentQ + 1
        });

        if (room.quiz.answeredCount >= room.quiz.totalPlayers) {
          console.log(`🎯 All players answered Q${currentQ + 1}! Moving to next in 3s...`);

          // Broadcast bahwa semua sudah menjawab
          broadcastToRoomAll(roomCode, 'all-answered', {
            message: 'Semua sudah menjawab! Soal berikutnya dalam 3 detik...'
          });

          // Hapus timeout lama jika ada
          if (room.quiz.transitionTimeout) {
            clearTimeout(room.quiz.transitionTimeout);
          }

          // Pindah ke soal berikutnya dalam 3 detik
          room.quiz.transitionTimeout = setTimeout(() => {
            goToNextQuestion(roomCode);
          }, QUESTION_TRANSITION_DELAY);
        }

        broadcastLeaderboard(roomCode);

      }

      // // ===================================
      // // HANDLER: NEXT QUESTION
      // // ===================================
      // else if (type === 'next-question') {
      //   const { roomCode } = data;
      //   const room = rooms[roomCode];

      //   if (!room || tempClientId !== room.host) return;

      //   const nextIndex = room.quiz.currentQuestion + 1;

      //   if (nextIndex >= room.quiz.questions.length) {
      //     finishQuiz(roomCode);
      //   } else {
      //     room.quiz.currentQuestion = nextIndex;
      //     sendQuestion(roomCode, nextIndex);
      //   }
      // }

      // ===================================
      // HANDLER: GET MY REVIEW
      // ===================================
      else if (type === 'get-my-review') {
        const { roomCode } = data;
        const room = rooms[roomCode];
        const player = room?.players.find(p => p.clientId === tempClientId);

        if (!room || !player) {
          ws.send(JSON.stringify({
            type: 'error',
            data: { message: 'Data tidak ditemukan!' }
          }));
          return;
        }

        ws.send(JSON.stringify({
          type: 'player-review',
          data: {
            username: player.username,
            score: player.score,
            answers: player.answers,
            totalCorrect: player.answers.filter(a => a.isCorrect).length,
            totalQuestions: player.answers.length
          }
        }));
      }

      // ===================================
      // HANDLER: PING (KEEP ALIVE)
      // ===================================
      else if (type === 'ping') {
        ws.send(JSON.stringify({
          type: 'pong',
          data: { timestamp: Date.now() }
        }));
      }

    } catch (error) {
      console.error('❌ Error handling message:', error);
    }
  });

  // ===================================
  // WEBSOCKET CLOSE HANDLER
  // ===================================
  ws.on('close', () => {
    console.log(`❌ WebSocket disconnected: ${tempClientId}`);

    const user = users[tempClientId];
    if (!user) return;

    const roomCode = user.currentRoom;
    if (roomCode && rooms[roomCode]) {
      const room = rooms[roomCode];

      // Don't remove player on disconnect - allow reconnect
      // room.players = room.players.filter(p => p.clientId !== tempClientId);

      console.log(`   👋 ${user.username} disconnected from room ${roomCode} (keeping in room for reconnect)`);

      // Don't broadcast player-left on temporary disconnect
      // broadcastToRoomAll(roomCode, 'player-left', {
      //   username: user.username,
      //   players: room.players.map(p => ({
      //     username: p.username,
      //     score: p.score
      //   }))
      // });

      // Don't change host on temporary disconnect
      // if (room.host === tempClientId) {
      //   if (room.players.length > 0) {
      //     room.host = room.players[0].clientId;
      //     broadcastToRoomAll(roomCode, 'new-host', {
      //       hostClientId: room.host,
      //       hostUsername: room.players[0].username
      //     });
      //   }
      // }
    }

    delete users[tempClientId];
    // Don't cleanup immediately - let players reconnect
    // cleanupEmptyRooms();
  });

  // ===================================
  // WEBSOCKET ERROR HANDLER
  // ===================================
  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for ${tempClientId}:`, error.message);
  });
});

// ===================================
// AUTO CLEANUP EVERY 10 MINUTES
// ===================================
setInterval(() => {
  cleanupEmptyRooms();
  console.log(`📊 Server Stats: ${Object.keys(rooms).length} rooms, ${Object.keys(users).length} users`);
}, 10 * 60 * 1000);

// ===================================
// START SERVERS
// ===================================
const HTTP_PORT = process.env.PORT || 3000;

server.listen(HTTP_PORT, () => {
  console.log(`
  ╔════════════════════════════════════════════╗
    🚀 Real-Time Quiz Server (Native WS)
    📡 HTTP: http://localhost:${HTTP_PORT}
    🔌 WebSocket: ws://localhost:${HTTP_PORT}
    💾 Storage: In-Memory + History
    📊 Quiz Bank: ${quizBank.length} questions
    👥 Max Players per Room: 10
  ╚════════════════════════════════════════════╝
  `);
});
