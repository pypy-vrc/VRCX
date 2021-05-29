// Copyright(c) 2020 pypy. All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

using System.Collections.Generic;
using System.Threading;

namespace VRCX
{
    public class SharedVariable
    {
        internal static readonly SharedVariable Instance = new SharedVariable();
        private readonly ReaderWriterLockSlim m_MapLock = new ReaderWriterLockSlim();
        private readonly Dictionary<string, string> m_Map = new Dictionary<string, string>();

        public void Clear()
        {
            m_MapLock.EnterWriteLock();
            try
            {
                m_Map.Clear();
            }
            finally
            {
                m_MapLock.ExitWriteLock();
            }
        }

        public string Get(string key)
        {
            m_MapLock.EnterReadLock();
            try
            {
                if (m_Map.TryGetValue(key, out string value) == true)
                {
                    return value;
                }
            }
            finally
            {
                m_MapLock.ExitReadLock();
            }

            return null;
        }

        public void Set(string key, string value)
        {
            m_MapLock.EnterWriteLock();
            try
            {
                m_Map[key] = value;
            }
            finally
            {
                m_MapLock.ExitWriteLock();
            }
        }

        public bool Remove(string key)
        {
            m_MapLock.EnterWriteLock();
            try
            {
                return m_Map.Remove(key);
            }
            finally
            {
                m_MapLock.ExitWriteLock();
            }
        }
    }
}
