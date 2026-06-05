// State configuration
const SCREEN_STATE = {
  LOBBY: 'lobby',
  PLAYING: 'playing',
  COMPLETE: 'complete'
};

// Time formatting utility (MM:SS)
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

let currentState = SCREEN_STATE.LOBBY;
let socket = null;
let roomCode = '';
let startTime = null;

// Canvas assets
let bgCanvas = null;
let bgCtx = null;
let puzzleCanvas = null;
let puzzleCtx = null;

let stars = [];
let particles = [];
let animationFrameId = null;
let confettiInterval = null; // Tracked so we can clear it between games

// Game State
let puzzleImage = new Image();
let puzzleData = null; // Contains coordinates, pieces info
let dragPositions = new Map(); // pieceId -> { currentX, currentY } (for live drag visualizers)

// Procedural Audio Synthesizer (Same synth engine as desktop.js for zero asset load!)
let audioCtx = null;

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

const Sound = {
  playSnap() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, audioCtx.currentTime);
    osc.frequency.setValueAtTime(880, audioCtx.currentTime + 0.08);
    osc.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.2);
    
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
    
    osc.start();
    osc.stop(audioCtx.currentTime + 0.2);
  },

  playComplete() {
    if (!audioCtx) return;
    const osc1 = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc1.type = 'sawtooth';
    osc2.type = 'triangle';
    osc1.frequency.setValueAtTime(261.63, audioCtx.currentTime); // C4
    osc1.frequency.setValueAtTime(329.63, audioCtx.currentTime + 0.15); // E4
    osc1.frequency.setValueAtTime(392.00, audioCtx.currentTime + 0.3); // G4
    osc1.frequency.setValueAtTime(523.25, audioCtx.currentTime + 0.45); // C5
    
    osc2.frequency.setValueAtTime(523.25, audioCtx.currentTime);
    
    gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 1.2);
    
    osc1.start();
    osc2.start();
    osc1.stop(audioCtx.currentTime + 1.2);
    osc2.stop(audioCtx.currentTime + 1.2);
  }
};

// Particle effects
function spawnSparks(x, y, color, count = 25) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 6 + 2;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: Math.random() * 5 + 2,
      color,
      alpha: 1,
      decay: Math.random() * 0.02 + 0.01
    });
  }
}

// 1. STARFIELD BACKGROUND (Parallax)
function initStars() {
  stars = [];
  const numStars = 80;
  for (let i = 0; i < numStars; i++) {
    stars.push({
      x: Math.random() * bgCanvas.width,
      y: Math.random() * bgCanvas.height,
      size: Math.random() * 2 + 0.5,
      speed: Math.random() * 0.5 + 0.1
    });
  }
}

function updateStars() {
  stars.forEach(s => {
    s.y += s.speed;
    if (s.y > bgCanvas.height) {
      s.y = 0;
      s.x = Math.random() * bgCanvas.width;
    }
  });
}

function drawBackground() {
  bgCtx.fillStyle = '#060313';
  bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
  
  // Dynamic retro horizon glow in lobby state
  if (currentState === SCREEN_STATE.LOBBY) {
    const glowGrad = bgCtx.createRadialGradient(
      bgCanvas.width / 2, bgCanvas.height * 0.8, 50,
      bgCanvas.width / 2, bgCanvas.height * 0.8, bgCanvas.width * 0.6
    );
    glowGrad.addColorStop(0, 'rgba(255, 0, 127, 0.12)');
    glowGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    bgCtx.fillStyle = glowGrad;
    bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
  }

  bgCtx.fillStyle = '#ffffff';
  stars.forEach(s => {
    bgCtx.globalAlpha = s.speed * 1.5;
    bgCtx.fillRect(s.x, s.y, s.size, s.size);
  });
  bgCtx.globalAlpha = 1.0;
}

