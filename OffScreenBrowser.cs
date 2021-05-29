// Copyright(c) 2019 pypy. All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

using CefSharp;
using CefSharp.Enums;
using CefSharp.OffScreen;
using CefSharp.Structs;
using SharpDX.Direct3D11;
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace VRCX
{
    public class OffScreenBrowser : ChromiumWebBrowser, IRenderHandler
    {
        private ReaderWriterLockSlim _paintBufferLock;
        private GCHandle _paintBuffer;
        private int _width;
        private int _height;

        public OffScreenBrowser(string address, int width, int height)
            : base(
                address,
                new BrowserSettings()
                {
                    DefaultEncoding = "UTF-8"
                }
            )
        {
            _paintBufferLock = new ReaderWriterLockSlim();

            Size = new System.Drawing.Size(width, height);
            RenderHandler = this;

            Util.ApplyJavascriptBindings(JavascriptObjectRepository);
        }

        internal new void Dispose()
        {
            RenderHandler = null;
            base.Dispose();

            _paintBufferLock.EnterWriteLock();
            try
            {
                if (_paintBuffer.IsAllocated == true)
                {
                    _paintBuffer.Free();
                }
            }
            finally
            {
                _paintBufferLock.ExitWriteLock();
            }

            _paintBufferLock.Dispose();
        }

        internal void RenderToTexture(Texture2D texture)
        {
            _paintBufferLock.EnterReadLock();
            try
            {
                if (_width > 0 &&
                    _height > 0)
                {
                    var context = texture.Device.ImmediateContext;
                    var dataBox = context.MapSubresource(
                        texture,
                        0,
                        MapMode.WriteDiscard,
                        MapFlags.None
                    );
                    if (dataBox.IsEmpty == false)
                    {
                        var sourcePtr = _paintBuffer.AddrOfPinnedObject();
                        var destinationPtr = dataBox.DataPointer;
                        var pitch = _width * 4;
                        var rowPitch = dataBox.RowPitch;
                        if (pitch == rowPitch)
                        {
                            WinApi.CopyMemory(
                                destinationPtr,
                                sourcePtr,
                                (uint)(_width * _height * 4)
                            );
                        }
                        else
                        {
                            for (var y = _height; y > 0; --y)
                            {
                                WinApi.CopyMemory(
                                    destinationPtr,
                                    sourcePtr,
                                    (uint)pitch
                                );
                                sourcePtr += pitch;
                                destinationPtr += rowPitch;
                            }
                        }
                    }
                    context.UnmapSubresource(texture, 0);
                }
            }
            finally
            {
                _paintBufferLock.ExitReadLock();
            }
        }

        ScreenInfo? IRenderHandler.GetScreenInfo()
        {
            return null;
        }

        bool IRenderHandler.GetScreenPoint(int viewX, int viewY, out int screenX, out int screenY)
        {
            screenX = viewX;
            screenY = viewY;
            return false;
        }

        Rect IRenderHandler.GetViewRect()
        {
            return new Rect(0, 0, Size.Width, Size.Height);
        }

        void IRenderHandler.OnAcceleratedPaint(PaintElementType type, Rect dirtyRect, IntPtr sharedHandle)
        {
            // NOT USED
        }

        void IRenderHandler.OnCursorChange(IntPtr cursor, CursorType type, CursorInfo customCursorInfo)
        {
        }

        void IRenderHandler.OnImeCompositionRangeChanged(Range selectedRange, Rect[] characterBounds)
        {
        }

        void IRenderHandler.OnPaint(PaintElementType type, Rect dirtyRect, IntPtr buffer, int width, int height)
        {
            if (type == PaintElementType.View)
            {
                _paintBufferLock.EnterWriteLock();
                try
                {
                    if (_width != width ||
                        _height != height)
                    {
                        _width = width;
                        _height = height;
                        if (_paintBuffer.IsAllocated == true)
                        {
                            _paintBuffer.Free();
                        }
                        _paintBuffer = GCHandle.Alloc(
                            new byte[_width * _height * 4],
                            GCHandleType.Pinned
                        );
                    }

                    WinApi.CopyMemory(
                        _paintBuffer.AddrOfPinnedObject(),
                        buffer,
                        (uint)(width * height * 4)
                    );
                }
                finally
                {
                    _paintBufferLock.ExitWriteLock();
                }
            }
        }

        void IRenderHandler.OnPopupShow(bool show)
        {
        }

        void IRenderHandler.OnPopupSize(Rect rect)
        {
        }

        void IRenderHandler.OnVirtualKeyboardRequested(IBrowser browser, TextInputMode inputMode)
        {
        }

        bool IRenderHandler.StartDragging(IDragData dragData, DragOperationsMask mask, int x, int y)
        {
            return false;
        }

        void IRenderHandler.UpdateDragCursor(DragOperationsMask operation)
        {
        }
    }
}
