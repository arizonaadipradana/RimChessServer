const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const { Chess } = require("chess.js");
const Redis = require("ioredis");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

// Enhanced Socket.IO configuration for better stability
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"], // Allow fallback to polling
  allowEIO3: true,

  // More conservative timeouts for better stability
  pingTimeout: 60000, // 1 minute (reduced from 2 minutes)
  pingInterval: 25000, // 25 seconds (was 15 seconds)

  // Enhanced connection settings
  upgradeTimeout: 10000, // 10 seconds for transport upgrade (reduced from 30)
  maxHttpBufferSize: 1e6, // 1MB buffer

  // Connection retry settings
  connectTimeout: 20000, // 20 seconds connection timeout (reduced from 45)

  // Enable compression
  compression: true,

  // Polling settings for fallback
  pollingDuration: 30,

  // Additional stability options
  allowUpgrades: true,
  perMessageDeflate: {
    threshold: 1024,
  },

  // Cookie settings for session persistence
  cookie: {
    name: "rimchess.io",
    httpOnly: false,
    sameSite: "lax",
  },
});

// Enhanced Redis configuration with better error handling
const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: process.env.REDIS_PORT || 6379,
  enableReadyCheck: false,
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 1000,
  lazyConnect: true,

  // Enhanced connection settings
  connectTimeout: 10000,
  commandTimeout: 5000,

  // Reconnection settings
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    console.log(`Redis reconnecting in ${delay}ms (attempt ${times})`);
    return delay;
  },

  // Keep connection alive
  keepAlive: true,
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

const connectedClients = new Map();
const waitingGames = [];
const activeGames = new Map(); // NEW: Track active games

// Connection heartbeat tracking
const connectionHeartbeats = new Map();

const db = new sqlite3.Database("./rimchess.db", (err) => {
  if (err) {
    console.error("Error opening database:", err);
    process.exit(1);
  }
  console.log("Connected to SQLite database");
  initializeDatabase();
});

function initializeDatabase() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      elo INTEGER DEFAULT 1200,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME DEFAULT CURRENT_TIMESTAMP,
      games_played INTEGER DEFAULT 0,
      games_won INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      player_white_id INTEGER,
      player_black_id INTEGER,
      status TEXT DEFAULT 'waiting',
      winner_id INTEGER,
      end_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME,
      total_moves INTEGER DEFAULT 0,
      time_control_minutes INTEGER DEFAULT 30
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS game_moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      move_number INTEGER NOT NULL,
      move_notation TEXT NOT NULL,
      player_id INTEGER NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Enhanced Redis error handling
redis.on("error", (err) => {
  console.error("Redis error:", err);
});

redis.on("connect", () => {
  console.log("Connected to Redis");
});

redis.on("reconnecting", () => {
  console.log("Redis reconnecting...");
});

redis.on("ready", () => {
  console.log("Redis ready");
});

// CRITICAL FIX: Game timer management system
class GameTimer {
  constructor(gameId, timeControlMinutes, playerId1, playerId2) {
    this.gameId = gameId;
    this.timeControlMinutes = timeControlMinutes;
    this.playerId1 = playerId1;
    this.playerId2 = playerId2;

    // Time remaining in seconds
    const totalSeconds = timeControlMinutes * 60;
    this.player1TimeRemaining = totalSeconds;
    this.player2TimeRemaining = totalSeconds;

    this.currentPlayer = 1; // 1 for white, 2 for black
    this.lastMoveTime = Date.now();
    this.isActive = true;

    this.startTimer();
    console.log(
      `Game timer created for ${gameId}: ${timeControlMinutes} minutes per player`
    );
  }