// 2. SOCKET CONNECTIONS
function setupConnection() {
  // Extract roomCode from URI path e.g. /screen/ABCD
  const pathParts = window.location.pathname.split('/');
  roomCode = pathParts[pathParts.length - 1].toUpperCase();

  if (!roomCode || roomCode === 'SCREEN') {
    document.getElementById('joinUrlVal').textContent = 'Error: Invalid Room Code. Setup via Admin Panel first.';
    return;
  }

  document.getElementById('roomCodeVal').textContent = roomCode;
  document.getElementById('hudRoomCode').textContent = roomCode;

  // Retrieve QR config data dynamically pointing to correct hostname
  fetch(`/api/room/config?roomCode=${roomCode}`)
    .then(res => res.json())
    .then(config => {
      document.getElementById('joinUrlVal').textContent = config.joinUrl;
      document.getElementById('qrcode').innerHTML = `<img src="${config.qrDataUrl}" alt="QR code" />`;
    })
    .catch(err => console.error('Error fetching QR config:', err));

  socket = io();

  // Register as host
  socket.emit('host-room', roomCode);

  socket.on('room-created', (data) => {
    console.log('Room registered on server:', data);
  });

  socket.on('player-joined', (player) => {
    initAudio();
    addPlayerToLobbyGrid(player);
  });

  socket.on('player-left', (player) => {
    removePlayerFromLobbyGrid(player.id);
  });

  socket.on('room-update', (data) => {
    document.getElementById('playerCount').textContent = data.participantsCount;
  });

  // Event: Puzzle starts!
  socket.on('activity-start', (data) => {
    if (data.type === 'jigsaw') {
      startJigsawPuzzle(data.state);
    }
  });

  // Event: Piece dragged/moved by player
  socket.on('piece-move', (data) => {
    const { pieceId, currentX, currentY } = data;
    dragPositions.set(pieceId, { currentX, currentY });
  });

  // Event: Piece snapped correctly
  socket.on('piece-placed', (data) => {
    const { pieceId, correctX, correctY, placedBy, progress, isSolved } = data;
    
    // Snapped piece removes its temporary live dragging marker
    dragPositions.delete(pieceId);
    
    if (puzzleData) {
      const piece = puzzleData.pieces.find(p => p.id === pieceId);
      if (piece) {
        piece.isPlaced = true;
        piece.currentX = correctX;
        piece.currentY = correctY;
        piece.placedByName = placedBy;
      }
    }

    // Play snapping audio and show visual toast
    Sound.playSnap();
    spawnSparks(correctX + (puzzleData.pieceWidth / 2), correctY + (puzzleData.pieceHeight / 2), '#ff007f');
    spawnSparks(correctX + (puzzleData.pieceWidth / 2), correctY + (puzzleData.pieceHeight / 2), '#00f3ff');
    
    // Ticker announcement
    const ticker = document.getElementById('activityTicker');
    ticker.textContent = `🎯 ${placedBy} placed piece (${progress}% solved)`;
    ticker.classList.add('pulse');
    setTimeout(() => ticker.classList.remove('pulse'), 400);

    // Update HUD
    document.getElementById('hudProgressFill').style.width = `${progress}%`;
    document.getElementById('hudProgressText').textContent = `${progress}%`;
  });

  // Event: Piece rotated by player
  socket.on('piece-rotated', (data) => {
    if (puzzleData) {
      const piece = puzzleData.pieces.find(p => p.id === data.pieceId);
      if (piece) {
        piece.rotation = data.rotation;
      }
    }
  });

  // Event: Puzzle solved!
  socket.on('activity-complete', (data) => {
    triggerPuzzleCompletion(data);
  });

  // Event: Timer tick from server
  socket.on('timer-update', (data) => {
    const hudTimer = document.getElementById('hudTimerText');
    if (hudTimer) {
      hudTimer.textContent = formatTime(data.elapsedTime);
    }
  });

  // Event: Leaderboard updates in real-time
  socket.on('leaderboard-update', (data) => {
    updateLeaderboardUI(data.leaderboard);
  });
}

