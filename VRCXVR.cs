// Copyright(c) 2019 pypy. All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

using CefSharp;
using SharpDX;
using SharpDX.Direct3D;
using SharpDX.Direct3D11;
using SharpDX.DXGI;
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Valve.VR;
using Device = SharpDX.Direct3D11.Device;

namespace VRCX
{
    public class VRCXVR
    {
        internal static readonly VRCXVR Instance = new VRCXVR();
        private static readonly float[] _rotation = { 0f, 0f, 0f };
        private static readonly float[] _translation = { 0f, 0f, 0f };
        private static readonly float[] _translationLeft = { -7f / 100f, -5f / 100f, 6f / 100f };
        private static readonly float[] _translationRight = { 7f / 100f, -5f / 100f, 6f / 100f };
        private static readonly float[] _rotationLeft = { 90f * (float)(Math.PI / 180f), 90f * (float)(Math.PI / 180f), -90f * (float)(Math.PI / 180f) };
        private static readonly float[] _rotationRight = { -90f * (float)(Math.PI / 180f), -90f * (float)(Math.PI / 180f), -90f * (float)(Math.PI / 180f) };
        private readonly ReaderWriterLockSlim _deviceListLock = new ReaderWriterLockSlim();
        private List<string[]> _deviceList = new List<string[]>();
        private Thread _thread;
        private Device _device;
        private Texture2D _texture1;
        private Texture2D _texture2;
        private OffScreenBrowser _browser1;
        private OffScreenBrowser _browser2;
        private bool _active;

        // NOTE
        // 메모리 릭 때문에 미리 생성해놓고 계속 사용함
        internal void Init()
        {
            _thread = new Thread(ThreadLoop)
            {
                IsBackground = true
            };
            _thread.Start();
        }

        internal void Exit()
        {
            var thread = _thread;
            _thread = null;
            thread.Interrupt();
            thread.Join();
        }

