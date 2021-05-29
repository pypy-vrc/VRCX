// Copyright(c) 2019 pypy. All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

using System;
using System.Runtime.InteropServices;
using System.Text;

namespace VRCX
{
    public class VRChatRPC
    {
        internal static readonly VRChatRPC Instance;

        [DllImport("VRChatRPC", CallingConvention = CallingConvention.Cdecl)]
        private static extern bool VRChatRPC_000();

        [DllImport("VRChatRPC", CallingConvention = CallingConvention.Cdecl)]
        private static extern int VRChatRPC_001([Out] byte[] data, int size);

        [DllImport("VRChatRPC", CallingConvention = CallingConvention.Cdecl)]
        private static extern IntPtr VRChatRPC_002();

        static VRChatRPC()
        {
            Instance = new VRChatRPC();
        }

        internal bool Update()
        {
            return VRChatRPC_000();
        }

        internal string GetAuthSessionTicket()
        {
            var a = new byte[1024];
            var n = VRChatRPC_001(a, 1024);
            return BitConverter.ToString(a, 0, n).Replace("-", string.Empty);
        }

        internal string GetPersonaName()
        {
            var ptr = VRChatRPC_002();
            if (ptr != IntPtr.Zero)
            {
                int n = 0;
                while (Marshal.ReadByte(ptr, n) != 0)
                {
                    ++n;
                }
                if (n > 0)
                {
                    var a = new byte[n];
                    Marshal.Copy(ptr, a, 0, a.Length);
                    return Encoding.UTF8.GetString(a);
                }
            }
            return string.Empty;
        }
    }
}
