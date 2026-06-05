class BaseActivity {
  constructor(roomCode, config, roomManager) {
    this.roomCode = roomCode;
    this.config = config;
    this.roomManager = roomManager;
    this.status = 'active'; // active, completed
    this.startedAt = new Date();
    this.completedAt = null;
    this.elapsedTime = 0;
  }

  // Lifecycle methods
  onStart() {}
  onPlayerJoin(player) {}
  onPlayerAction(player, actionType, actionData) {}
  onPlayerLeave(player) {}
  onEnd() {
    this.status = 'completed';
    this.completedAt = new Date();
    this.cleanup();
  }

  cleanup() {}

  // State synchronization formats
  getStateForScreen() {
    return {
      status: this.status,
      startedAt: this.startedAt,
      completedAt: this.completedAt
    };
  }

  getStateForPlayer(playerId) {
    return {
      status: this.status
    };
  }

  getProgress() {
    return 0; // percentage from 0 to 100
  }
}

module.exports = BaseActivity;