        private void ThreadLoop()
        {
            var active = false;
            var e = new VREvent_t();
            var nextInit = DateTime.MinValue;
            var nextDeviceUpdate = DateTime.MinValue;
            var nextOverlay = DateTime.MinValue;
            var overlayIndex = OpenVR.k_unTrackedDeviceIndexInvalid;
            var overlayVisible1 = false;
            var overlayVisible2 = false;
            var dashboardHandle = 0UL;
            var overlayHandle1 = 0UL;
            var overlayHandle2 = 0UL;

            // REMOVE THIS
            // nextOverlay = DateTime.MaxValue;

            _device = new Device(
                DriverType.Hardware,
                DeviceCreationFlags.SingleThreaded | DeviceCreationFlags.BgraSupport
            );

            _texture1 = new Texture2D(
                _device,
                new Texture2DDescription()
                {
                    Width = 512,
                    Height = 512,
                    MipLevels = 1,
                    ArraySize = 1,
                    Format = Format.B8G8R8A8_UNorm,
                    SampleDescription = new SampleDescription(1, 0),
                    Usage = ResourceUsage.Dynamic,
                    BindFlags = BindFlags.ShaderResource,
                    CpuAccessFlags = CpuAccessFlags.Write
                }
            );

            _texture2 = new Texture2D(
                _device,
                new Texture2DDescription()
                {
                    Width = 512,
                    Height = 512,
                    MipLevels = 1,
                    ArraySize = 1,
                    Format = Format.B8G8R8A8_UNorm,
                    SampleDescription = new SampleDescription(1, 0),
                    Usage = ResourceUsage.Dynamic,
                    BindFlags = BindFlags.ShaderResource,
                    CpuAccessFlags = CpuAccessFlags.Write
                }
            );

            _browser1 = new OffScreenBrowser(
                Path.Combine(Program.AppBasePath, "html/vr.html?1"),
                512,
                512
            );

            _browser2 = new OffScreenBrowser(
                Path.Combine(Program.AppBasePath, "html/vr.html?2"),
                512,
                512
            );

            while (_thread != null)
            {
                if ("true".Equals(SharedVariable.Instance.Get("config:vrcx_overlaywrist")))
                {
                    _browser1.RenderToTexture(_texture1);
                }
                if ("true".Equals(SharedVariable.Instance.Get("config:vrcx_overlaynotifications")))
                {
                    _browser2.RenderToTexture(_texture2);
                }
                try
                {
                    Thread.Sleep(16);
                }
                catch
                {
                    // ThreadInterruptedException
                }

                if (_active)
                {
                    var system = OpenVR.System;
                    if (system == null)
                    {
                        if (DateTime.UtcNow.CompareTo(nextInit) <= 0)
                        {
                            continue;
                        }
                        var _err = EVRInitError.None;
                        system = OpenVR.Init(ref _err, EVRApplicationType.VRApplication_Overlay);
                        nextInit = DateTime.UtcNow.AddSeconds(5);
                        if (system == null)
                        {
                            continue;
                        }
                        active = true;
                    }
                    while (system.PollNextEvent(ref e, (uint)Marshal.SizeOf(e)))
                    {
                        var type = (EVREventType)e.eventType;
                        if (type == EVREventType.VREvent_Quit)
                        {
                            active = false;
                            OpenVR.Shutdown();
                            nextInit = DateTime.UtcNow.AddSeconds(10);
                            system = null;
                            break;
                        }
                    }
                    if (system != null)
                    {
                        if (DateTime.UtcNow.CompareTo(nextDeviceUpdate) >= 0)
                        {
                            overlayIndex = OpenVR.k_unTrackedDeviceIndexInvalid;
                            UpdateDevices(system, ref overlayIndex);
                            if (overlayIndex != OpenVR.k_unTrackedDeviceIndexInvalid)
                            {
                                nextOverlay = DateTime.UtcNow.AddSeconds(10);
                            }
                            nextDeviceUpdate = DateTime.UtcNow.AddSeconds(0.1);
                        }
                        var overlay = OpenVR.Overlay;
                        if (overlay != null)
                        {
                            var dashboardVisible = overlay.IsDashboardVisible();
                            var err = ProcessDashboard(overlay, ref dashboardHandle, dashboardVisible);
                            if (err != EVROverlayError.None &&
                                dashboardHandle != 0)
                            {
                                overlay.DestroyOverlay(dashboardHandle);
                                dashboardHandle = 0;
                            }
                            err = ProcessOverlay1(overlay, ref overlayHandle1, ref overlayVisible1, dashboardVisible, overlayIndex, nextOverlay);
                            if (err != EVROverlayError.None &&
                                overlayHandle1 != 0)
                            {
                                overlay.DestroyOverlay(overlayHandle1);
                                overlayHandle1 = 0;
                            }
                            err = ProcessOverlay2(overlay, ref overlayHandle2, ref overlayVisible2, dashboardVisible);
                            if (err != EVROverlayError.None &&
                                overlayHandle2 != 0)
                            {
                                overlay.DestroyOverlay(overlayHandle2);
                                overlayHandle2 = 0;
                            }
                        }
                    }
                }
                else if (active)
                {
                    active = false;
                    OpenVR.Shutdown();
                    _deviceListLock.EnterWriteLock();
                    try
                    {
                        _deviceList.Clear();
                    }
                    finally
                    {
                        _deviceListLock.ExitWriteLock();
                    }
                }
            }

            _browser2.Dispose();
            _browser1.Dispose();
            _texture2.Dispose();
            _texture1.Dispose();
            _device.Dispose();

        }

        internal void SetActive(bool active)
        {
            _active = active;
        }

        internal void Refresh()
        {
            _browser1.ExecuteScriptAsync("location.reload()");
            _browser2.ExecuteScriptAsync("location.reload()");
        }

        internal string[][] GetDevices()
        {
            _deviceListLock.EnterReadLock();
            try
            {
                return _deviceList.ToArray();
            }
            finally
            {
                _deviceListLock.ExitReadLock();
            }
        }