  startTimer() {
    this.timerInterval = setInterval(() => {
      if (!this.isActive) return;

      const now = Date.now();
      const elapsed = Math.floor((now - this.lastMoveTime) / 1000);

      if (this.currentPlayer === 1) {
        this.player1TimeRemaining = Math.max(
          0,
          this.player1TimeRemaining - elapsed
        );
        if (this.player1TimeRemaining <= 0) {
          this.handleTimeExpiry(this.playerId1);
          return;
        }
      } else {
        this.player2TimeRemaining = Math.max(
          0,
          this.player2TimeRemaining - elapsed
        );
        if (this.player2TimeRemaining <= 0) {
          this.handleTimeExpiry(this.playerId2);
          return;
        }
      }

      this.lastMoveTime = now;
    }, 1000);
  }

  switchPlayer() {
    this.currentPlayer = this.currentPlayer === 1 ? 2 : 1;
    this.lastMoveTime = Date.now();
    console.log(
      `Timer switched to player ${this.currentPlayer} for game ${this.gameId}`
    );
  }

  handleTimeExpiry(timedOutPlayerId) {
    console.log(
      `Player ${timedOutPlayerId} ran out of time in game ${this.gameId}`
    );
    this.isActive = false;
    clearInterval(this.timerInterval);

    // Determine winner (opposite player)
    const winnerId =
      timedOutPlayerId === this.playerId1 ? this.playerId2 : this.playerId1;

    // End the game due to timeout
    endGameByTimeout(this.gameId, winnerId, timedOutPlayerId);
  }

  getTimerData() {
    return {
      player1Time: this.player1TimeRemaining,
      player2Time: this.player2TimeRemaining,
      currentPlayer: this.currentPlayer,
      lastUpdate: this.lastMoveTime,
    };
  }

  stop() {
    this.isActive = false;
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }
    console.log(`Timer stopped for game ${this.gameId}`);
  }
}

