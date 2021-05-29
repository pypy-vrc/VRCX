// Copyright(c) 2019 pypy. All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;

namespace VRCX
{
    public class LogWatcher
    {
        private class LogContext
        {
            internal long Length;
            internal long Position;
            internal string RecentWorldName;
            internal string LastVideoURL;
            internal bool ShaderKeywordsLimitReached = false;
        }

        internal static readonly LogWatcher Instance = new LogWatcher();
        private DirectoryInfo m_LogDirectoryInfo;
        private Dictionary<string, LogContext> m_LogContextMap; // <FileName, LogContext>
        private ReaderWriterLockSlim m_LogListLock;
        private List<string[]> m_LogList;
        private Thread m_Thread;
        private bool m_ResetLog;

        // NOTE
        // FileSystemWatcher() is unreliable

        internal void Init()
        {
            var logPath = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + @"Low\VRChat\VRChat";
            m_LogDirectoryInfo = new DirectoryInfo(logPath);
            m_LogContextMap = new Dictionary<string, LogContext>();
            m_LogListLock = new ReaderWriterLockSlim();
            m_LogList = new List<string[]>();
            m_Thread = new Thread(ThreadLoop)
            {
                IsBackground = true
            };
            m_Thread.Start();
        }

        internal void Exit()
        {
            var thread = m_Thread;
            m_Thread = null;
            thread.Interrupt();
            thread.Join();
        }

        private void ThreadLoop()
        {
            while (m_Thread != null)
            {
                Update();

                try
                {
                    Thread.Sleep(1000);
                }
                catch
                {
                    // ThreadInterruptedException
                }
            }
        }

        private void Update()
        {
            if (m_ResetLog == true)
            {
                m_ResetLog = false;
                m_LogContextMap.Clear();
                m_LogListLock.EnterWriteLock();
                try
                {
                    m_LogList.Clear();
                }
                finally
                {
                    m_LogListLock.ExitWriteLock();
                }
            }

            var deletedNameSet = new HashSet<string>(m_LogContextMap.Keys);
            m_LogDirectoryInfo.Refresh();

            if (m_LogDirectoryInfo.Exists == true)
            {
                var fileInfos = m_LogDirectoryInfo.GetFiles("output_log_*.txt", SearchOption.TopDirectoryOnly);

                // sort by creation time
                Array.Sort(fileInfos, (a, b) => a.CreationTimeUtc.CompareTo(b.CreationTimeUtc));

                var utcNow = DateTime.UtcNow;
                var minLimitDateTime = utcNow.AddDays(-7d);
                var minRefreshDateTime = utcNow.AddMinutes(-3d);

                foreach (var fileInfo in fileInfos)
                {
                    var lastWriteTimeUtc = fileInfo.LastWriteTimeUtc;

                    if (lastWriteTimeUtc < minLimitDateTime)
                    {
                        continue;
                    }

                    if (lastWriteTimeUtc >= minRefreshDateTime)
                    {
                        fileInfo.Refresh();
                        if (fileInfo.Exists == false)
                        {
                            continue;
                        }
                    }

                    if (m_LogContextMap.TryGetValue(fileInfo.Name, out LogContext logContext) == true)
                    {
                        deletedNameSet.Remove(fileInfo.Name);
                    }
                    else
                    {
                        logContext = new LogContext();
                        m_LogContextMap.Add(fileInfo.Name, logContext);
                    }

                    if (logContext.Length == fileInfo.Length)
                    {
                        continue;
                    }

                    logContext.Length = fileInfo.Length;
                    ParseLog(fileInfo, logContext);
                }
            }

            foreach (var name in deletedNameSet)
            {
                m_LogContextMap.Remove(name);
            }
        }

