// requires binding of LogWatcher

interface GameLogContext {
    updatedAt: number;
    location?: string;
}

interface GameLog {
    dt: string;
    type: string;
    location?: string;
    worldName?: string;
    userDisplayName?: string;
    userType?: string;
    json?: string;
    event?: string;
    videoURL?: string;
    displayName?: string;
}

var contextMap: Map<string, GameLogContext> = new Map();

function parseRawGameLog(dt: string, type: string, args: string[]): GameLog {
    var gameLog = <GameLog>{
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
    }

    return gameLog;
}

export async function poll(): Promise<GameLog[]> {
    // @ts-ignore
    var logWatcher: any = window.LogWatcher;
    var rawGameLogs: any[] = await logWatcher.Get();
    var gameLogs: GameLog[] = [];
    var now = Date.now();

    for (var [fileName, dt, type, ...args] of rawGameLogs) {
        var context = contextMap.get(fileName);
        if (context === void 0) {
            context = <GameLogContext>{
                updatedAt: 0,
                location: void 0
            };
            contextMap.set(fileName, context);
        }

        var gameLog = parseRawGameLog(dt, type, args);
        gameLogs.push(gameLog);

        switch (gameLog.type) {
            case 'location':
                context.location = gameLog.location;
                break;
        }

        context.updatedAt = now;
    }

    return gameLogs;
}

export async function reset(): Promise<void> {
    // @ts-ignore
    var logWatcher: any = window.LogWatcher;
    await logWatcher.Reset();
    contextMap.clear();
}
