// Copyright(c) 2019 pypy. All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

using System.IO;
using System.Windows.Forms;
using CefSharp;
using CefSharp.WinForms;

namespace VRCX
{
    public partial class VRForm : Form
    {
        internal static VRForm Instance;
        private ChromiumWebBrowser _browser1;
        private ChromiumWebBrowser _browser2;

        public VRForm()
        {
            Instance = this;
            InitializeComponent();

            _browser1 = new ChromiumWebBrowser(
                Path.Combine(Program.AppBasePath, "html/vr.html?1")
            )
            {
                DragHandler = new VRCXDragHandler(),
                BrowserSettings =
                {
                    DefaultEncoding = "UTF-8",
                },
                Dock = DockStyle.Fill
            };

            _browser2 = new ChromiumWebBrowser(
                Path.Combine(Program.AppBasePath, "html/vr.html?2")
            )
            {
                DragHandler = new VRCXDragHandler(),
                BrowserSettings =
                {
                    DefaultEncoding = "UTF-8",
                },
                Dock = DockStyle.Fill
            };

            Util.ApplyJavascriptBindings(_browser1.JavascriptObjectRepository);
            Util.ApplyJavascriptBindings(_browser2.JavascriptObjectRepository);

            panel1.Controls.Add(_browser1);
            panel2.Controls.Add(_browser2);
        }

        private void button_refresh_Click(object sender, System.EventArgs e)
        {
            _browser1.ExecuteScriptAsync("location.reload()");
            _browser2.ExecuteScriptAsync("location.reload()");
            VRCXVR.Instance.Refresh();
        }

        private void button_devtools_Click(object sender, System.EventArgs e)
        {
            _browser1.ShowDevTools();
            _browser2.ShowDevTools();
        }
    }
}
