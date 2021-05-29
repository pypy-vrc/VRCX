// Copyright(c) 2019-2020 pypy. All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

using Microsoft.Win32;
using System;
using System.Diagnostics;
using System.Text.RegularExpressions;
using System.IO;
using System.Security.Cryptography;
using System.Net;
using System.Text;
using System.ComponentModel;
using System.Linq;

namespace VRCX
{
    public class AssetBundleCacher
    {
        public static readonly AssetBundleCacher Instance;

        static AssetBundleCacher()
        {
            Instance = new AssetBundleCacher();
        }

        public static string AssetBundleCacherTemp;
        public static string VRChatCacheLocation;
        public static string CacheDestinationLocation;
        public static string AssetBundleCacherLocation;
        public static string AssetBundleCacherArgs;
        public static string DownloadTempLocation;
        public static int DownloadProgress;
        public static bool DownloadCanceled;
        public static string AssetId;
        public static string AssetVersion;
        public static int AssetSize;
        public static string AssetMd5;
        public static WebClient client;
        public static Process process;

        public string GetAssetId(string id)
        {
            byte[] hash = SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes(id));
            StringBuilder idHex = new StringBuilder(hash.Length * 2);
            foreach (byte b in hash)
            {
                idHex.AppendFormat("{0:x2}", b);
            }
            return idHex.ToString().ToUpper().Substring(0, 16);
        }

        public string GetAssetVersion(int version)
        {
            byte[] bytes = BitConverter.GetBytes(version);
            string versionHex = String.Empty;
            foreach (byte b in bytes)
            {
                versionHex += b.ToString("X2");
            }
            return versionHex.PadLeft(32, '0');
        }

        public string GetVRChatCacheLocation(string cacheDir)
        {
            var cachePath = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + @"Low\VRChat\VRChat\Cache-WindowsPlayer";
            if (!string.IsNullOrEmpty(cacheDir) && Directory.Exists(cacheDir))
                cachePath = Path.Combine(cacheDir, @"Cache-WindowsPlayer");
            return cachePath;
        }

        public string GetAssetBundleCacherLocation(string cacheDir)
        {
            var cachePath = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + @"Low\VRChat\VRChat\AssetBundleCacher";
            if (!string.IsNullOrEmpty(cacheDir) && Directory.Exists(cacheDir))
                cachePath = Path.Combine(cacheDir, @"AssetBundleCacher");
            return cachePath;
        }

        public string GetVRChatCacheFullLocation(string id, int version, string cacheDir)
        {
            var cachePath = GetVRChatCacheLocation(cacheDir);
            var idHash = GetAssetId(id);
            var versionLocation = GetAssetVersion(version);
            return Path.Combine(cachePath, idHash, versionLocation);
        }

        public long CheckVRChatCache(string id, int version, string cacheDir)
        {
            var FullLocation = GetVRChatCacheFullLocation(id, version, cacheDir);
            var FileLocation = Path.Combine(FullLocation, "__data");
            if (File.Exists(FileLocation))
            {
                FileInfo data = new FileInfo(FileLocation);
                return data.Length;
            }
            return -1;
        }

