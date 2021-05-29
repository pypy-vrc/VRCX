// Copyright(c) 2019 pypy. All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

using CefSharp;
using CefSharp.Enums;
using CefSharp.Handler;

namespace VRCX
{
    public class VRCXDragHandler : DragHandler
    {
        internal static readonly VRCXDragHandler Instance = new VRCXDragHandler();

        protected override bool OnDragEnter(
            IWebBrowser chromiumWebBrowser,
            IBrowser browser,
            IDragData dragData,
            DragOperationsMask mask)
        {
            return true;
        }
    }
}
