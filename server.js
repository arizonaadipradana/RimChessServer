const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const { Chess } = require('chess.js');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Enhanced Socket.IO configuration for better stability
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'], // Allow fallback to polling
  allowEIO3: true,
  
  // More conservative timeouts for better stability
  pingTimeout: 60000,     // 1 minute (reduced from 2 minutes)
  pingInterval: 25000,    // 25 seconds (was 15 seconds)
  
  // Enhanced connection settings
  upgradeTimeout: 10000,  // 10 seconds for transport upgrade (reduced from 30)
  maxHttpBufferSize: 1e6, // 1MB buffer
  
  // Connection retry settings
  connectTimeout: 20000,  // 20 seconds connection timeout (reduced from 45)
  
  // Enable compression
  compression: true,
  
  // Polling settings for fallback
  pollingDuration: 30,
  
  // Additional stability options
  allowUpgrades: true,
  perMessageDeflate: {
    threshold: 1024
  },
  
  // Cookie settings for session persistence
  cookie: {
    name: "rimchess.io",
    httpOnly: false,
    sameSite: "lax"
  }
});

// Enhanced Redis configuration with better error handling
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
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
  keepAlive: true
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const connectedClients = new Map();
const waitingGames = [];

// Connection heartbeat tracking
const connectionHeartbeats = new Map();

