// Copyright(c) 2021 pypy. All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

using CefSharp;
using CefSharp.Handler;
using System.Collections.Generic;
using System.Collections.Specialized;

namespace VRCX
{
    public class VRCXResourceRequestHandler : ResourceRequestHandler
    {
        internal static readonly VRCXResourceRequestHandler Instance = new VRCXResourceRequestHandler();

        internal static readonly HashSet<string> AllowedHeaders = new HashSet<string>()
        {
            "accept",
            "accept-encoding",
            "authorization",
            "content-type",
            "cookie",
            "content-md5", // upload file to s3
            "x-requested-with"
        };

        internal static string UserAgent = "VRCX/0.0.0";

        protected override ICookieAccessFilter GetCookieAccessFilter(
            IWebBrowser chromiumWebBrowser,
            IBrowser browser,
            IFrame frame,
            IRequest request)
        {
            return VRCXCookieAccessFilter.Instance;
        }

        protected override CefReturnValue OnBeforeResourceLoad(
            IWebBrowser chromiumWebBrowser,
            IBrowser browser,
            IFrame frame,
            IRequest request,
            IRequestCallback callback)
        {
            var newHeaders = new NameValueCollection();
            var headers = request.Headers;

            foreach (string name in headers)
            {
                if (AllowedHeaders.Contains(name.ToLower()) == true)
                {
                    newHeaders[name] = headers[name];
                }
            }

            newHeaders["User-Agent"] = UserAgent;
            request.Headers = newHeaders;

            return CefReturnValue.Continue;
        }
    }
}
