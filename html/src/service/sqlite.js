// requires binding of SQLite

class SQLiteService {
    execute(callback, sql, args = null) {
        return new Promise((resolve, reject) => {
            SQLite.Execute(
                (err, data) => {
                    if (err !== null) {
                        reject(err);
                    } else if (data === null) {
                        resolve();
                    } else {
                        callback(data);
                    }
                },
                sql,
                args
            );
        });
    }

    executeNonQuery(sql, args = null) {
        return SQLite.ExecuteNonQuery(sql, args);
    }
}

var self = new SQLiteService();
window.sqliteService = self;

export {self as default, SQLiteService};