// 3. LOBBY UTILITIES
function addPlayerToLobbyGrid(player) {
  const grid = document.getElementById('playerGrid');
  // Check if already in grid
  if (document.getElementById(`p-${player.id}`)) return;

  const div = document.createElement('div');
  div.id = `p-${player.id}`;
  div.className = 'player-avatar';
  div.style.borderColor = player.color;
  div.style.textShadow = `0 0 5px ${player.color}`;
  div.style.boxShadow = `0 0 8px ${player.color}22`;
  div.textContent = player.displayName.toUpperCase();
  grid.appendChild(div);

  document.getElementById('playerCount').textContent = grid.children.length;
}

function removePlayerFromLobbyGrid(playerId) {
  const element = document.getElementById(`p-${playerId}`);
  if (element) {
    element.remove();
  }
  const grid = document.getElementById('playerGrid');
  document.getElementById('playerCount').textContent = grid.children.length;
}

// 4. JIGSAW PUZZLE DRAW ENGINE
function startJigsawPuzzle(state) {
  currentState = SCREEN_STATE.PLAYING;
  startTime = new Date();

  // Clear any leftover confetti from a previous completed game
  if (confettiInterval !== null) {
    clearInterval(confettiInterval);
    confettiInterval = null;
  }

  // Transition views — must add 'active' to bring opacity from 0 → 1
  document.getElementById('lobbyScreen').classList.remove('active');
  document.getElementById('lobbyScreen').classList.add('hidden');
  document.getElementById('gameplayScreen').classList.remove('hidden');
  document.getElementById('gameplayScreen').classList.add('active');

  // Hide completion overlay if it was open
  const overlay = document.getElementById('completionOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.classList.remove('active');
  }

  puzzleData = state;
  if (state.pieces) {
    preCachePieceImages(state.pieces);
  }
  puzzleImage.src = state.imageUrl;
  
  // Pre-load image
  puzzleImage.onload = () => {
    console.log('Puzzle source image loaded successfully.');
  };
  puzzleImage.onerror = (err) => {
    console.error('Failed to load puzzle source image:', err);
  };

  // Sync initial HUD
  document.getElementById('hudProgressFill').style.width = `${state.progress}%`;
  document.getElementById('hudProgressText').textContent = `${state.progress}%`;

  // Sync timer display
  const hudTimer = document.getElementById('hudTimerText');
  if (hudTimer) {
    hudTimer.textContent = formatTime(state.elapsedTime || 0);
  }

  // Render initial leaderboard
  if (state.leaderboard) {
    updateLeaderboardUI(state.leaderboard);
  }
}

// Render dynamic gameplay leaderboard sidebar
function updateLeaderboardUI(leaderboard) {
  const list = document.getElementById('gameLeaderboardList');
  if (!list) return;
  list.innerHTML = '';

  leaderboard.forEach((player, index) => {
    const item = document.createElement('div');
    item.className = `game-leaderboard-item ${index === 0 ? 'first-place' : ''}`;

    const rankPrefix = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;

    item.innerHTML = `
      <div class="rank-name">
        <span class="rank">${rankPrefix}</span>
        <span class="name" style="color: ${player.color}">${player.displayName.toUpperCase()}</span>
      </div>
      <div class="score">${player.score}</div>
    `;
    list.appendChild(item);
  });
}

function updateJigsaw() {
  if (currentState !== SCREEN_STATE.PLAYING || !puzzleData) return;

  // Let unplaced pieces drift gently on screen edges to look active
  puzzleData.pieces.forEach(p => {
    if (!p.isPlaced) {
      // If the piece is currently being dragged, pull it towards the drag position.
      // Otherwise, let it drift slowly in its spot.
      const dragPos = dragPositions.get(p.id);
      if (dragPos) {
        // Interp towards player drag coordinates
        p.currentX += (dragPos.currentX - p.currentX) * 0.2;
        p.currentY += (dragPos.currentY - p.currentY) * 0.2;
      } else {
        // Natural drift
        p.currentX += Math.sin(Date.now() / 1500 + p.row) * 0.15;
        p.currentY += Math.cos(Date.now() / 1500 + p.col) * 0.15;
      }
    }
  });

  // Update particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const pt = particles[i];
    pt.x += pt.vx;
    pt.y += pt.vy;
    pt.alpha -= pt.decay;
    if (pt.alpha <= 0) {
      particles.splice(i, 1);
    }
  }
}

