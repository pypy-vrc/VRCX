// Copyright(c) 2019 pypy. All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;

namespace VRCX
{
    public class VRCXStorage
    {
        internal static readonly VRCXStorage Instance;
        private static readonly ReaderWriterLockSlim m_Lock = new ReaderWriterLockSlim();
        private static Dictionary<string, string> m_Storage = new Dictionary<string, string>();
        private static string m_JsonPath = Path.Combine(Program.AppDataPath, "VRCX.json");
        private static bool m_Dirty;

        static VRCXStorage()
        {
            Instance = new VRCXStorage();
        }

        internal static void Load()
        {
            m_Lock.EnterWriteLock();
            try
            {
                JsonSerializer.Deserialize(m_JsonPath, ref m_Storage);
                m_Dirty = false;
            }
            finally
            {
                m_Lock.ExitWriteLock();
            }
        }

        internal static void Save()
        {
            m_Lock.EnterReadLock();
            try
            {
                if (m_Dirty)
                {
                    JsonSerializer.Serialize(m_JsonPath, m_Storage);
                    m_Dirty = false;
                }
            }
            finally
            {
                m_Lock.ExitReadLock();
            }
        }

        public void Flush()
        {
            Save();
        }

        public void Clear()
        {
            m_Lock.EnterWriteLock();
            try
            {
                if (m_Storage.Count > 0)
                {
                    m_Storage.Clear();
                    m_Dirty = true;
                }
            }
            finally
            {
                m_Lock.ExitWriteLock();
            }
        }

        public bool Remove(string key)
        {
            m_Lock.EnterWriteLock();
            try
            {
                var result = m_Storage.Remove(key);
                if (result)
                {
                    m_Dirty = true;
                }
                return result;
            }
            finally
            {
                m_Lock.ExitWriteLock();
            }
        }

        public string Get(string key)
        {
            m_Lock.EnterReadLock();
            try
            {
                return m_Storage.TryGetValue(key, out string value)
                    ? value
                    : string.Empty;
            }
            finally
            {
                m_Lock.ExitReadLock();
            }
        }

        public void Set(string key, string value)
        {
            m_Lock.EnterWriteLock();
            try
            {
                m_Storage[key] = value;
                m_Dirty = true;
            }
            finally
            {
                m_Lock.ExitWriteLock();
            }
        }
    }
}