        public void DownloadCacheFile(string cacheDir, string url, string id, int version, int sizeInBytes, string md5, string AppVersion)
        {
            if (!File.Exists(Path.Combine(Program.AppBasePath, "AssetBundleCacher\\AssetBundleCacher.exe")))
            {
                DownloadProgress = -10;
                return;
            }
            if (!File.Exists(Path.Combine(Program.AppBasePath, "AssetBundleCacher\\UnityPlayer.dll")))
            {
                using (var key = Registry.ClassesRoot.OpenSubKey(@"VRChat\shell\open\command"))
                {
                    // "C:\Program Files (x86)\Steam\steamapps\common\VRChat\launch.exe" "%1" %*
                    var match = Regex.Match(key.GetValue(string.Empty) as string, "(?!\")(.+?\\\\VRChat.*)(!?\\\\launch.exe\")");
                    if (match.Success == true)
                    {
                        var fileLocation = Path.Combine(match.Groups[1].Value, "UnityPlayer.dll");
                        if (File.Exists(fileLocation))
                        {
                            File.Copy(fileLocation, Path.Combine(Program.AppBasePath, "AssetBundleCacher\\UnityPlayer.dll"));
                        }
                        else
                        {
                            DownloadProgress = -11;
                            return;
                        }
                    }
                    else
                    {
                        DownloadProgress = -11;
                        return;
                    }
                }
            }
            DownloadProgress = 0;
            VRChatCacheLocation = GetVRChatCacheLocation(cacheDir);
            AssetBundleCacherLocation = GetAssetBundleCacherLocation(cacheDir);
            CacheDestinationLocation = GetVRChatCacheFullLocation(id, version, cacheDir);
            if (File.Exists(Path.Combine(CacheDestinationLocation, "__data")))
            {
                DownloadProgress = -12;
                return;
            }
            AssetSize = sizeInBytes;
            AssetMd5 = md5;
            AssetId = GetAssetId(id);
            AssetVersion = GetAssetVersion(version);
            DownloadTempLocation = Path.Combine(AssetBundleCacherLocation, AssetId);
            AssetBundleCacherTemp = Path.Combine(AssetBundleCacherLocation, "Cache");
            Directory.CreateDirectory(AssetBundleCacherTemp);
            AssetBundleCacherArgs = $@" -url ""file:\\{DownloadTempLocation}"" -id ""{id}"" -ver {version} -batchmode -path ""{AssetBundleCacherTemp}""";
            DownloadCanceled = false;
            client = new WebClient();
            client.Headers.Add("user-agent", AppVersion);
            client.DownloadProgressChanged += new DownloadProgressChangedEventHandler(DownloadProgressCallback);
            client.DownloadFileCompleted += new AsyncCompletedEventHandler(DownloadCompletedCallback);
            client.DownloadFileAsync(new System.Uri(url), DownloadTempLocation);
        }

        public void CancelDownload()
        {
            DownloadCanceled = true;
            if (client != null)
            {
                client.CancelAsync();
            }
            if (process != null && !process.HasExited)
            {
                process.Kill();
                if (File.Exists(DownloadTempLocation))
                    File.Delete(DownloadTempLocation);
                if (Directory.Exists(Path.Combine(AssetBundleCacherTemp, AssetId)))
                    Directory.Delete(Path.Combine(AssetBundleCacherTemp, AssetId), true);
            }
            DownloadProgress = -4;
        }

        public int CheckDownloadProgress()
        {
            return DownloadProgress;
        }

        private static void DownloadProgressCallback(object sender, DownloadProgressChangedEventArgs e)
        {
            DownloadProgress = e.ProgressPercentage;
        }