        private void ParseLog(FileInfo fileInfo, LogContext logContext)
        {
            try
            {
                using (var stream = new FileStream(fileInfo.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 65536, FileOptions.SequentialScan))
                {
                    stream.Position = logContext.Position;
                    using (var streamReader = new StreamReader(stream, Encoding.UTF8))
                    {
                        while (true)
                        {
                            var line = streamReader.ReadLine();
                            if (line == null)
                            {
                                logContext.Position = stream.Position;
                                break;
                            }

                            // 2020.10.31 23:36:28 Log        -  [VRCFlowManagerVRC] Destination fetching: wrld_4432ea9b-729c-46e3-8eaf-846aa0a37fdd
                            // 2021.02.03 10:18:58 Log        -  [ǄǄǅǅǅǄǄǅǅǄǅǅǅǅǄǄǄǅǅǄǄǅǅǅǅǄǅǅǅǅǄǄǄǄǄǅǄǅǄǄǄǅǅǄǅǅǅ] Destination fetching: wrld_4432ea9b-729c-46e3-8eaf-846aa0a37fdd

                            if (line.Length <= 36 ||
                                line[31] != '-')
                            {
                                continue;
                            }

                            if (line[34] == '[')
                            {
                                var offset = line.IndexOf("] ", 35, StringComparison.Ordinal);
                                if (offset >= 35)
                                {
                                    offset += 2;
                                    if (ParseLogOnPlayerJoinedOrLeft(fileInfo, logContext, line, offset) == true ||
                                        ParseLogLocation(fileInfo, logContext, line, offset) == true ||
                                        ParseLogPortalSpawn(fileInfo, logContext, line, offset) == true ||
                                        ParseLogJoinBlocked(fileInfo, logContext, line, offset) == true ||
                                        ParseLogAvatarPedestalChange(fileInfo, logContext, line, offset) == true ||
                                        ParseLogVideoPlay(fileInfo, logContext, line, offset) == true ||
                                        ParseLogVideoError(fileInfo, logContext, line, offset) == true)
                                    {
                                        continue;
                                    }
                                }
                                continue;
                            }

                            if (ParseLogNotification(fileInfo, logContext, line, 34) == true ||
                                ParseLogShaderKeywordsLimit(fileInfo, logContext, line, 34) == true ||
                                ParseLogSDK2VideoPlay(fileInfo, logContext, line, 34) == true)
                            {
                                continue;
                            }
                        }
                    }
                }
            }
            catch
            {
            }
        }

        private void AppendLog(string[] item)
        {
            m_LogListLock.EnterWriteLock();
            try
            {
                m_LogList.Add(item);
            }
            finally
            {
                m_LogListLock.ExitWriteLock();
            }
        }

        private string ConvertLogTimeToISO8601(string line)
        {
            // 2020.10.31 23:36:22

            if (DateTime.TryParseExact(
                line.Substring(0, 19),
                "yyyy.MM.dd HH:mm:ss",
                CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeLocal,
                out DateTime dt
            ) == false)
            {
                dt = DateTime.UtcNow;
            }

            return $"{dt:yyyy'-'MM'-'dd'T'HH':'mm':'ss'Z'}";
        }

        private bool ParseLogLocation(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2020.10.31 23:36:28 Log        -  [VRCFlowManagerVRC] Destination fetching: wrld_4432ea9b-729c-46e3-8eaf-846aa0a37fdd
            // 2020.10.31 23:36:28 Log        -  [VRCFlowManagerVRC] Destination set: wrld_4432ea9b-729c-46e3-8eaf-846aa0a37fdd
            // 2020.10.31 23:36:31 Log        -  [RoomManager] Entering Room: VRChat Home
            // 2020.10.31 23:36:31 Log        -  [RoomManager] Joining wrld_4432ea9b-729c-46e3-8eaf-846aa0a37fdd:67646~private(usr_4f76a584-9d4b-46f6-8209-8305eb683661)~nonce(D9298A536FEEEDDBB61633661A4BDAA09717C5178DEF865C4C09372FE12E09A6)
            // 2020.10.31 23:36:31 Log        -  [RoomManager] Joining or Creating Room: VRChat Home
            // 2020.10.31 23:36:31 Log        -  [RoomManager] Successfully joined room
            // 2021.02.03 10:18:58 Log        -  [ǄǄǅǅǅǄǄǅǅǄǅǅǅǅǄǄǄǅǅǄǄǅǅǅǅǄǅǅǅǅǄǄǄǄǄǅǄǅǄǄǄǅǅǄǅǅǅ] Destination fetching: wrld_4432ea9b-729c-46e3-8eaf-846aa0a37fdd

            if (string.Compare(line, offset, "Entering Room: ", 0, 15, StringComparison.Ordinal) == 0)
            {
                var worldName = line.Substring(offset + 15);
                logContext.RecentWorldName = worldName;
                return true;
            }

            if (string.Compare(line, offset, "Joining wrld_", 0, 13, StringComparison.Ordinal) == 0)
            {
                var location = line.Substring(offset + 8);

                AppendLog(new[]
                {
                    fileInfo.Name,
                    ConvertLogTimeToISO8601(line),
                    "location",
                    location,
                    logContext.RecentWorldName
                });

                return true;
            }

            return false;
        }

