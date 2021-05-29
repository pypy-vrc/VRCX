// requires binding of LogWatcher

// <string, object>
var contextMap = new Map();

function parseRawGameLog(dt, type, args) {
    var gameLog = {
        dt,
        type
    };

    switch (type) {
        case 'location':
            gameLog.location = args[0];
            gameLog.worldName = args[1];
            break;

        case 'player-joined':
            gameLog.userDisplayName = args[0];
            gameLog.userType = args[1];
            break;

        case 'player-left':
            gameLog.userDisplayName = args[0];
            break;

        case 'notification':
            gameLog.json = args[0];
            break;

        case 'portal-spawn':
            gameLog.userDisplayName = args[0];
            break;

        case 'event':
            gameLog.event = args[0];
            break;

        case 'video-play':
            gameLog.videoURL = args[0];
            gameLog.displayName = args[1];
            break;

        default:
            break;
    }

    return gameLog;
}

class GameLogService {
    async poll() {
        var rawGameLogs = await LogWatcher.Get();
        var gameLogs = [];
        var now = Date.now();

        for (var [fileName, dt, type, ...args] of rawGameLogs) {
            var context = contextMap.get(fileName);
            if (typeof context === 'undefined') {
                context = {
                    updatedAt: null,

                    // location
                    location: null
                };
                contextMap.set(fileName, context);
            }

            var gameLog = parseRawGameLog(dt, type, args);

            switch (gameLog.type) {
                case 'location':
                    context.location = gameLog.location;
                    break;

                default:
                    break;
            }

            context.updatedAt = now;

            gameLogs.push(gameLog);
        }

        return gameLogs;
    }

    async reset() {
        await LogWatcher.Reset();
        contextMap.clear();
    }
}

var self = new GameLogService();
window.gameLogService = self;

export {self as default, GameLogService as LogWatcherService};