        internal void UpdateDevices(CVRSystem system, ref uint overlayIndex)
        {
            _deviceListLock.EnterWriteLock();
            try
            {
                _deviceList.Clear();
            }
            finally
            {
                _deviceListLock.ExitWriteLock();
            }
            var sb = new StringBuilder(256);
            var state = new VRControllerState_t();
            for (var i = 0u; i < OpenVR.k_unMaxTrackedDeviceCount; ++i)
            {
                var devClass = system.GetTrackedDeviceClass(i);
                if (devClass == ETrackedDeviceClass.Controller ||
                    devClass == ETrackedDeviceClass.GenericTracker ||
                    devClass == ETrackedDeviceClass.TrackingReference)
                {
                    var err = ETrackedPropertyError.TrackedProp_Success;
                    var batteryPercentage = system.GetFloatTrackedDeviceProperty(i, ETrackedDeviceProperty.Prop_DeviceBatteryPercentage_Float, ref err);
                    if (err != ETrackedPropertyError.TrackedProp_Success)
                    {
                        batteryPercentage = 1f;
                    }
                    sb.Clear();
                    system.GetStringTrackedDeviceProperty(i, ETrackedDeviceProperty.Prop_TrackingSystemName_String, sb, (uint)sb.Capacity, ref err);
                    var isOculus = sb.ToString().IndexOf("oculus", StringComparison.OrdinalIgnoreCase) >= 0;
                    var button = "true".Equals(SharedVariable.Instance.Get("config:vrcx_overlaybutton"));
                    // Oculus : B/Y, Bit 1, Mask 2
                    // Oculus : A/X, Bit 7, Mask 128
                    // Vive : Menu, Bit 1, Mask 2,
                    // Vive : Grip, Bit 2, Mask 4
                    var role = system.GetControllerRoleForTrackedDeviceIndex(i);
                    if (role == ETrackedControllerRole.LeftHand ||
                        role == ETrackedControllerRole.RightHand)
                    {
                        if (system.GetControllerState(i, ref state, (uint)Marshal.SizeOf(state)) &&
                            (state.ulButtonPressed & (button ? 2u : (isOculus ? 128u : 4u))) != 0)
                        {
                            if (role == ETrackedControllerRole.LeftHand)
                            {
                                Array.Copy(_translationLeft, _translation, 3);
                                Array.Copy(_rotationLeft, _rotation, 3);
                            }
                            else
                            {
                                Array.Copy(_translationRight, _translation, 3);
                                Array.Copy(_rotationRight, _rotation, 3);
                            }
                            overlayIndex = i;
                        }
                    }
                    var type = string.Empty;
                    if (devClass == ETrackedDeviceClass.Controller)
                    {
                        if (role == ETrackedControllerRole.LeftHand)
                        {
                            type = "leftController";
                        }
                        else if (role == ETrackedControllerRole.RightHand)
                        {
                            type = "rightController";
                        }
                        else
                        {
                            type = "controller";
                        }
                    }
                    else if (devClass == ETrackedDeviceClass.GenericTracker)
                    {
                        type = "tracker";
                    }
                    else if (devClass == ETrackedDeviceClass.TrackingReference)
                    {
                        type = "base";
                    }
                    var item = new[]
                    {
                        type,
                        system.IsTrackedDeviceConnected(i)
                            ? "connected"
                            : "disconnected",
                        (batteryPercentage * 100).ToString()
                    };
                    _deviceListLock.EnterWriteLock();
                    try
                    {
                        _deviceList.Add(item);
                    }
                    finally
                    {
                        _deviceListLock.ExitWriteLock();
                    }
                }
            }
        }