        private bool ParseLogOnPlayerJoinedOrLeft(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2020.10.31 23:36:58 Log        -  [NetworkManager] OnPlayerJoined pypy
            // 2020.10.31 23:36:58 Log        -  [Player] Initialized PlayerAPI "pypy" is local
            // 2020.10.31 23:36:58 Log        -  [NetworkManager] OnPlayerJoined Rize♡
            // 2020.10.31 23:36:58 Log        -  [Player] Initialized PlayerAPI "Rize♡" is remote

            // 2020.11.01 00:07:01 Log        -  [NetworkManager] OnPlayerLeft Rize♡
            // 2020.11.01 00:07:01 Log        -  [PlayerManager] Removed player 2 / Rize♡
            // 2020.11.01 00:07:02 Log        -  [Player] Unregistering Rize♡

            if (string.Compare(line, offset, "Initialized PlayerAPI \"", 0, 23, StringComparison.Ordinal) == 0)
            {
                var pos = line.LastIndexOf("\" is ");
                if (pos < 0)
                {
                    return false;
                }

                var userDisplayName = line.Substring(offset + 23, pos - (offset + 23));
                var userType = line.Substring(pos + 5);

                AppendLog(new[]
                {
                    fileInfo.Name,
                    ConvertLogTimeToISO8601(line),
                    "player-joined",
                    userDisplayName,
                    userType,
                });

                return true;
            }

            // fallback method
            /*if (string.Compare(line, offset, "OnPlayerJoined ", 0, 15, StringComparison.Ordinal) == 0)
            {
                var userDisplayName = line.Substring(offset + 15);

                AppendLog(new[]
                {
                    fileInfo.Name,
                    ConvertLogTimeToISO8601(line),
                    "player-joined",
                    userDisplayName
                });

                return true;
            }*/

            if (string.Compare(line, offset, "OnPlayerLeft ", 0, 13, StringComparison.Ordinal) == 0)
            {
                var userDisplayName = line.Substring(offset + 13);

                AppendLog(new[]
                {
                    fileInfo.Name,
                    ConvertLogTimeToISO8601(line),
                    "player-left",
                    userDisplayName
                });

                return true;
            }

            return false;
        }

        private bool ParseLogPortalSpawn(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2021.04.06 11:25:45 Log        -  [Network Processing] RPC invoked ConfigurePortal on (Clone [1600004] Portals/PortalInternalDynamic) for Natsumi-sama

            if (string.Compare(line, offset, "RPC invoked ConfigurePortal on (Clone [", 0, 39, StringComparison.Ordinal) != 0)
            {
                return false;
            }

            var pos = line.LastIndexOf("] Portals/PortalInternalDynamic) for ");
            if (pos < 0)
            {
                return false;
            }

            //var portalId = line.Substring(offset + 39, pos - (offset + 39));
            var data = line.Substring(pos + 37);

            AppendLog(new[]
            {
                fileInfo.Name,
                ConvertLogTimeToISO8601(line),
                "portal-spawn",
                data
            });

            return true;
        }

        private bool ParseLogShaderKeywordsLimit(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2021.04.04 12:21:06 Error - Maximum number (256) of shader keywords exceeded, keyword _TOGGLESIMPLEBLUR_ON will be ignored.

            if (logContext.ShaderKeywordsLimitReached == true)
            {
                return false;
            }

            if (string.Compare(line, offset, "Maximum number (256) of shader keywords exceeded", 0, 48, StringComparison.Ordinal) != 0)
            {
                return false;
            }

            AppendLog(new[]
            {
                fileInfo.Name,
                ConvertLogTimeToISO8601(line),
                "event",
                "Shader Keyword Limit has been reached"
            });
            logContext.ShaderKeywordsLimitReached = true;

            return true;
        }

        private bool ParseLogJoinBlocked(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2021.04.07 09:34:37 Error      -  [Behaviour] Master is not sending any events! Moving to a new instance.

            if (string.Compare(line, offset, "Master is not sending any events! Moving to a new instance.", 0, 59, StringComparison.Ordinal) != 0)
            {
                return false;
            }

            AppendLog(new[]
            {
                fileInfo.Name,
                ConvertLogTimeToISO8601(line),
                "event",
                "Joining instance blocked by master"
            });

            return true;
        }