function drawJigsaw() {
  if (currentState !== SCREEN_STATE.PLAYING || !puzzleData) return;

  puzzleCtx.clearRect(0, 0, puzzleCanvas.width, puzzleCanvas.height);

  // 1. Draw faded background guidelines image (Ghost)
  if (puzzleImage.complete) {
    puzzleCtx.save();
    puzzleCtx.globalAlpha = 0.08;
    puzzleCtx.drawImage(puzzleImage, 0, 0, puzzleCanvas.width, puzzleCanvas.height);
    puzzleCtx.restore();
  }

  // 2. Draw Grid Lines
  puzzleCtx.strokeStyle = 'rgba(0, 243, 255, 0.15)';
  puzzleCtx.lineWidth = 1;
  for (let r = 0; r <= puzzleData.rows; r++) {
    const y = r * puzzleData.pieceHeight;
    puzzleCtx.beginPath();
    puzzleCtx.moveTo(0, y);
    puzzleCtx.lineTo(puzzleCanvas.width, y);
    puzzleCtx.stroke();
  }
  for (let c = 0; c <= puzzleData.cols; c++) {
    const x = c * puzzleData.pieceWidth;
    puzzleCtx.beginPath();
    puzzleCtx.moveTo(x, 0);
    puzzleCtx.lineTo(x, puzzleCanvas.height);
    puzzleCtx.stroke();
  }

  // 3. Draw Placed pieces first (lower layer)
  puzzleData.pieces.forEach(p => {
    if (p.isPlaced && p.imgElement) {
      puzzleCtx.drawImage(
        p.imgElement,
        p.currentX,
        p.currentY,
        puzzleData.pieceWidth,
        puzzleData.pieceHeight
      );
    }
  });

  // 4. Draw Floating unplaced pieces (upper layer with neon border glows)
  puzzleData.pieces.forEach(p => {
    if (!p.isPlaced && p.imgElement) {
      puzzleCtx.save();
      
      const centerX = p.currentX + puzzleData.pieceWidth / 2;
      const centerY = p.currentY + puzzleData.pieceHeight / 2;
      puzzleCtx.translate(centerX, centerY);
      
      const rotationRad = ((p.rotation || 0) * Math.PI) / 180;
      puzzleCtx.rotate(rotationRad);

      // Draw neon placeholder box glow
      puzzleCtx.shadowBlur = 15;
      puzzleCtx.shadowColor = '#00f3ff';
      puzzleCtx.strokeStyle = 'rgba(0, 243, 255, 0.6)';
      puzzleCtx.lineWidth = 2;
      puzzleCtx.strokeRect(-puzzleData.pieceWidth / 2, -puzzleData.pieceHeight / 2, puzzleData.pieceWidth, puzzleData.pieceHeight);

      // Draw actual piece image
      puzzleCtx.drawImage(
        p.imgElement,
        -puzzleData.pieceWidth / 2,
        -puzzleData.pieceHeight / 2,
        puzzleData.pieceWidth,
        puzzleData.pieceHeight
      );
      puzzleCtx.restore();
    }
  });

  // 5. Draw active Particles
  particles.forEach(pt => {
    puzzleCtx.save();
    puzzleCtx.globalAlpha = pt.alpha;
    puzzleCtx.shadowBlur = pt.size * 2;
    puzzleCtx.shadowColor = pt.color;
    puzzleCtx.fillStyle = pt.color;
    puzzleCtx.beginPath();
    puzzleCtx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
    puzzleCtx.fill();
    puzzleCtx.restore();
  });
}