        internal EVROverlayError ProcessDashboard(CVROverlay overlay, ref ulong dashboardHandle, bool dashboardVisible)
        {
            var err = EVROverlayError.None;

            if (dashboardHandle == 0)
            {
                err = overlay.FindOverlay("VRCX", ref dashboardHandle);
                if (err != EVROverlayError.None)
                {
                    if (err != EVROverlayError.UnknownOverlay)
                    {
                        return err;
                    }
                    ulong handle = 0;
                    err = overlay.CreateDashboardOverlay("VRCX", "VRCX", ref dashboardHandle, ref handle);
                    if (err != EVROverlayError.None)
                    {
                        return err;
                    }
                    err = overlay.SetOverlayWidthInMeters(dashboardHandle, 1.5f);
                    if (err != EVROverlayError.None)
                    {
                        return err;
                    }
                    err = overlay.SetOverlayInputMethod(dashboardHandle, VROverlayInputMethod.Mouse);
                    if (err != EVROverlayError.None)
                    {
                        return err;
                    }
                }
            }

            var e = new VREvent_t();

            while (overlay.PollNextOverlayEvent(dashboardHandle, ref e, (uint)Marshal.SizeOf(e)))
            {
                var type = (EVREventType)e.eventType;
                if (type == EVREventType.VREvent_MouseMove)
                {
                    var m = e.data.mouse;
                    var s = _browser1.Size;
                    _browser1.GetBrowserHost().SendMouseMoveEvent((int)(m.x * s.Width), s.Height - (int)(m.y * s.Height), false, CefEventFlags.None);
                }
                else if (type == EVREventType.VREvent_MouseButtonDown)
                {
                    var m = e.data.mouse;
                    var s = _browser1.Size;
                    _browser1.GetBrowserHost().SendMouseClickEvent((int)(m.x * s.Width), s.Height - (int)(m.y * s.Height), MouseButtonType.Left, false, 1, CefEventFlags.LeftMouseButton);
                }
                else if (type == EVREventType.VREvent_MouseButtonUp)
                {
                    var m = e.data.mouse;
                    var s = _browser1.Size;
                    _browser1.GetBrowserHost().SendMouseClickEvent((int)(m.x * s.Width), s.Height - (int)(m.y * s.Height), MouseButtonType.Left, true, 1, CefEventFlags.None);
                }
            }

            if (dashboardVisible)
            {
                var texture = new Texture_t
                {
                    handle = _texture1.NativePointer
                };
                err = overlay.SetOverlayTexture(dashboardHandle, ref texture);
                if (err != EVROverlayError.None)
                {
                    return err;
                }
            }

            return err;
        }

        internal EVROverlayError ProcessOverlay1(CVROverlay overlay, ref ulong overlayHandle, ref bool overlayVisible, bool dashboardVisible, uint overlayIndex, DateTime nextOverlay)
        {
            var err = EVROverlayError.None;

            if (overlayHandle == 0)
            {
                err = overlay.FindOverlay("VRCX1", ref overlayHandle);
                if (err != EVROverlayError.None)
                {
                    if (err != EVROverlayError.UnknownOverlay)
                    {
                        return err;
                    }
                    overlayVisible = false;
                    err = overlay.CreateOverlay("VRCX1", "VRCX1", ref overlayHandle);
                    if (err != EVROverlayError.None)
                    {
                        return err;
                    }
                    err = overlay.SetOverlayAlpha(overlayHandle, 0.9f);
                    if (err != EVROverlayError.None)
                    {
                        return err;
                    }
                    err = overlay.SetOverlayWidthInMeters(overlayHandle, 1f);
                    if (err != EVROverlayError.None)
                    {
                        return err;
                    }
                    err = overlay.SetOverlayInputMethod(overlayHandle, VROverlayInputMethod.None);
                    if (err != EVROverlayError.None)
                    {
                        return err;
                    }
                }
            }

            if (overlayIndex != OpenVR.k_unTrackedDeviceIndexInvalid)
            {
                // http://www.opengl-tutorial.org/beginners-tutorials/tutorial-3-matrices
                // Scaling-Rotation-Translation
                var m = Matrix.Scaling(0.25f);
                m *= Matrix.RotationX(_rotation[0]);
                m *= Matrix.RotationY(_rotation[1]);
                m *= Matrix.RotationZ(_rotation[2]);
                m *= Matrix.Translation(_translation[0], _translation[1], _translation[2]);
                var hm34 = new HmdMatrix34_t
                {
                    m0 = m.M11,
                    m1 = m.M21,
                    m2 = m.M31,
                    m3 = m.M41,
                    m4 = m.M12,
                    m5 = m.M22,
                    m6 = m.M32,
                    m7 = m.M42,
                    m8 = m.M13,
                    m9 = m.M23,
                    m10 = m.M33,
                    m11 = m.M43,
                };
                err = overlay.SetOverlayTransformTrackedDeviceRelative(overlayHandle, overlayIndex, ref hm34);
                if (err != EVROverlayError.None)
                {
                    return err;
                }
            }

            if (!dashboardVisible &&
                DateTime.UtcNow.CompareTo(nextOverlay) <= 0)
            {
                var texture = new Texture_t
                {
                    handle = _texture1.NativePointer
                };
                err = overlay.SetOverlayTexture(overlayHandle, ref texture);
                if (err != EVROverlayError.None)
                {
                    return err;
                }
                if (!overlayVisible)
                {
                    err = overlay.ShowOverlay(overlayHandle);
                    if (err != EVROverlayError.None)
                    {
                        return err;
                    }
                    overlayVisible = true;
                }
            }
            else if (overlayVisible)
            {
                err = overlay.HideOverlay(overlayHandle);
                if (err != EVROverlayError.None)
                {
                    return err;
                }
                overlayVisible = false;
            }

            return err;
        }