        private static void DownloadCompletedCallback(object sender, AsyncCompletedEventArgs e)
        {
            if (DownloadCanceled)
            {
                if (File.Exists(DownloadTempLocation))
                    File.Delete(DownloadTempLocation);
                return;
            }
            DownloadProgress = -1;
            if (!File.Exists(DownloadTempLocation))
            {
                DownloadProgress = -15;
                return;
            }
            FileInfo data = new FileInfo(DownloadTempLocation);
            if (data.Length != AssetSize)
            {
                DownloadProgress = -15;
                return;
            }
            using (var stream = File.OpenRead(DownloadTempLocation))
            {
                byte[] md5AsBytes = MD5.Create().ComputeHash(stream);
                var md5 = System.Convert.ToBase64String(md5AsBytes);
                if (md5 != AssetMd5)
                {
                    DownloadProgress = -15;
                    return;
                }
            }
            process = new Process();
            process.StartInfo.FileName = Path.Combine(Program.AppBasePath, "AssetBundleCacher\\AssetBundleCacher.exe");
            process.StartInfo.Arguments = AssetBundleCacherArgs;
            process.Start();
            process.WaitForExit((int) TimeSpan.FromMinutes(2).TotalMilliseconds); //2mins
            if (process.ExitCode != 0)
            {
                DownloadProgress = -13;
                return;
            }

            if (DownloadCanceled)
            {
                if (File.Exists(DownloadTempLocation))
                    File.Delete(DownloadTempLocation);
                return;
            }
            try
            {
                if (File.Exists(Path.Combine(CacheDestinationLocation, "__data")))
                {
                    if (File.Exists(DownloadTempLocation))
                        File.Delete(DownloadTempLocation);
                    if (Directory.Exists(Path.Combine(AssetBundleCacherTemp, AssetId)))
                        Directory.Delete(Path.Combine(AssetBundleCacherTemp, AssetId), true);
                    DownloadProgress = -12;
                    return;
                }
                if (Directory.Exists(CacheDestinationLocation))
                    Directory.Delete(CacheDestinationLocation, true);
                var CacheSource = Path.Combine(AssetBundleCacherTemp, AssetId, AssetVersion);
                if (!File.Exists(Path.Combine(CacheSource, "__data")))
                {
                    DownloadProgress = -13;
                    return;
                }
                if (!Directory.Exists(Path.Combine(VRChatCacheLocation, AssetId)))
                    Directory.CreateDirectory(Path.Combine(VRChatCacheLocation, AssetId));
                Directory.Move(CacheSource, CacheDestinationLocation);
                Directory.Delete(Path.Combine(AssetBundleCacherTemp, AssetId), true);
                File.Delete(DownloadTempLocation);
            }
            catch
            {
                DownloadProgress = -14;
                return;
            }
            DownloadProgress = -3;
        }

        public void DeleteCache(string cacheDir, string id, int version)
        {
            var FullLocation = GetVRChatCacheFullLocation(id, version, cacheDir);
            if (Directory.Exists(FullLocation))
                Directory.Delete(FullLocation, true);
        }

        public void DeleteAllCache(string cacheDir)
        {
            var cachePath = GetVRChatCacheLocation(cacheDir);
            if (Directory.Exists(cachePath))
            {
                Directory.Delete(cachePath, true);
                Directory.CreateDirectory(cachePath);
            }
        }

        public void SweepCache(string cacheDir)
        {
            var cachePath = GetVRChatCacheLocation(cacheDir);
            if (!Directory.Exists(cachePath))
                return;
            var directories = new DirectoryInfo(cachePath);
            DirectoryInfo[] cacheDirectories = directories.GetDirectories();
            foreach (DirectoryInfo cacheDirectory in cacheDirectories)
            {
                var VersionDirectories = cacheDirectory.GetDirectories().OrderBy(d => Convert.ToInt32(d.Name, 16));
                int i = 0;
                foreach (DirectoryInfo VersionDirectory in VersionDirectories)
                {
                    i++;
                    if (VersionDirectory.GetDirectories().Length + VersionDirectory.GetFiles().Length == 0)
                    {
                        VersionDirectory.Delete();
                    }
                    else if (i < VersionDirectories.Count())
                    {
                        if (!File.Exists(Path.Combine(VersionDirectory.FullName, "__lock")))
                            VersionDirectory.Delete(true);
                    }
                }
                if (cacheDirectory.GetDirectories().Length + cacheDirectory.GetFiles().Length == 0)
                    cacheDirectory.Delete();
            }
        }

        public long GetCacheSize(string cacheDir)
        {
            var cachePath = GetVRChatCacheLocation(cacheDir);
            if (Directory.Exists(cachePath))
            {
                return DirSize(new DirectoryInfo(cachePath));
            }
            else
            {
                return 0;
            }
        }

        public long DirSize(DirectoryInfo d)
        {
            long size = 0;
            FileInfo[] files = d.GetFiles();
            foreach (FileInfo file in files)
            {
                size += file.Length;
            }
            DirectoryInfo[] directories = d.GetDirectories();
            foreach (DirectoryInfo directory in directories)
            {
                size += DirSize(directory);
            }
            return size;
        }
    }
}
