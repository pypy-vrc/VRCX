// Copyright(c) 2021 pypy. All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

using CefSharp;
using CefSharp.Handler;

namespace VRCX
{
    public class VRCXRequestHandler : RequestHandler
    {
        internal static readonly VRCXRequestHandler Instance = new VRCXRequestHandler();

        protected override IResourceRequestHandler GetResourceRequestHandler(
            IWebBrowser chromiumWebBrowser,
            IBrowser browser,
            IFrame frame,
            IRequest request,
            bool isNavigation,
            bool isDownload,
            string requestInitiator,
            ref bool disableDefaultHandling)
        {
            var url = request.Url.ToLower();

            if (url.StartsWith("https://api.vrchat.cloud/") == true)
            {
                return VRCXResourceRequestHandler.Instance;
            }

            return null;
        }
    }
}
