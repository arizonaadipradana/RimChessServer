// NEW: Generate board visualization for checkmate display
function generateBoardVisualization(chess) {
  if (!chess) return null;
  
  try {
    const board = chess.board();
    const visualization = {
      squares: {},
      pieces: {},
      checkSquares: [],
      lastMove: null
    };
    
    // Map all pieces and squares
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const square = String.fromCharCode(97 + file) + (rank + 1);
        const piece = board[rank][file];
        
        if (piece) {
          visualization.pieces[square] = {
            type: piece.type,
            color: piece.color,
            square: square
          };
        }
        
        visualization.squares[square] = {
          file: file,
          rank: rank,
          color: (file + rank) % 2 === 0 ? 'light' : 'dark',
          isEmpty: !piece
        };
      }
    }
    
    // Mark check squares
    if (chess.inCheck()) {
      const kingSquare = findKingSquare(chess, chess.turn());
      if (kingSquare) {
        visualization.checkSquares = [kingSquare];
      }
    }
    
    // Get last move for highlighting
    const history = chess.history({ verbose: true });
    if (history.length > 0) {
      const lastMove = history[history.length - 1];
      visualization.lastMove = {
        from: lastMove.from,
        to: lastMove.to,
        piece: lastMove.piece
      };
    }
    
    return visualization;
  } catch (error) {
    console.error('Error generating board visualization:', error);
    return null;
  }
}

// NEW: Find pieces giving check
function findCheckingPieces(chess) {
  if (!chess || !chess.inCheck()) return [];
  
  try {
    const kingSquare = findKingSquare(chess, chess.turn());
    if (!kingSquare) return [];
    
    const attackers = [];
    const opponentColor = chess.turn() === 'w' ? 'b' : 'w';
    
    // Get all opponent pieces and check if they attack the king
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const square = String.fromCharCode(97 + file) + (rank + 1);
        const piece = chess.get(square);
        
        if (piece && piece.color === opponentColor) {
          const moves = chess.moves({ square: square, verbose: true });
          if (moves.some(move => move.to === kingSquare)) {
            attackers.push({
              square: square,
              piece: piece.type,
              color: piece.color
            });
          }
        }
      }
    }
    
    return attackers;
  } catch (error) {
    console.error('Error finding checking pieces:', error);
    return [];
  }
}

// NEW: Find king square
function findKingSquare(chess, color) {
  try {
    const board = chess.board();
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const piece = board[rank][file];
        if (piece && piece.type === 'k' && piece.color === color) {
          return String.fromCharCode(97 + file) + (rank + 1);
        }
      }
    }
    return null;
  } catch (error) {
    console.error('Error finding king square:', error);
    return null;
  }
}

// NEW: Get attacked squares for visualization
function getAttackedSquares(chess) {
  if (!chess) return [];
  
  try {
    const attackedSquares = [];
    const opponentColor = chess.turn() === 'w' ? 'b' : 'w';
    
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const square = String.fromCharCode(97 + file) + (rank + 1);
        const piece = chess.get(square);
        
        if (piece && piece.color === opponentColor) {
          const moves = chess.moves({ square: square, verbose: true });
          moves.forEach(move => {
            if (!attackedSquares.includes(move.to)) {
              attackedSquares.push(move.to);
            }
          });
        }
      }
    }
    
    return attackedSquares;
  } catch (error) {
    console.error('Error getting attacked squares:', error);
    return [];
  }
}

// Helper function to get user by ID
async function getUserById(userId, db) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
      if (err) reject(err);
      else resolve(user);
    });
  });
}

// NEW: Calculate ELO changes for game result
async function calculateEloChanges(winnerId, loserId, db) {
  try {
    const winner = await getUserById(winnerId, db);
    const loser = await getUserById(loserId, db);
    
    if (!winner || !loser) {
      console.error('Could not find players for ELO calculation');
      return { winnerChange: 0, loserChange: 0 };
    }
    
    const winnerElo = winner.elo;
    const loserElo = loser.elo;
    
    // K-factor (rating volatility) - higher for newer players
    const winnerKFactor = winner.games_played < 10 ? 32 : winner.games_played < 30 ? 24 : 16;
    const loserKFactor = loser.games_played < 10 ? 32 : loser.games_played < 30 ? 24 : 16;
    
    // Expected scores based on ELO difference
    const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
    const expectedLoser = 1 / (1 + Math.pow(10, (winnerElo - loserElo) / 400));
    
    // Actual scores (1 for win, 0 for loss)
    const actualWinner = 1;
    const actualLoser = 0;
    
    // Calculate ELO changes
    const winnerChange = Math.round(winnerKFactor * (actualWinner - expectedWinner));
    const loserChange = Math.round(loserKFactor * (actualLoser - expectedLoser));
    
    console.log(`ELO calculation: ${winner.username} (${winnerElo}) vs ${loser.username} (${loserElo})`);
    console.log(`ELO changes: Winner +${winnerChange}, Loser ${loserChange}`);
    
    return {
      winnerChange: winnerChange,
      loserChange: loserChange,
      winnerNewElo: winnerElo + winnerChange,
      loserNewElo: Math.max(100, loserElo + loserChange) // Prevent ELO going below 100
    };
  } catch (error) {
    console.error('Error calculating ELO changes:', error);
    return { winnerChange: 0, loserChange: 0 };
  }
}

// NEW: Update player ELOs in database
async function updatePlayerElos(winnerId, loserId, eloChanges, db) {
  try {
    if (!eloChanges.winnerChange && !eloChanges.loserChange) return;
    
    // Update winner ELO and game count
    await new Promise((resolve, reject) => {
      db.run(`
        UPDATE users SET 
          elo = elo + ?,
          games_played = games_played + 1,
          games_won = games_won + 1
        WHERE id = ?
      `, [eloChanges.winnerChange, winnerId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    // Update loser ELO and game count
    await new Promise((resolve, reject) => {
      db.run(`
        UPDATE users SET 
          elo = MAX(100, elo + ?),
          games_played = games_played + 1
        WHERE id = ?
      `, [eloChanges.loserChange, loserId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    console.log(`ELO updates applied: Winner +${eloChanges.winnerChange}, Loser ${eloChanges.loserChange}`);
  } catch (error) {
    console.error('Error updating player ELOs:', error);
  }
}

module.exports = {
  getUserById,
  generateBoardVisualization,
  findCheckingPieces,
  findKingSquare,
  getAttackedSquares,
  calculateEloChanges,
  updatePlayerElos
};
