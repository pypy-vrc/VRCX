// Copyright(c) 2021 pypy. All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

using CefSharp;
using CefSharp.Enums;
using CefSharp.Handler;

namespace VRCX
{
    public class VRCXCookieAccessFilter : CookieAccessFilter
    {
        internal static readonly VRCXCookieAccessFilter Instance = new VRCXCookieAccessFilter();

        protected override bool CanSaveCookie(
            IWebBrowser chromiumWebBrowser,
            IBrowser browser,
            IFrame frame,
            IRequest request,
            IResponse response,
            Cookie cookie)
        {
            chromiumWebBrowser.GetCookieManager()
                .SetCookie("https://api.vrchat.cloud/", new Cookie
                {
                    Name = cookie.Name,
                    Value = cookie.Value,
                    Secure = true,
                    HttpOnly = true,
                    SameSite = CookieSameSite.NoRestriction
                });

            return false;
        }

        protected override bool CanSendCookie(
            IWebBrowser chromiumWebBrowser,
            IBrowser browser,
            IFrame frame,
            IRequest request,
            Cookie cookie)
        {
            return true;
        }
    }
}
