// requires binding of SQLite

interface SQLiteArgs {
    [key: string]: any;
}

export function query(
    rowCallback: (data: any[]) => void,
    sql: string,
    args: SQLiteArgs | null = null
): Promise<void> {
    return new Promise((resolve, reject) => {
        // @ts-ignore
        var sqlite: any = window.SQLite;
        sqlite.Execute(
            (err: any, data: any[]) => {
                if (err !== null) {
                    reject(err);
                } else if (data === null) {
                    resolve();
                } else {
                    rowCallback(data);
                }
            },
            sql,
            args
        );
    });
}

export function exec(sql: string, args: SQLiteArgs | null = null) {
    // @ts-ignore
    var sqlite: any = window.SQLite;
    return sqlite.ExecuteNonQuery(sql, args);
}