        private bool ParseLogAvatarPedestalChange(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2021.05.07 10:48:19 Log        -  [Network Processing] RPC invoked SwitchAvatar on AvatarPedestal for User

            if (string.Compare(line, offset, "RPC invoked SwitchAvatar on AvatarPedestal for ", 0, 47, StringComparison.Ordinal) != 0)
            {
                return false;
            }

            var data = line.Substring(offset + 47);

            AppendLog(new[]
            {
                fileInfo.Name,
                ConvertLogTimeToISO8601(line),
                "event",
                $"{data} changed avatar pedestal"
            });

            return true;
        }

        private bool ParseLogVideoError(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2021.04.08 06:37:45 Error -  [Video Playback] ERROR: Video unavailable
            // 2021.04.08 06:40:07 Error -  [Video Playback] ERROR: Private video

            if (string.Compare(line, offset, "ERROR: ", 0, 7, StringComparison.Ordinal) != 0)
            {
                return false;
            }

            var data = line.Substring(offset + 7);

            AppendLog(new[]
            {
                fileInfo.Name,
                ConvertLogTimeToISO8601(line),
                "event",
                "VideoError: " + data
            });

            return true;
        }

        private bool ParseLogVideoPlay(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2021.04.20 13:37:69 Log        -  [Video Playback] Attempting to resolve URL 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

            if (string.Compare(line, offset, "Attempting to resolve URL '", 0, 27, StringComparison.Ordinal) != 0)
            {
                return false;
            }

            var pos = line.LastIndexOf("'");
            if (pos < 0)
            {
                return false;
            }
            var data = line.Substring(78);
            data = data.Remove(data.Length - 1);

            if (logContext.LastVideoURL == data)
            {
                return false;
            }
            logContext.LastVideoURL = data;

            AppendLog(new[]
            {
                fileInfo.Name,
                ConvertLogTimeToISO8601(line),
                "video-play",
                data
            });

            return true;
        }

        private bool ParseLogSDK2VideoPlay(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2021.04.23 13:12:25 Log        -  User Natsumi-sama added URL https://www.youtube.com/watch?v=dQw4w9WgXcQ

            if (string.Compare(line, offset, "User ", 0, 5, StringComparison.Ordinal) != 0)
            {
                return false;
            }

            var pos = line.LastIndexOf(" added URL ");
            if (pos < 0)
            {
                return false;
            }

            var displayName = line.Substring(offset + 5, pos - (offset + 5));
            var data = line.Substring(pos + 11);

            if (logContext.LastVideoURL == data)
            {
                return false;
            }
            logContext.LastVideoURL = data;

            AppendLog(new[]
            {
                fileInfo.Name,
                ConvertLogTimeToISO8601(line),
                "video-play",
                data,
                displayName
            });

            return true;
        }

        private bool ParseLogNotification(FileInfo fileInfo, LogContext logContext, string line, int offset)
        {
            // 2021.01.03 05:48:58 Log        -  Received Notification: < Notification from username:pypy, sender user id:usr_4f76a584-9d4b-46f6-8209-8305eb683661 to of type: friendRequest, id: not_3a8f66eb-613c-4351-bee3-9980e6b5652c, created at: 01/14/2021 15:38:40 UTC, details: {{}}, type:friendRequest, m seen:False, message: ""> received at 01/02/2021 16:48:58 UTC

            if (string.Compare(line, offset, "Received Notification: <", 0, 24, StringComparison.Ordinal) != 0)
            {
                return false;
            }

            var pos = line.LastIndexOf("> received at ");
            if (pos < 0)
            {
                return false;
            }

            var data = line.Substring(offset + 24, pos - (offset + 24));

            AppendLog(new[]
            {
                fileInfo.Name,
                ConvertLogTimeToISO8601(line),
                "notification",
                data
            });

            return true;
        }

        public void Reset()
        {
            m_ResetLog = true;
            m_Thread?.Interrupt();
        }

        public string[][] Get()
        {
            if (m_ResetLog == false &&
                m_LogList.Count > 0)
            {
                m_LogListLock.EnterWriteLock();
                try
                {
                    string[][] items;

                    if (m_LogList.Count > 1000)
                    {
                        items = new string[1000][];
                        m_LogList.CopyTo(0, items, 0, 1000);
                        m_LogList.RemoveRange(0, 1000);
                    }
                    else
                    {
                        items = m_LogList.ToArray();
                        m_LogList.Clear();
                    }

                    return items;
                }
                finally
                {
                    m_LogListLock.ExitWriteLock();
                }
            }

            return new string[][] { };
        }
    }
}
