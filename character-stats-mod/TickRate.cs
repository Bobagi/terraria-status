using System.Diagnostics;
using Terraria;
using Terraria.ModLoader;

namespace StatusExport
{
	// Counts world updates per second on the dedicated server. Terraria simulates at
	// 60 per second; when the server can't keep up it runs fewer, and every player
	// feels it as lag regardless of their own ping. Null until a full window passes
	// (the loop sleeps while nobody is online).
	public class TickRate : ModSystem
	{
		private static readonly Stopwatch Window = new Stopwatch();
		private static int _ticks;
		public static double? Current { get; private set; }

		public override void PostUpdateEverything()
		{
			if (!Main.dedServ) return;
			if (!Window.IsRunning) { Window.Start(); _ticks = 0; return; }
			_ticks++;
			// A gap of several seconds means the loop was idle, not slow: start over.
			if (Window.ElapsedMilliseconds > 5000) { Window.Restart(); _ticks = 0; return; }
			if (Window.ElapsedMilliseconds >= 2000) {
				Current = System.Math.Round(_ticks * 1000.0 / Window.ElapsedMilliseconds, 1);
				Window.Restart();
				_ticks = 0;
			}
		}

		public override void OnWorldUnload() { Current = null; Window.Reset(); }
	}
}
