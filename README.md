# RimChess Multiplayer Server

This is the Node.js backend server for RimChess online multiplayer functionality.

## Requirements

- **Node.js** (v16 or higher) - [Download here](https://nodejs.org/)
- **Redis** (for game state caching) - [Installation guide](https://redis.io/download) or use Docker

## Quick Start

### Method 1: Using the Batch File (Windows)
1. Double-click `start-server.bat`
2. The script will automatically install dependencies and start the server

### Method 2: Manual Setup
1. Install dependencies:
   ```bash
   npm install
   ```

2. Start Redis (choose one):
   ```bash
   # Local Redis installation
   redis-server
   
   # Or using Docker
   docker run -d -p 6379:6379 redis
   ```

3. Start the server:
   ```bash
   npm start
   ```

The server will start on `http://localhost:3000`

## Features

✅ **User Authentication** - Registration and login with bcrypt password hashing  
✅ **Matchmaking System** - Create games or search for opponents with ELO-based matching  
✅ **Real-time Chess** - Authoritative server using chess.js for move validation  
✅ **Chat System** - In-game chat between players  
✅ **ELO Rating System** - Competitive ranking with proper rating calculations  
✅ **Game Statistics** - Track wins, losses, and performance  
✅ **RESTful API** - Statistics and leaderboard endpoints  

## Configuration

### Environment Variables
- `PORT` - Server port (default: 3000)
- `REDIS_HOST` - Redis host (default: localhost)
- `REDIS_PORT` - Redis port (default: 6379)

### Database
- **SQLite** - User accounts, game history (stored in `rimchess.db`)
- **Redis** - Real-time game state, active sessions

## API Endpoints

- `GET /health` - Server health check
- `GET /api/stats` - Server and game statistics
- `GET /api/leaderboard` - Top players by ELO rating

## Troubleshooting

### Common Issues

**"Redis connection error"**
- Make sure Redis is running on localhost:6379
- Try: `redis-cli ping` (should return "PONG")

**"Port 3000 already in use"**
- Change the port: `PORT=3001 npm start`
- Or kill the existing process using the port

**"Module not found" errors**
- Run `npm install` to install dependencies
- Delete `node_modules` and `package-lock.json`, then run `npm install` again

### Logs
The server provides detailed logging for:
- 🎮 Game events (moves, connections, matchmaking)
- 📊 Database operations
- 🔗 Network connections
- ❌ Errors and warnings

## Development

### Testing the Server
1. Start the server
2. Open `http://localhost:3000/health` - should show server status
3. Check `http://localhost:3000/api/stats` - should show game statistics

### Log Levels
The server logs different types of events:
- Connection events (🔗)
- Game events (🎮) 
- Database events (📊)
- Errors (❌)

## Security Notes

- Passwords are hashed with bcrypt (salt rounds: 12)
- CORS is enabled for development (restrict in production)
- No rate limiting implemented (add for production)
- WebSocket connections accept from any origin (restrict in production)

## Production Deployment

For production deployment:
1. Set up a proper Redis instance
2. Configure environment variables
3. Add rate limiting and proper CORS settings
4. Use a process manager like PM2
5. Set up HTTPS with SSL certificates
6. Configure firewalls and security groups
