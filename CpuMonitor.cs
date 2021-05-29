// Copyright(c) 2019 pypy. All rights reserved.
//
// This work is licensed under the terms of the MIT license.
// For a copy, see <https://opensource.org/licenses/MIT>.

using System.Diagnostics;
using System.Threading;

namespace VRCX
{
    public class CpuMonitor
    {
        internal static readonly CpuMonitor Instance = new CpuMonitor();
        internal float CpuUsage;
        private PerformanceCounter _performanceCounter;
        private Timer _timer;

        internal void Init()
        {
            try
            {
                _performanceCounter = new PerformanceCounter(
                    "Processor Information",
                    "% Processor Utility",
                    "_Total",
                    true
                );
            }
            catch
            {
            }

            // fallback
            if (_performanceCounter == null)
            {
                try
                {
                    _performanceCounter = new PerformanceCounter(
                        "Processor",
                        "% Processor Time",
                        "_Total",
                        true
                    );
                }
                catch
                {
                }
            }

            _timer = new Timer(TimerCallback, null, -1, -1);
            _timer.Change(1000, 1000);
        }

        internal void Exit()
        {
            lock (this)
            {
                _timer.Change(-1, -1);
                _performanceCounter?.Dispose();
            }
        }

        private void TimerCallback(object state)
        {
            lock (this)
            {
                try
                {
                    if (_performanceCounter != null)
                    {
                        CpuUsage = _performanceCounter.NextValue();
                    }
                }
                catch
                {
                }
            }
        }
    }
}