        internal EVROverlayError ProcessOverlay2(CVROverlay overlay, ref ulong overlayHandle, ref bool overlayVisible, bool dashboardVisible)
        {
            var err = EVROverlayError.None;

            if (overlayHandle == 0)
            {
                err = overlay.FindOverlay("VRCX2", ref overlayHandle);
                if (err != EVROverlayError.None)
                {
                    if (err != EVROverlayError.UnknownOverlay)
                    {
                        return err;
                    }
                    overlayVisible = false;
                    err = overlay.CreateOverlay("VRCX2", "VRCX2", ref overlayHandle);
                    if (err != EVROverlayError.None)
                    {
                        return err;
                    }
                    err = overlay.SetOverlayAlpha(overlayHandle, 0.9f);
                    if (err != EVROverlayError.None)
                    {
                        return err;
                    }
                    err = overlay.SetOverlayWidthInMeters(overlayHandle, 1f);
                    if (err != EVROverlayError.None)
                    {
                        return err;
                    }
                    err = overlay.SetOverlayInputMethod(overlayHandle, VROverlayInputMethod.None);
                    if (err != EVROverlayError.None)
                    {
                        return err;
                    }
                    var m = Matrix.Scaling(1f);
                    m *= Matrix.Translation(0, -0.3f, -1.5f);
                    var hm34 = new HmdMatrix34_t
                    {
                        m0 = m.M11,
                        m1 = m.M21,
                        m2 = m.M31,
                        m3 = m.M41,
                        m4 = m.M12,
                        m5 = m.M22,
                        m6 = m.M32,
                        m7 = m.M42,
                        m8 = m.M13,
                        m9 = m.M23,
                        m10 = m.M33,
                        m11 = m.M43,
                    };
                    err = overlay.SetOverlayTransformTrackedDeviceRelative(overlayHandle, OpenVR.k_unTrackedDeviceIndex_Hmd, ref hm34);
                    if (err != EVROverlayError.None)
                    {
                        return err;
                    }
                }
            }

            if (!dashboardVisible)
            {
                var texture = new Texture_t
                {
                    handle = _texture2.NativePointer
                };
                err = overlay.SetOverlayTexture(overlayHandle, ref texture);
                if (err != EVROverlayError.None)
                {
                    return err;
                }
                if (!overlayVisible)
                {
                    err = overlay.ShowOverlay(overlayHandle);
                    if (err != EVROverlayError.None)
                    {
                        return err;
                    }
                    overlayVisible = true;
                }
            }
            else if (overlayVisible)
            {
                err = overlay.HideOverlay(overlayHandle);
                if (err != EVROverlayError.None)
                {
                    return err;
                }
                overlayVisible = false;
            }

            return err;
        }
    }
}
