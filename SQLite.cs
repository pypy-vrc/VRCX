using CefSharp;
using System;
using System.Collections.Generic;
using System.Data.SQLite;
using System.IO;
using System.Threading;

namespace VRCX
{
    public class SQLite
    {
        internal static readonly SQLite Instance = new SQLite();
        private readonly ReaderWriterLockSlim m_ConnectionLock = new ReaderWriterLockSlim();
        private SQLiteConnection m_Connection;

        internal void Init()
        {
            var dataSource = Path.Combine(Program.AppDataPath, "VRCX.sqlite3");
            m_Connection = new SQLiteConnection(
                $"Data Source=\"{dataSource}\";Version=3;PRAGMA locking_mode=NORMAL;PRAGMA busy_timeout=5000",
                true);
            m_Connection.Open();
        }

        internal void Exit()
        {
            m_Connection.Close();
            m_Connection.Dispose();
        }

        public void Execute(
            IJavascriptCallback callback,
            string sql,
            IDictionary<string, object> args = null)
        {
            try
            {
                m_ConnectionLock.EnterReadLock();
                try
                {
                    using (var command = new SQLiteCommand(sql, m_Connection))
                    {
                        if (args != null)
                        {
                            foreach (var arg in args)
                            {
                                command.Parameters.Add(
                                    new SQLiteParameter(arg.Key, arg.Value));
                            }
                        }
                        using (var reader = command.ExecuteReader())
                        {
                            while (reader.Read() == true)
                            {
                                var values = new object[reader.FieldCount];
                                reader.GetValues(values);
                                if (callback.CanExecute == true)
                                {
                                    callback.ExecuteAsync(null, values);
                                }
                            }
                        }
                    }
                    if (callback.CanExecute == true)
                    {
                        callback.ExecuteAsync(null, null);
                    }
                }
                finally
                {
                    m_ConnectionLock.ExitReadLock();
                }
            }
            catch (Exception e)
            {
                if (callback.CanExecute == true)
                {
                    callback.ExecuteAsync(e.Message, null);
                }
            }

            callback.Dispose();
        }

        public void Execute(
            Action<object[]> callback,
            string sql,
            IDictionary<string, object> args = null)
        {
            m_ConnectionLock.EnterReadLock();
            try
            {
                using (var command = new SQLiteCommand(sql, m_Connection))
                {
                    if (args != null)
                    {
                        foreach (var arg in args)
                        {
                            command.Parameters.Add(
                                new SQLiteParameter(arg.Key, arg.Value));
                        }
                    }
                    using (var reader = command.ExecuteReader())
                    {
                        while (reader.Read() == true)
                        {
                            var values = new object[reader.FieldCount];
                            reader.GetValues(values);
                            callback(values);
                        }
                    }
                }
            }
            catch
            {
            }
            finally
            {
                m_ConnectionLock.ExitReadLock();
            }
        }

        public int ExecuteNonQuery(
            string sql,
            IDictionary<string, object> args = null)
        {
            int result = -1;

            m_ConnectionLock.EnterWriteLock();
            try
            {
                using (var command = new SQLiteCommand(sql, m_Connection))
                {
                    if (args != null)
                    {
                        foreach (var arg in args)
                        {
                            command.Parameters.Add(new SQLiteParameter(arg.Key, arg.Value));
                        }
                    }
                    result = command.ExecuteNonQuery();
                }
            }
            finally
            {
                m_ConnectionLock.ExitWriteLock();
            }

            return result;
        }
    }
}