const db = new sqlite3.Database('./rimchess.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
    process.exit(1);
  }
  console.log('Connected to SQLite database');
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
redis.on('error', (err) => {
  console.error('Redis error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

redis.on('reconnecting', () => {
  console.log('Redis reconnecting...');
});

redis.on('ready', () => {
  console.log('Redis ready');
});

// Cleanup function for disconnected clients
function cleanupClient(socketId, username) {
  try {
    // Remove from connected clients
    connectedClients.delete(socketId);
    connectionHeartbeats.delete(socketId);
    
    // Remove from waiting games
    const gameIndex = waitingGames.findIndex(g => {
      const client = connectedClients.get(socketId);
      return client && g.creatorId === client.userId;
    });
    
    if (gameIndex !== -1) {
      const game = waitingGames[gameIndex];
      waitingGames.splice(gameIndex, 1);
      db.run('DELETE FROM games WHERE id = ? AND status = ?', [game.gameId, 'waiting']);
      console.log(`Cleaned up waiting game for ${username}`);
    }
  } catch (error) {
    console.error('Error during client cleanup:', error);
  }
}

// Connection monitoring
setInterval(() => {
  const now = Date.now();
  const staleConnections = [];
  
  connectionHeartbeats.forEach((lastSeen, socketId) => {
    if (now - lastSeen > 180000) { // 3 minutes
      staleConnections.push(socketId);
    }
  });
  
  staleConnections.forEach(socketId => {
    const client = connectedClients.get(socketId);
    if (client) {
      console.log(`Cleaning up stale connection: ${client.username}`);
      cleanupClient(socketId, client.username);
    }
  });
}, 60000); // Check every minute

// Enhanced connection handling
io.on('connection', (socket) => {
  const clientIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  console.log(`Client connected: ${socket.id} from ${clientIP}`);
  
  // Initialize heartbeat tracking
  connectionHeartbeats.set(socket.id, Date.now());
  
  // Send immediate connection confirmation with enhanced info
  socket.emit('connection_confirmed', { 
    socketId: socket.id, 
    timestamp: Date.now(),
    server: 'RimChess Server v1.1',
    transport: socket.conn.transport.name
  });

  // Enhanced heartbeat handling
  socket.on('ping', () => {
    connectionHeartbeats.set(socket.id, Date.now());
    socket.emit('pong', { timestamp: Date.now() });
  });

  // Custom heartbeat event
  socket.on('heartbeat', () => {
    connectionHeartbeats.set(socket.id, Date.now());
    socket.emit('heartbeat_ack', { timestamp: Date.now() });
  });

  // Transport upgrade handling with better logging
  socket.conn.on('upgrade', () => {
    const client = connectedClients.get(socket.id);
    const username = client ? client.username : 'unknown';
    console.log(`Transport upgraded to ${socket.conn.transport.name} for ${username} (${socket.id})`);
    
    // Update client transport info
    if (client) {
      client.transport = socket.conn.transport.name;
    }
  });

  socket.conn.on('upgradeError', (error) => {
    const client = connectedClients.get(socket.id);
    const username = client ? client.username : 'unknown';
    console.log(`Transport upgrade error for ${username} (${socket.id}): ${error.message}`);
  });

  // Monitor transport close events
  socket.conn.on('close', (reason) => {
    const client = connectedClients.get(socket.id);
    const username = client ? client.username : 'unknown';
    console.log(`Transport closed for ${username} (${socket.id}): ${reason}`);
  });

  // Monitor transport errors
  socket.conn.on('error', (error) => {
    const client = connectedClients.get(socket.id);
    const username = client ? client.username : 'unknown';
    console.log(`Transport error for ${username} (${socket.id}): ${error.message}`);
  });

  // Enhanced register handler with better error handling
  socket.on('register', async (data) => {
    try {
      connectionHeartbeats.set(socket.id, Date.now());
      console.log(`Registration attempt: ${data?.username}`);
      const { username, password } = data;
      
      if (!username || !password) {
        socket.emit('registration_failure', { reason: 'Username and password required' });
        return;
      }

      if (username.length < 3 || password.length < 4) {
        socket.emit('registration_failure', { reason: 'Username must be at least 3 characters, password at least 4' });
        return;
      }

      const passwordHash = await bcrypt.hash(password, 12);
      
      db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, passwordHash], function (err) {
        if (err) {
          console.log(`Registration failed for ${username}: ${err.message}`);
          socket.emit('registration_failure', { reason: 'Username already exists' });
        } else {
          console.log(`User registered successfully: ${username} (ID: ${this.lastID})`);
          socket.emit('registration_success', { userId: this.lastID, username: username });
        }
      });
    } catch (error) {
      console.error('Registration error:', error);
      socket.emit('registration_failure', { reason: 'Server error during registration' });
    }
  });

  // Enhanced login handler
  socket.on('login', async (data) => {
    try {
      connectionHeartbeats.set(socket.id, Date.now());
      console.log(`Login attempt: ${data?.username}`);
      const { username, password } = data;
      
      if (!username || !password) {
        socket.emit('login_failure', { reason: 'Username and password required' });
        return;
      }

      db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (err) {
          console.error('Database error during login:', err);
          socket.emit('login_failure', { reason: 'Server error' });
          return;
        }
        
        if (!user) {
          console.log(`Login failed - user not found: ${username}`);
          socket.emit('login_failure', { reason: 'Invalid username or password' });
          return;
        }

        try {
          const isValid = await bcrypt.compare(password, user.password_hash);
          if (!isValid) {
            console.log(`Login failed - invalid password: ${username}`);
            socket.emit('login_failure', { reason: 'Invalid username or password' });
            return;
          }

          // Update last login
          db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

          // Store client info with enhanced data
          connectedClients.set(socket.id, { 
            userId: user.id, 
            username: user.username, 
            elo: user.elo, 
            socket: socket,
            connectedAt: Date.now(),
            transport: socket.conn.transport.name
          });

          console.log(`User logged in successfully: ${username} (ELO: ${user.elo}) via ${socket.conn.transport.name}`);
          
          socket.emit('login_success', {
            userId: user.id,
            username: user.username,
            elo: user.elo,
            gamesPlayed: user.games_played,
            gamesWon: user.games_won,
            transport: socket.conn.transport.name
          });
        } catch (bcryptError) {
          console.error('Bcrypt error:', bcryptError);
          socket.emit('login_failure', { reason: 'Authentication error' });
        }
      });
    } catch (error) {
      console.error('Login error:', error);
      socket.emit('login_failure', { reason: 'Server error during login' });
    }
  });

  // Enhanced game creation
  socket.on('create_game', async (data) => {
    try {
      connectionHeartbeats.set(socket.id, Date.now());
      const client = connectedClients.get(socket.id);
      if (!client) {
        socket.emit('error', { message: 'User not authenticated' });
        return;
      }

      const gameId = uuidv4();
      const timeControl = data?.timeControl || 30;
      
      console.log(`Creating game: ${gameId} by ${client.username}`);

      db.run('INSERT INTO games (id, player_white_id, status, time_control_minutes) VALUES (?, ?, ?, ?)',
        [gameId, client.userId, 'waiting', timeControl], async function(err) {
          if (err) {
            console.error('Error creating game:', err);
            socket.emit('error', { message: 'Failed to create game' });
            return;
          }

          waitingGames.push({ gameId, creatorId: client.userId, timeControl, createdAt: Date.now() });
          
          // Initialize game state in Redis with retry
          const chess = new Chess();
          try {
            await redis.set(`game:${gameId}:fen`, chess.fen());
            await redis.set(`game:${gameId}:turn`, 'white');
            await redis.set(`game:${gameId}:moves`, JSON.stringify([]));
            await redis.set(`game:${gameId}:creator`, client.userId);
          } catch (redisError) {
            console.error('Redis error:', redisError);
            // Continue without Redis for now
          }

          socket.emit('waiting_for_opponent', { 
            gameId, 
            timeControl, 
            position: 'white',
            created: Date.now()
          });
          
          console.log(`Game created successfully: ${gameId}`);
        });
    } catch (error) {
      console.error('Create game error:', error);
      socket.emit('error', { message: 'Server error during game creation' });
    }
  });

  // Enhanced game search
  socket.on('search_for_game', async () => {
    try {
      connectionHeartbeats.set(socket.id, Date.now());
      const client = connectedClients.get(socket.id);
      if (!client) {
        socket.emit('error', { message: 'User not authenticated' });
        return;
      }

      console.log(`${client.username} searching for game`);

      const game = waitingGames.find(g => g.creatorId !== client.userId);
      if (!game) {
        socket.emit('no_games_found');
        console.log(`No games found for ${client.username}`);
        return;
      }

      // Remove game from waiting list
      const gameIndex = waitingGames.indexOf(game);
      waitingGames.splice(gameIndex, 1);

      // Update game in database
      db.run('UPDATE games SET player_black_id = ?, status = ? WHERE id = ?',
        [client.userId, 'inprogress', game.gameId], function(err) {
          if (err) {
            console.error('Error updating game:', err);
            socket.emit('error', { message: 'Failed to join game' });
            return;
          }

          // Find creator socket
          const creatorSocket = Array.from(connectedClients.values())
            .find(c => c.userId === game.creatorId)?.socket;

          if (creatorSocket && creatorSocket.connected) {
            // Join both players to game room
            socket.join(game.gameId);
            creatorSocket.join(game.gameId);

            // Get creator info
            const creatorClient = connectedClients.get(creatorSocket.id);

            // Notify both players
            creatorSocket.emit('match_found', { 
              gameId: game.gameId, 
              yourColor: 'white',
              opponent: {
                username: client.username,
                elo: client.elo
              },
              timeControl: game.timeControl || 30
            });
            
            socket.emit('match_found', { 
              gameId: game.gameId, 
              yourColor: 'black',
              opponent: {
                username: creatorClient.username,
                elo: creatorClient.elo
              },
              timeControl: game.timeControl || 30
            });

            console.log(`Match found: ${game.gameId} - ${creatorClient.username} vs ${client.username}`);
          } else {
            socket.emit('error', { message: 'Opponent no longer available' });
            // Re-add game to waiting list
            waitingGames.push(game);
          }
        });
    } catch (error) {
      console.error('Search game error:', error);
      socket.emit('error', { message: 'Server error during game search' });
    }
  });

  // Handle move with enhanced error handling
  socket.on('move', async (data) => {
    try {
      connectionHeartbeats.set(socket.id, Date.now());
      const client = connectedClients.get(socket.id);
      if (!client) {
        socket.emit('error', { message: 'User not authenticated' });
        return;
      }

      const { gameId, move } = data;
      if (!gameId || !move) {
        socket.emit('invalid_move', { reason: 'Game ID and move required' });
        return;
      }

      // Validate and process move
      let fen;
      try {
        fen = await redis.get(`game:${gameId}:fen`);
      } catch (redisError) {
        console.error('Redis error getting FEN:', redisError);
        socket.emit('invalid_move', { reason: 'Game state unavailable' });
        return;
      }

      if (!fen) {
        socket.emit('invalid_move', { reason: 'Game not found' });
        return;
      }

      const chess = new Chess(fen);
      const moveResult = chess.move(move);
      
      if (!moveResult) {
        socket.emit('invalid_move', { reason: 'Invalid move' });
        return;
      }

      // Update game state with retry
      try {
        await redis.set(`game:${gameId}:fen`, chess.fen());
        await redis.set(`game:${gameId}:turn`, chess.turn() === 'w' ? 'white' : 'black');
      } catch (redisError) {
        console.error('Redis error updating game state:', redisError);
      }

      // Store move in database
      db.run('INSERT INTO game_moves (game_id, move_number, move_notation, player_id) VALUES (?, ?, ?, ?)',
        [gameId, chess.history().length, move, client.userId]);

      // Broadcast move to game room
      const moveData = {
        gameId,
        move: moveResult.san,
        from: moveResult.from,
        to: moveResult.to,
        fen: chess.fen(),
        turn: chess.turn() === 'w' ? 'white' : 'black',
        player: client.username
      };

      // Check for game end
      if (chess.isGameOver()) {
        let result = 'draw';
        let winner = null;
        let reason = 'unknown';

        if (chess.isCheckmate()) {
          result = chess.turn() === 'w' ? 'black_wins' : 'white_wins';
          winner = chess.turn() === 'w' ? 'black' : 'white';
          reason = 'checkmate';
        } else if (chess.isStalemate()) {
          reason = 'stalemate';
        } else if (chess.isDraw()) {
          reason = 'draw';
        }

        moveData.gameEnd = {
          result,
          winner,
          reason
        };

        // Update game in database
        db.run('UPDATE games SET status = ?, end_reason = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['finished', reason, gameId]);
      }

      // Use safe emit to handle disconnected clients
      const room = io.to(gameId);
      room.emit('move_made', moveData);
      console.log(`Move processed: ${move} in game ${gameId}`);

    } catch (error) {
      console.error('Move error:', error);
      socket.emit('error', { message: 'Server error processing move' });
    }
  });

  // Handle chat with enhanced validation
  socket.on('chat', (data) => {
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
        timestamp: Date.now()
      };

      io.to(gameId).emit('chat', chatData);
      console.log(`Chat: ${client.username} in ${gameId}: ${message.substring(0, 50)}...`);
    } catch (error) {
      console.error('Chat error:', error);
    }
  });

  // Handle resignation
  socket.on('resign', async (data) => {
    try {
      connectionHeartbeats.set(socket.id, Date.now());
      const client = connectedClients.get(socket.id);
      if (!client) return;

      const { gameId } = data;
      if (!gameId) return;

      // Update game status
      db.run('UPDATE games SET status = ?, end_reason = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['finished', 'resignation', gameId]);

      const gameOverData = {
        gameId,
        result: 'resignation',
        resignedPlayer: client.username,
        reason: 'Player resigned'
      };

      io.to(gameId).emit('game_over', gameOverData);
      console.log(`Game ${gameId}: ${client.username} resigned`);
    } catch (error) {
      console.error('Resignation error:', error);
    }
  });

  // Handle cancel matchmaking
  socket.on('cancel_matchmaking', () => {
    try {
      connectionHeartbeats.set(socket.id, Date.now());
      const client = connectedClients.get(socket.id);
      if (!client) return;

      const gameIndex = waitingGames.findIndex(g => g.creatorId === client.userId);
      if (gameIndex !== -1) {
        const game = waitingGames[gameIndex];
        waitingGames.splice(gameIndex, 1);
        
        // Clean up database
        db.run('DELETE FROM games WHERE id = ? AND status = ?', [game.gameId, 'waiting']);
        
        socket.emit('matchmaking_cancelled');
        console.log(`Matchmaking cancelled by ${client.username}`);
      }
    } catch (error) {
      console.error('Cancel matchmaking error:', error);
    }
  });

  // Enhanced disconnect handler with better error reporting
  socket.on('disconnect', (reason) => {
    try {
      const client = connectedClients.get(socket.id);
      if (client) {
        const transport = client.transport || socket.conn.transport.name;
        const connectionDuration = ((Date.now() - client.connectedAt) / 1000).toFixed(1);
        
        console.log(`Client disconnected: ${client.username} (${socket.id}) - Reason: ${reason} - Transport: ${transport} - Duration: ${connectionDuration}s`);
        
        // Log additional disconnect context
        if (reason === 'transport error') {
          console.log(`Transport error details for ${client.username}: Last transport was ${transport}`);
        }
        
        cleanupClient(socket.id, client.username);
      } else {
        console.log(`Unknown client disconnected: ${socket.id} - Reason: ${reason}`);
        connectionHeartbeats.delete(socket.id);
      }
    } catch (error) {
      console.error('Disconnect handler error:', error);
    }
  });

  // Enhanced connection error handler
  socket.on('error', (error) => {
    const client = connectedClients.get(socket.id);
    const username = client ? client.username : 'unknown';
    console.error(`Socket error for ${username} (${socket.id}):`, error.message);
  });

  // Connection close handler
  socket.on('close', (reason) => {
    const client = connectedClients.get(socket.id);
    const username = client ? client.username : 'unknown';
    console.log(`Socket closed for ${username} (${socket.id}): ${reason}`);
  });
});

// Enhanced health check endpoint
app.get('/health', (req, res) => {
  const uptime = Math.floor(process.uptime());
  const memUsage = process.memoryUsage();
  
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: uptime,
    connections: {
      active: connectedClients.size,
      heartbeats: connectionHeartbeats.size
    },
    games: {
      waiting: waitingGames.length
    },
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB'
    },
    redis: redis.status
  });
});

// Server info endpoint
app.get('/info', (req, res) => {
  res.json({
    server: 'RimChess Multiplayer Server',
    version: '1.1.0',
    uptime: Math.floor(process.uptime()),
    connections: connectedClients.size,
    games: {
      waiting: waitingGames.length,
      total: 'N/A' // Could query database for total
    },
    transports: ['websocket', 'polling'],
    features: [
      'Enhanced connection stability',
      'Transport fallback',
      'Connection monitoring',
      'Auto-cleanup',
      'Heartbeat tracking'
    ]
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    db.close();
    redis.quit();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    db.close();
    redis.quit();
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3030;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`RimChess server v1.1 running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Server info: http://localhost:${PORT}/info`);
  console.log(`Enhanced connection stability features enabled`);
});