// NEW: Enhanced game end handling functions
async function endGameByCheckmate(gameId, winnerId, loserId, finalFen) {
  console.log(
    `CHECKMATE: Game ${gameId} won by player ${winnerId}, final FEN: ${finalFen}`
  );

  try {
    // Update database
    await new Promise((resolve, reject) => {
      db.run(
        "UPDATE games SET status = ?, winner_id = ?, end_reason = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?",
        ["finished", winnerId, "checkmate", gameId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Get player usernames
    const winnerUser = await getUserById(winnerId);
    const loserUser = await getUserById(loserId);

    // Stop game timer
    const game = activeGames.get(gameId);
    if (game && game.timer) {
      game.timer.stop();
    }

    // CRITICAL FIX: Notify BOTH players about checkmate
    const gameOverData = {
      gameId,
      result: "checkmate",
      winner: winnerUser?.username || "Unknown",
      reason: "checkmate",
      finalFen: finalFen,
    };

    // Send to all players in the game room
    io.to(gameId).emit("game_over", gameOverData);
    console.log(
      `Checkmate notification sent to both players in game ${gameId}`
    );

    // Clean up
    activeGames.delete(gameId);
  } catch (error) {
    console.error(`Error ending game by checkmate: ${error}`);
  }
}

async function endGameByResignation(gameId, resignedPlayerId) {
  console.log(
    `RESIGNATION: Player ${resignedPlayerId} resigned from game ${gameId}`
  );

  try {
    // Get game info to determine winner
    const game = activeGames.get(gameId);
    if (!game) {
      console.error(`Game ${gameId} not found in active games`);
      return;
    }

    // CRITICAL FIX: Winner is the opposite player who didn't resign
    const winnerId =
      resignedPlayerId === game.playerId1 ? game.playerId2 : game.playerId1;

    // Update database
    await new Promise((resolve, reject) => {
      db.run(
        "UPDATE games SET status = ?, winner_id = ?, end_reason = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?",
        ["finished", winnerId, "resignation", gameId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Get player usernames
    const winnerUser = await getUserById(winnerId);
    const resignedUser = await getUserById(resignedPlayerId);

    // Stop game timer
    if (game.timer) {
      game.timer.stop();
    }

    // CRITICAL FIX: Notify BOTH players with correct winner/loser information
    const gameOverData = {
      gameId,
      result: "resignation",
      winner: winnerUser?.username || "Unknown",
      reason: "resignation",
      resignedPlayer: resignedUser?.username || "Unknown",
    };

    // Send to all players in the game room
    io.to(gameId).emit("game_over", gameOverData);
    console.log(
      `Resignation notification sent: ${resignedUser?.username} resigned, ${winnerUser?.username} wins`
    );

    // Clean up
    activeGames.delete(gameId);
  } catch (error) {
    console.error(`Error ending game by resignation: ${error}`);
  }
}

async function endGameByTimeout(gameId, winnerId, timedOutPlayerId) {
  console.log(
    `TIMEOUT: Player ${timedOutPlayerId} timed out in game ${gameId}, winner: ${winnerId}`
  );

  try {
    // Update database
    await new Promise((resolve, reject) => {
      db.run(
        "UPDATE games SET status = ?, winner_id = ?, end_reason = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?",
        ["finished", winnerId, "timeout", gameId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Get player usernames
    const winnerUser = await getUserById(winnerId);
    const timedOutUser = await getUserById(timedOutPlayerId);

    // Stop game timer
    const game = activeGames.get(gameId);
    if (game && game.timer) {
      game.timer.stop();
    }

    // Notify both players
    const gameOverData = {
      gameId,
      result: "timeout",
      winner: winnerUser?.username || "Unknown",
      reason: "timeout",
      timedOutPlayer: timedOutUser?.username || "Unknown",
    };

    io.to(gameId).emit("game_over", gameOverData);
    console.log(
      `Timeout notification sent: ${timedOutUser?.username} timed out, ${winnerUser?.username} wins`
    );

    // Clean up
    activeGames.delete(gameId);
  } catch (error) {
    console.error(`Error ending game by timeout: ${error}`);
  }
}

// Helper function to get user by ID
async function getUserById(userId) {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM users WHERE id = ?", [userId], (err, user) => {
      if (err) reject(err);
      else resolve(user);
    });
  });
}

// CRITICAL FIX: Enhanced checkmate detection function
function detectGameEnd(chess, gameId, winnerId, loserId) {
  if (chess.isCheckmate()) {
    console.log(`CHECKMATE DETECTED in game ${gameId}!`);
    const finalFen = chess.fen();
    endGameByCheckmate(gameId, winnerId, loserId, finalFen);
    return true;
  } else if (chess.isStalemate()) {
    console.log(`STALEMATE DETECTED in game ${gameId}`);
    endGameByDraw(gameId, "stalemate");
    return true;
  } else if (chess.isDraw()) {
    console.log(`DRAW DETECTED in game ${gameId}`);
    endGameByDraw(gameId, "draw");
    return true;
  }
  return false;
}

async function endGameByDraw(gameId, reason) {
  console.log(`DRAW: Game ${gameId} ended in ${reason}`);

  try {
    // Update database (no winner for draws)
    await new Promise((resolve, reject) => {
      db.run(
        "UPDATE games SET status = ?, end_reason = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?",
        ["finished", reason, gameId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Stop game timer
    const game = activeGames.get(gameId);
    if (game && game.timer) {
      game.timer.stop();
    }

    // Notify both players
    const gameOverData = {
      gameId,
      result: "draw",
      winner: null, // No winner in a draw
      reason: reason,
    };

    io.to(gameId).emit("game_over", gameOverData);
    console.log(`Draw notification sent for game ${gameId}: ${reason}`);

    // Clean up
    activeGames.delete(gameId);
  } catch (error) {
    console.error(`Error ending game by draw: ${error}`);
  }
}

// Cleanup function for disconnected clients
function cleanupClient(socketId, username) {
  try {
    // Remove from connected clients
    connectedClients.delete(socketId);
    connectionHeartbeats.delete(socketId);

    // Remove from waiting games
    const gameIndex = waitingGames.findIndex((g) => {
      const client = connectedClients.get(socketId);
      return client && g.creatorId === client.userId;
    });

    if (gameIndex !== -1) {
      const game = waitingGames[gameIndex];
      waitingGames.splice(gameIndex, 1);
      db.run("DELETE FROM games WHERE id = ? AND status = ?", [
        game.gameId,
        "waiting",
      ]);
      console.log(`Cleaned up waiting game for ${username}`);
    }
  } catch (error) {
    console.error("Error during client cleanup:", error);
  }
}

// Connection monitoring
setInterval(() => {
  const now = Date.now();
  const staleConnections = [];

  connectionHeartbeats.forEach((lastSeen, socketId) => {
    if (now - lastSeen > 180000) {
      // 3 minutes
      staleConnections.push(socketId);
    }
  });

  staleConnections.forEach((socketId) => {
    const client = connectedClients.get(socketId);
    if (client) {
      console.log(`Cleaning up stale connection: ${client.username}`);
      cleanupClient(socketId, client.username);
    }
  });
}, 60000); // Check every minute

// Enhanced connection handling
io.on("connection", (socket) => {
  const clientIP =
    socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;
  console.log(`Client connected: ${socket.id} from ${clientIP}`);

  // Initialize heartbeat tracking
  connectionHeartbeats.set(socket.id, Date.now());

  // Send immediate connection confirmation with enhanced info
  socket.emit("connection_confirmed", {
    socketId: socket.id,
    timestamp: Date.now(),
    server: "RimChess Server v1.2-Enhanced",
    transport: socket.conn.transport.name,
  });

  // Enhanced heartbeat handling
  socket.on("ping", () => {
    connectionHeartbeats.set(socket.id, Date.now());
    socket.emit("pong", { timestamp: Date.now() });
  });

  // Custom heartbeat event
  socket.on("heartbeat", () => {
    connectionHeartbeats.set(socket.id, Date.now());
    socket.emit("heartbeat_ack", { timestamp: Date.now() });
  });

  // Transport upgrade handling with better logging
  socket.conn.on("upgrade", () => {
    const client = connectedClients.get(socket.id);
    const username = client ? client.username : "unknown";
    console.log(
      `Transport upgraded to ${socket.conn.transport.name} for ${username} (${socket.id})`
    );

    // Update client transport info
    if (client) {
      client.transport = socket.conn.transport.name;
    }
  });

  socket.conn.on("upgradeError", (error) => {
    const client = connectedClients.get(socket.id);
    const username = client ? client.username : "unknown";
    console.log(
      `Transport upgrade error for ${username} (${socket.id}): ${error.message}`
    );
  });

  // Monitor transport close events
  socket.conn.on("close", (reason) => {
    const client = connectedClients.get(socket.id);
    const username = client ? client.username : "unknown";
    console.log(`Transport closed for ${username} (${socket.id}): ${reason}`);
  });

  // Monitor transport errors
  socket.conn.on("error", (error) => {
    const client = connectedClients.get(socket.id);
    const username = client ? client.username : "unknown";
    console.log(
      `Transport error for ${username} (${socket.id}): ${error.message}`
    );
  });

  // Enhanced register handler with better error handling
  socket.on("register", async (data) => {
    try {
      connectionHeartbeats.set(socket.id, Date.now());
      console.log(`Registration attempt: ${data?.username}`);
      const { username, password } = data;

      if (!username || !password) {
        socket.emit("registration_failure", {
          reason: "Username and password required",
        });
        return;
      }

      if (username.length < 3 || password.length < 4) {
        socket.emit("registration_failure", {
          reason: "Username must be at least 3 characters, password at least 4",
        });
        return;
      }

      const passwordHash = await bcrypt.hash(password, 12);

      db.run(
        "INSERT INTO users (username, password_hash) VALUES (?, ?)",
        [username, passwordHash],
        function (err) {
          if (err) {
            console.log(`Registration failed for ${username}: ${err.message}`);
            socket.emit("registration_failure", {
              reason: "Username already exists",
            });
          } else {
            console.log(
              `User registered successfully: ${username} (ID: ${this.lastID})`
            );
            socket.emit("registration_success", {
              userId: this.lastID,
              username: username,
            });
          }
        }
      );
    } catch (error) {
      console.error("Registration error:", error);
      socket.emit("registration_failure", {
        reason: "Server error during registration",
      });
    }
  });

  // Enhanced login handler
  socket.on("login", async (data) => {
    try {
      connectionHeartbeats.set(socket.id, Date.now());
      console.log(`Login attempt: ${data?.username}`);
      const { username, password } = data;

      if (!username || !password) {
        socket.emit("login_failure", {
          reason: "Username and password required",
        });
        return;
      }

      db.get(
        "SELECT * FROM users WHERE username = ?",
        [username],
        async (err, user) => {
          if (err) {
            console.error("Database error during login:", err);
            socket.emit("login_failure", { reason: "Server error" });
            return;
          }

          if (!user) {
            console.log(`Login failed - user not found: ${username}`);
            socket.emit("login_failure", {
              reason: "Invalid username or password",
            });
            return;
          }

          try {
            const isValid = await bcrypt.compare(password, user.password_hash);
            if (!isValid) {
              console.log(`Login failed - invalid password: ${username}`);
              socket.emit("login_failure", {
                reason: "Invalid username or password",
              });
              return;
            }

            // Update last login
            db.run(
              "UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?",
              [user.id]
            );

            // Store client info with enhanced data
            connectedClients.set(socket.id, {
              userId: user.id,
              username: user.username,
              elo: user.elo,
              socket: socket,
              connectedAt: Date.now(),
              transport: socket.conn.transport.name,
            });

            console.log(
              `User logged in successfully: ${username} (ELO: ${user.elo}) via ${socket.conn.transport.name}`
            );

            socket.emit("login_success", {
              userId: user.id,
              username: user.username,
              elo: user.elo,
              gamesPlayed: user.games_played,
              gamesWon: user.games_won,
              transport: socket.conn.transport.name,
            });
          } catch (bcryptError) {
            console.error("Bcrypt error:", bcryptError);
            socket.emit("login_failure", { reason: "Authentication error" });
          }
        }
      );
    } catch (error) {
      console.error("Login error:", error);
      socket.emit("login_failure", { reason: "Server error during login" });
    }
  });

  // Enhanced game creation
  socket.on("create_game", async (data) => {
    try {
      connectionHeartbeats.set(socket.id, Date.now());
      const client = connectedClients.get(socket.id);
      if (!client) {
        socket.emit("error", { message: "User not authenticated" });
        return;
      }

      const gameId = uuidv4();
      const timeControl = data?.timeControl || 30;

      console.log(`Creating game: ${gameId} by ${client.username}`);

      db.run(
        "INSERT INTO games (id, player_white_id, status, time_control_minutes) VALUES (?, ?, ?, ?)",
        [gameId, client.userId, "waiting", timeControl],
        async function (err) {
          if (err) {
            console.error("Error creating game:", err);
            socket.emit("error", { message: "Failed to create game" });
            return;
          }

          waitingGames.push({
            gameId,
            creatorId: client.userId,
            timeControl,
            createdAt: Date.now(),
          });

          // Initialize game state in Redis with retry
          const chess = new Chess();
          try {
            await redis.set(`game:${gameId}:fen`, chess.fen());
            await redis.set(`game:${gameId}:turn`, "white");
            await redis.set(`game:${gameId}:moves`, JSON.stringify([]));
            await redis.set(`game:${gameId}:creator`, client.userId);
          } catch (redisError) {
            console.error("Redis error:", redisError);
            // Continue without Redis for now
          }

          socket.emit("waiting_for_opponent", {
            gameId,
            timeControl,
            position: "white",
            created: Date.now(),
          });

          console.log(`Game created successfully: ${gameId}`);
        }
      );
    } catch (error) {
      console.error("Create game error:", error);
      socket.emit("error", { message: "Server error during game creation" });
    }
  });

  // Enhanced game search
  socket.on("search_for_game", async () => {
    try {
      connectionHeartbeats.set(socket.id, Date.now());
      const client = connectedClients.get(socket.id);
      if (!client) {
        socket.emit("error", { message: "User not authenticated" });
        return;
      }

      console.log(`${client.username} searching for game`);

      const game = waitingGames.find((g) => g.creatorId !== client.userId);
      if (!game) {
        socket.emit("no_games_found");
        console.log(`No games found for ${client.username}`);
        return;
      }

      // Remove game from waiting list
      const gameIndex = waitingGames.indexOf(game);
      waitingGames.splice(gameIndex, 1);

      // Update game in database
      db.run(
        "UPDATE games SET player_black_id = ?, status = ? WHERE id = ?",
        [client.userId, "inprogress", game.gameId],
        function (err) {
          if (err) {
            console.error("Error updating game:", err);
            socket.emit("error", { message: "Failed to join game" });
            return;
          }

          // Find creator socket
          const creatorSocket = Array.from(connectedClients.values()).find(
            (c) => c.userId === game.creatorId
          )?.socket;

          if (creatorSocket && creatorSocket.connected) {
            // Join both players to game room
            socket.join(game.gameId);
            creatorSocket.join(game.gameId);

            // Get creator info
            const creatorClient = connectedClients.get(creatorSocket.id);

            // CRITICAL FIX: Initialize game timer and active game tracking
            const activeGame = {
              gameId: game.gameId,
              playerId1: game.creatorId,
              playerId2: client.userId,
              timer: new GameTimer(
                game.gameId,
                game.timeControl || 30,
                game.creatorId,
                client.userId
              ),
              chess: new Chess(),
              startTime: Date.now(),
            };
            activeGames.set(game.gameId, activeGame);

            // Notify both players
            creatorSocket.emit("match_found", {
              gameId: game.gameId,
              yourColor: "white",
              opponent: {
                username: client.username,
                elo: client.elo,
              },
              timeControl: game.timeControl || 30,
            });

            socket.emit("match_found", {
              gameId: game.gameId,
              yourColor: "black",
              opponent: {
                username: creatorClient.username,
                elo: creatorClient.elo,
              },
              timeControl: game.timeControl || 30,
            });

            console.log(
              `Match found: ${game.gameId} - ${creatorClient.username} vs ${client.username} with ${game.timeControl}min timer`
            );
          } else {
            socket.emit("error", { message: "Opponent no longer available" });
            // Re-add game to waiting list
            waitingGames.push(game);
          }
        }
      );
    } catch (error) {
      console.error("Search game error:", error);
      socket.emit("error", { message: "Server error during game search" });
    }
  });

  // CRITICAL FIX: Enhanced move handling with checkmate detection and timer management
  socket.on("move", async (data) => {
    try {
      connectionHeartbeats.set(socket.id, Date.now());
      const client = connectedClients.get(socket.id);
      if (!client) {
        socket.emit("error", { message: "User not authenticated" });
        return;
      }

      const { gameId, move } = data;
      if (!gameId || !move) {
        socket.emit("invalid_move", { reason: "Game ID and move required" });
        return;
      }

      console.log(
        `Move received: ${move} from ${client.username} in game ${gameId}`
      );

      // Get active game and validate
      const activeGame = activeGames.get(gameId);
      if (!activeGame) {
        socket.emit("invalid_move", {
          reason: "Game not found or no longer active",
        });
        return;
      }

      // Validate player's turn
      const isPlayerWhite = client.userId === activeGame.playerId1;
      const currentTurn = activeGame.chess.turn();
      const isPlayerTurn =
        (currentTurn === "w" && isPlayerWhite) ||
        (currentTurn === "b" && !isPlayerWhite);

      if (!isPlayerTurn) {
        socket.emit("invalid_move", { reason: "Not your turn" });
        return;
      }

      // Validate and process move using Chess.js
      const moveResult = activeGame.chess.move(move);

      if (!moveResult) {
        socket.emit("invalid_move", { reason: "Invalid move" });
        return;
      }

      console.log(`Valid move processed: ${moveResult.san} in game ${gameId}`);

      // CRITICAL FIX: Update timer for the player who just moved
      if (activeGame.timer) {
        activeGame.timer.switchPlayer();
      }

      // Update game state in Redis with retry
      try {
        await redis.set(`game:${gameId}:fen`, activeGame.chess.fen());
        await redis.set(
          `game:${gameId}:turn`,
          activeGame.chess.turn() === "w" ? "white" : "black"
        );
      } catch (redisError) {
        console.error("Redis error updating game state:", redisError);
      }

      // Store move in database
      db.run(
        "INSERT INTO game_moves (game_id, move_number, move_notation, player_id) VALUES (?, ?, ?, ?)",
        [gameId, activeGame.chess.history().length, move, client.userId]
      );

      // CRITICAL FIX: Get timer data for synchronization
      const timerData = activeGame.timer
        ? activeGame.timer.getTimerData()
        : null;

      // Prepare move data to broadcast
      const moveData = {
        gameId,
        move: moveResult.san,
        from: moveResult.from,
        to: moveResult.to,
        fen: activeGame.chess.fen(),
        turn: activeGame.chess.turn() === "w" ? "white" : "black",
        player: client.username,
      };

      // CRITICAL FIX: Add timer data for proper synchronization
      if (timerData) {
        // Map timer data correctly based on which player made the move
        if (isPlayerWhite) {
          moveData.playerTimeRemaining = timerData.player1Time;
          moveData.opponentTimeRemaining = timerData.player2Time;
        } else {
          moveData.playerTimeRemaining = timerData.player2Time;
          moveData.opponentTimeRemaining = timerData.player1Time;
        }
        moveData.serverTimestamp = Date.now();
      }

      // CRITICAL FIX: Check for game end IMMEDIATELY after move
      const winnerId = isPlayerWhite
        ? activeGame.playerId1
        : activeGame.playerId2;
      const loserId = isPlayerWhite
        ? activeGame.playerId2
        : activeGame.playerId1;

      if (detectGameEnd(activeGame.chess, gameId, winnerId, loserId)) {
        // Game ended - detectGameEnd handles all notifications
        console.log(`Game ${gameId} ended after move ${moveResult.san}`);
        return; // Don't send normal move_made event
      }

      // Normal move - broadcast to game room
      io.to(gameId).emit("move_made", moveData);
      console.log(
        `Move broadcasted to game room: ${moveResult.san} by ${client.username}`
      );
    } catch (error) {
      console.error("Move error:", error);
      socket.emit("error", { message: "Server error processing move" });
    }
  });

  // Handle chat with enhanced validation
  socket.on("chat", (data) => {
    try {
      connectionHeartbeats.set(socket.id, Date.now());
      const client = connectedClients.get(socket.id);
      if (!client) return;

      const { gameId, message } = data;
      if (!gameId || !message || message.trim().length === 0) return;

      const chatData = {
        gameId,
        username: client.username,
        message: message.trim().substring(0, 200), // Limit message length
        timestamp: Date.now(),
      };

      io.to(gameId).emit("chat", chatData);
      console.log(
        `Chat: ${client.username} in ${gameId}: ${message.substring(0, 50)}...`
      );
    } catch (error) {
      console.error("Chat error:", error);
    }
  });

  // CRITICAL FIX: Enhanced resignation handler
  socket.on("resign", async (data) => {
    try {
      connectionHeartbeats.set(socket.id, Date.now());
      const client = connectedClients.get(socket.id);
      if (!client) return;

      const { gameId } = data;
      if (!gameId) return;

      console.log(
        `Player ${client.username} (ID: ${client.userId}) resigned from game ${gameId}`
      );

      // Process resignation with correct winner/loser logic
      await endGameByResignation(gameId, client.userId);
    } catch (error) {
      console.error("Resignation error:", error);
    }
  });

  // Handle cancel matchmaking
  socket.on("cancel_matchmaking", () => {
    try {
      connectionHeartbeats.set(socket.id, Date.now());
      const client = connectedClients.get(socket.id);
      if (!client) return;

      const gameIndex = waitingGames.findIndex(
        (g) => g.creatorId === client.userId
      );
      if (gameIndex !== -1) {
        const game = waitingGames[gameIndex];
        waitingGames.splice(gameIndex, 1);

        // Clean up database
        db.run("DELETE FROM games WHERE id = ? AND status = ?", [
          game.gameId,
          "waiting",
        ]);

        socket.emit("matchmaking_cancelled");
        console.log(`Matchmaking cancelled by ${client.username}`);
      }
    } catch (error) {
      console.error("Cancel matchmaking error:", error);
    }
  });

  // Enhanced disconnect handler with better error reporting
  socket.on("disconnect", (reason) => {
    try {
      const client = connectedClients.get(socket.id);
      if (client) {
        const transport = client.transport || socket.conn.transport.name;
        const connectionDuration = (
          (Date.now() - client.connectedAt) /
          1000
        ).toFixed(1);

        console.log(
          `Client disconnected: ${client.username} (${socket.id}) - Reason: ${reason} - Transport: ${transport} - Duration: ${connectionDuration}s`
        );

        // Log additional disconnect context
        if (reason === "transport error") {
          console.log(
            `Transport error details for ${client.username}: Last transport was ${transport}`
          );
        }

        cleanupClient(socket.id, client.username);
      } else {
        console.log(
          `Unknown client disconnected: ${socket.id} - Reason: ${reason}`
        );
        connectionHeartbeats.delete(socket.id);
      }
    } catch (error) {
      console.error("Disconnect handler error:", error);
    }
  });

  // Enhanced connection error handler
  socket.on("error", (error) => {
    const client = connectedClients.get(socket.id);
    const username = client ? client.username : "unknown";
    console.error(
      `Socket error for ${username} (${socket.id}):`,
      error.message
    );
  });

  // Connection close handler
  socket.on("close", (reason) => {
    const client = connectedClients.get(socket.id);
    const username = client ? client.username : "unknown";
    console.log(`Socket closed for ${username} (${socket.id}): ${reason}`);
  });
});

// Enhanced health check endpoint
app.get("/health", (req, res) => {
  const uptime = Math.floor(process.uptime());
  const memUsage = process.memoryUsage();

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: uptime,
    connections: {
      active: connectedClients.size,
      heartbeats: connectionHeartbeats.size,
    },
    games: {
      waiting: waitingGames.length,
      active: activeGames.size,
    },
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024) + "MB",
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + "MB",
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + "MB",
    },
    redis: redis.status,
  });
});

// Server info endpoint
app.get("/info", (req, res) => {
  res.json({
    server: "RimChess Multiplayer Server",
    version: "1.2.0",
    uptime: Math.floor(process.uptime()),
    connections: connectedClients.size,
    games: {
      waiting: waitingGames.length,
      active: activeGames.size,
      total: "N/A", // Could query database for total
    },
    transports: ["websocket", "polling"],
    features: [
      "Enhanced connection stability",
      "Transport fallback",
      "Connection monitoring",
      "Auto-cleanup",
      "Heartbeat tracking",
      "CHECKMATE DETECTION",
      "TIMER MANAGEMENT",
      "PROPER RESIGNATION HANDLING",
    ],
  });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");

  // Stop all active game timers
  activeGames.forEach((game) => {
    if (game.timer) {
      game.timer.stop();
    }
  });

  server.close(() => {
    db.close();
    redis.quit();
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully");

  // Stop all active game timers
  activeGames.forEach((game) => {
    if (game.timer) {
      game.timer.stop();
    }
  });

  server.close(() => {
    db.close();
    redis.quit();
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3030;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`RimChess server v1.2-Enhanced running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Server info: http://localhost:${PORT}/info`);
  console.log(`🔥 CRITICAL FIXES ENABLED:`);
  console.log(`✅ Checkmate detection with proper game end`);
  console.log(`✅ Timer management with time forfeit handling`);
  console.log(`✅ Correct resignation logic (winner/loser)`);
  console.log(`✅ Both players receive game end notifications`);
});
