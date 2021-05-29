import {sleep} from '../util';
import * as sqlite from '../service/sqlite';
import sharedRepository, {SharedRepository} from './shared';

var dirtyKeySet_: Set<string> = new Set();

function transformKey(key: string): string {
    return `config:${String(key).toLowerCase()}`;
}

async function syncLoop(): Promise<never> {
    while (true) {
        await sleep(500);
        try {
            if (dirtyKeySet_.size === 0) {
                continue;
            }
            await sqlite.exec('BEGIN');
            try {
                for (var key of [...dirtyKeySet_]) {
                    dirtyKeySet_.delete(key);
                    var value = sharedRepository.getString(key);
                    if (value === null) {
                        await sqlite.exec(
                            'DELETE FROM configs WHERE `key` = @key',
                            {
                                '@key': key
                            }
                        );
                    } else {
                        await sqlite.exec(
                            'INSERT OR REPLACE INTO configs (`key`, `value`) VALUES (@key, @value)',
                            {
                                '@key': key,
                                '@value': value
                            }
                        );
                    }
                }
            } finally {
                await sqlite.exec('COMMIT');
            }
        } catch (err) {
            console.error(err);
        }
    }
}

export class ConfigRepository extends SharedRepository {
    async init(): Promise<void> {
        await sqlite.exec(
            'CREATE TABLE IF NOT EXISTS configs (`key` TEXT PRIMARY KEY, `value` TEXT)'
        );
        await sqlite.query(
            ([key, value]) => super.setString(key, value),
            'SELECT `key`, `value` FROM configs'
        );
        syncLoop();
    }

    remove(key: string): boolean {
        var configKey = transformKey(key);
        dirtyKeySet_.add(configKey);
        return super.remove(configKey);
    }

    getString(key: string, defaultValue: string | null = null): string | null {
        return super.getString(transformKey(key), defaultValue);
    }

    setString(key: string, value: string): void {
        var configKey = transformKey(key);
        dirtyKeySet_.add(configKey);
        super.setString(configKey, String(value));
    }
}

var self = new ConfigRepository();
export {self as default};
