// Copyright(c) 2019 pypy. All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

using CefSharp;
using CefSharp.OffScreen;
using System;
using System.IO;
using System.Net;
using System.Windows.Forms;

namespace VRCX
{
    public class Program
    {
        internal static readonly string AppBasePath = AppDomain.CurrentDomain.BaseDirectory;
        internal static readonly string AppDataPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "VRCX");

        [STAThread]
        private static void Main()
        {
            try
            {
                Run();
            }
            catch (Exception e)
            {
                MessageBox.Show(
                    e.ToString(),
                    "PLEASE REPORT TO PYPY",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                Environment.Exit(0);
            }
        }

        private static void Run()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            ServicePointManager.DefaultConnectionLimit = 10;
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;

            Cef.EnableHighDPISupport();

            var cefSettings = new CefSettings
            {
                LogSeverity = LogSeverity.Disable,
                WindowlessRenderingEnabled = true,
                PersistSessionCookies = true,
                PersistUserPreferences = true,
                IgnoreCertificateErrors = true,
                CachePath = AppDataPath,
                UserDataPath = AppDataPath,
            };

            cefSettings.CefCommandLineArgs.Add("ignore-certificate-errors");
            cefSettings.CefCommandLineArgs.Add("disable-gpu");
            cefSettings.CefCommandLineArgs.Add("disable-web-security");
            cefSettings.CefCommandLineArgs.Add("disable-plugins-discovery");
            cefSettings.CefCommandLineArgs.Add("disable-software-rasterizer");
            cefSettings.CefCommandLineArgs.Add("disable-extensions");
            cefSettings.CefCommandLineArgs.Add("disable-spell-checking");
            cefSettings.CefCommandLineArgs.Add("autoplay-policy", "no-user-gesture-required");

            cefSettings.SetOffScreenRenderingBestPerformanceArgs();
            // cefSettings.CefCommandLineArgs.Add("disable-direct-composition");
            // cefSettings.CefCommandLineArgs.Add("enable-begin-frame-scheduling");

            if (Cef.Initialize(cefSettings) == true)
            {
                SQLite.Instance.Init();
                VRCXStorage.Load();
                CpuMonitor.Instance.Init();
                Discord.Instance.Init();
                LogWatcher.Instance.Init();

                VRCXVR.Instance.Init();
                Application.Run(new MainForm());
                VRCXVR.Instance.Exit();

                LogWatcher.Instance.Exit();

                Discord.Instance.Exit();
                CpuMonitor.Instance.Exit();
                VRCXStorage.Save();
                SQLite.Instance.Exit();
            }

            Cef.Shutdown();
        }
    }
}