// Helper to pre-load image slices into HTMLImageElements for performance
function preCachePieceImages(pieces) {
  pieces.forEach(p => {
    const img = new Image();
    img.src = p.imageUrl;
    p.imgElement = img;
  });
}

// 5. SOLVED CELEBRATION
function triggerPuzzleCompletion({ leaderboard, totalPieces, elapsedTime, winnerName, winnerScore, totalPlayers, piecesPlaced }) {
  currentState = SCREEN_STATE.COMPLETE;
  Sound.playComplete();

  // Populate completion overlay (synthwave modal)
  document.getElementById('compWinner').textContent = (winnerName || 'N/A').toUpperCase();
  document.getElementById('compScore').textContent = winnerScore || 0;
  document.getElementById('compTime').textContent = formatTime(elapsedTime || 0);
  document.getElementById('compPlayers').textContent = totalPlayers || 0;
  document.getElementById('compPieces').textContent = piecesPlaced || totalPieces || 0;

  // Show the overlay above the board
  const overlay = document.getElementById('completionOverlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.offsetWidth; // force reflow for smooth scale/opacity transition
    overlay.classList.add('active');
  }

  // Populate legacy winner banner & stats for compatibility
  if (leaderboard && leaderboard.length > 0) {
    const winner = leaderboard[0];
    document.getElementById('winnerName').textContent = winner.displayName.toUpperCase();
    document.getElementById('winnerScore').textContent = winner.score;
    document.getElementById('winnerBanner').classList.remove('hidden');
  } else {
    document.getElementById('winnerBanner').classList.add('hidden');
  }

  document.getElementById('totalSlicesPlaced').textContent = totalPieces;
  document.getElementById('solvedDuration').textContent = `${elapsedTime || 0} seconds`;

  // Render legacy leaderboard list
  const list = document.getElementById('leaderboardList');
  if (list) {
    list.innerHTML = '';
    leaderboard.forEach((player, index) => {
      const item = document.createElement('div');
      item.className = `leaderboard-item ${index === 0 ? 'first-place' : ''}`;
      const rankPrefix = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
      item.innerHTML = `
        <div class="rank-name">
          <span class="rank">${rankPrefix}</span>
          <span class="name" style="color: ${player.color}">${player.displayName.toUpperCase()}</span>
        </div>
        <div class="score">${player.score} PTS</div>
      `;
      list.appendChild(item);
    });
  }

  // Spawn dynamic rain of completion particles (confetti)
  // Store the interval ID so it can be cancelled on the next game start.
  confettiInterval = setInterval(() => {
    if (currentState === SCREEN_STATE.COMPLETE) {
      const rx = Math.random() * puzzleCanvas.width;
      const ry = Math.random() * puzzleCanvas.height * 0.4;
      spawnSparks(rx, ry, '#39ff14', 8);
      spawnSparks(rx, ry, '#00f3ff', 8);
    }
  }, 400);
}

// Main Frame tick
function gameLoop() {
  updateStars();
  drawBackground();

  if (currentState === SCREEN_STATE.PLAYING || currentState === SCREEN_STATE.COMPLETE) {
    updateJigsaw();
    drawJigsaw();
  }

  animationFrameId = requestAnimationFrame(gameLoop);
}

// Resizing handler
function handleResize() {
  if (bgCanvas) {
    bgCanvas.width = window.innerWidth;
    bgCanvas.height = window.innerHeight;
    initStars();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  bgCanvas = document.getElementById('bgCanvas');
  bgCtx = bgCanvas.getContext('2d');

  puzzleCanvas = document.getElementById('puzzleCanvas');
  puzzleCtx = puzzleCanvas.getContext('2d');

  window.addEventListener('resize', handleResize);
  handleResize();

  setupConnection();

  // Run screen rendering thread
  gameLoop();
});
