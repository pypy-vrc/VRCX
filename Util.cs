using CefSharp;

namespace VRCX
{
    public static class Util
    {
        internal static void ApplyJavascriptBindings(
            IJavascriptObjectRepository repository)
        {
            repository.NameConverter = null;
            repository.Register("AppApi", AppApi.Instance, true);
            repository.Register("SharedVariable", SharedVariable.Instance, false);
            repository.Register("VRCXStorage", VRCXStorage.Instance, false);
            repository.Register("SQLite", SQLite.Instance, true);
            repository.Register("LogWatcher", LogWatcher.Instance, true);
            repository.Register("Discord", Discord.Instance, true);
            repository.Register("AssetBundleCacher", AssetBundleCacher.Instance, true);
        }
    }
}
