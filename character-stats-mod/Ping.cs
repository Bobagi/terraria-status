using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using Terraria;
using Terraria.ID;
using Terraria.ModLoader;
using Terraria.Net;
using Terraria.Net.Sockets;

namespace StatusExport
{
	// Round-trip latency of each player, measured end to end without anything on the client.
	//
	// Every few seconds the server sends the vanilla ReleaseItemOwnership message (39) for a
	// free item slot; a vanilla client answers it at once with ItemOwner (22) for the same
	// slot, and the time between the two is the player's ping. The idea comes from the
	// TShock PingPlugin (github.com/simon311/PingPlugin). The probe uses an INACTIVE slot,
	// so no real item changes hands, and the reply is consumed here so vanilla never sees it.
	// The reply is handled on the server's update loop, so the value includes up to one tick
	// (~17 ms): that is the latency the player actually feels in game.
	//
	// Why not the kernel's TCP round trip (what this used to read): behind a tunnel such as
	// playit.gg the server's TCP peer is the local tunnel agent, so the kernel reports ~1 ms
	// for everyone. It is still used as a fallback, but only for a direct (public) connection.
	public static class PingProbe
	{
		// Returns (rtt, jitter) in milliseconds, or null when there is no measurement yet.
		public static (double rtt, double jitter)? Read(int playerIndex)
		{
			if (playerIndex < 0 || playerIndex >= Main.maxPlayers) return null;
			var echo = PingEcho.Get(playerIndex);
			if (echo != null) return echo;
			return Addresses.IsProxied(playerIndex) ? null : KernelRtt.Read(playerIndex);
		}

		public static string Describe(int playerIndex)
		{
			var ping = Read(playerIndex);
			if (ping == null) return "medindo, tente de novo em alguns segundos";
			var (rtt, jitter) = ping.Value;
			string verdict = rtt < 80 ? "bom" : rtt < 150 ? "ok" : rtt < 250 ? "alto" : "muito alto";
			return $"{rtt:0} ms (variacao {jitter:0} ms, {verdict})";
		}
	}

	public class PingEcho : ModSystem
	{
		private const int ProbeEveryTicks = 3 * 60;   // one probe per player every 3 s
		private const double ProbeTimeoutMs = 10_000; // a lost reply frees the player for a new probe
		private const double StaleAfterMs = 60_000;   // no reply for a minute: stop showing a number

		private struct State
		{
			public short Slot;          // item slot of the probe in flight, -1 when idle
			public long SentAt;         // Stopwatch ticks
			public double Rtt, Jitter;  // smoothed, ms; Rtt <= 0 means no sample yet
			public long LastSampleAt;
		}

		private static readonly State[] States = NewStates();
		private static int tick;

		private static State[] NewStates()
		{
			var s = new State[Main.maxPlayers];
			for (int i = 0; i < s.Length; i++) s[i].Slot = -1;
			return s;
		}

		private static void Reset(int i)
		{
			States[i] = default;
			States[i].Slot = -1;
		}

		private static double ElapsedMs(long from) => (Stopwatch.GetTimestamp() - from) * 1000.0 / Stopwatch.Frequency;

		public static (double rtt, double jitter)? Get(int i)
		{
			var s = States[i];
			if (s.Rtt <= 0 || ElapsedMs(s.LastSampleAt) > StaleAfterMs) return null;
			return (s.Rtt, s.Jitter);
		}

		public override void PostUpdateEverything()
		{
			if (Main.netMode != NetmodeID.Server || ++tick % ProbeEveryTicks != 0) return;
			short slot = FreeItemSlot();
			for (int i = 0; i < Main.maxPlayers; i++)
			{
				if (!Main.player[i].active || !Netplay.Clients[i].IsConnected())
				{
					if (States[i].Rtt > 0 || States[i].Slot >= 0) Reset(i);
					continue;
				}
				if (States[i].Slot >= 0 && ElapsedMs(States[i].SentAt) < ProbeTimeoutMs) continue;
				if (slot < 0) return;
				States[i].Slot = slot;
				States[i].SentAt = Stopwatch.GetTimestamp();
				NetMessage.SendData(MessageID.ReleaseItemOwnership, i, -1, null, slot);
			}
		}

		public override bool HijackGetData(ref byte messageType, ref BinaryReader reader, int playerNumber)
		{
			if (Main.netMode != NetmodeID.Server || messageType != MessageID.ItemOwner) return false;
			if (playerNumber < 0 || playerNumber >= Main.maxPlayers || States[playerNumber].Slot < 0) return false;

			long start = reader.BaseStream.Position;
			short slot;
			try { slot = reader.ReadInt16(); }
			catch (IOException) { return false; }
			finally { reader.BaseStream.Position = start; }
			if (slot != States[playerNumber].Slot) return false;

			double sample = ElapsedMs(States[playerNumber].SentAt);
			ref State s = ref States[playerNumber];
			if (s.Rtt <= 0) { s.Rtt = sample; s.Jitter = 0; }
			else
			{
				// Same smoothing TCP uses (RFC 6298), so one spike doesn't swing the number.
				s.Jitter = 0.75 * s.Jitter + 0.25 * Math.Abs(sample - s.Rtt);
				s.Rtt = 0.875 * s.Rtt + 0.125 * sample;
			}
			s.LastSampleAt = Stopwatch.GetTimestamp();
			s.Slot = -1;
			// Our own probe on an inactive slot: swallow it, vanilla has nothing to do. If an
			// item spawned in that slot meanwhile, let vanilla handle the reply as usual.
			return !Main.item[slot].active;
		}

		// Highest inactive slot (the game fills items from the bottom), so the probe never
		// touches a real dropped item. -1 if every slot is in use.
		private static short FreeItemSlot()
		{
			for (int i = Main.maxItems - 1; i >= 0; i--)
				if (!Main.item[i].active) return (short)i;
			return -1;
		}
	}

	// The connection's own TCP round trip from the kernel (Linux TCP_INFO). Only meaningful when
	// the server talks to the player directly; behind a tunnel it measures the local agent.
	internal static class KernelRtt
	{
		private const int IpProtoTcp = 6;
		private const int TcpInfoOption = 11;
		private const int RttOffset = 68;     // struct tcp_info: __u32 tcpi_rtt, microseconds
		private const int RttVarOffset = 72;  // __u32 tcpi_rttvar

		private static readonly FieldInfo ConnectionField =
			typeof(TcpSocket).GetField("_connection", BindingFlags.Instance | BindingFlags.NonPublic);

		public static (double rtt, double jitter)? Read(int playerIndex)
		{
			if (!RuntimeInformation.IsOSPlatform(OSPlatform.Linux)) return null;
			if (Netplay.Clients[playerIndex].Socket is not TcpSocket socket) return null;
			if (ConnectionField?.GetValue(socket) is not TcpClient client || client.Client == null) return null;

			try {
				var info = new byte[256];
				int length = client.Client.GetRawSocketOption(IpProtoTcp, TcpInfoOption, info);
				if (length < RttVarOffset + 4) return null;
				uint rtt = BitConverter.ToUInt32(info, RttOffset);
				uint rttVar = BitConverter.ToUInt32(info, RttVarOffset);
				return (rtt / 1000.0, rttVar / 1000.0);
			}
			catch (SocketException) { return null; }
			catch (ObjectDisposedException) { return null; }
		}
	}

	internal static class Addresses
	{
		public static IPAddress Of(int playerIndex) =>
			(Netplay.Clients[playerIndex].Socket?.GetRemoteAddress() as TcpAddress)?.Address;

		// A loopback or private source address means the player came through a tunnel or a
		// container gateway (playit.gg, Docker/OrbStack port forward): every player then shares
		// that address, so it identifies nobody and its TCP round trip is local.
		public static bool IsProxied(int playerIndex) => IsShared(Of(playerIndex));

		public static bool IsShared(IPAddress a)
		{
			if (a == null) return true;
			if (a.IsIPv4MappedToIPv6) a = a.MapToIPv4();
			if (IPAddress.IsLoopback(a)) return true;
			if (a.AddressFamily != AddressFamily.InterNetwork)
				return a.IsIPv6LinkLocal || a.IsIPv6SiteLocal || a.IsIPv6UniqueLocal;
			byte[] b = a.GetAddressBytes();
			return b[0] == 10
				|| (b[0] == 172 && b[1] >= 16 && b[1] <= 31)
				|| (b[0] == 192 && b[1] == 168)
				|| (b[0] == 100 && b[1] >= 64 && b[1] <= 127);   // CGNAT / Tailscale
		}
	}

	// In-game chat: /ping shows only your own connection. CommandType.Server means a
	// player types it in chat and the server runs it (CommandType.Chat would run on the
	// player's own game, which doesn't have this mod).
	public class PingCommand : ModCommand
	{
		public override CommandType Type => CommandType.Server;
		public override string Command => "ping";
		public override string Description => "Mostra o seu ping ate o servidor";

		public override void Action(CommandCaller caller, string input, string[] args)
		{
			caller.Reply("Seu ping ate o servidor: " + PingProbe.Describe(caller.Player.whoAmI));
		}
	}

	// Server console: everyone online, for checking whether a lag report is the network.
	public class PingAllCommand : ModCommand
	{
		public override CommandType Type => CommandType.Console;
		public override string Command => "pings";
		public override string Description => "Ping de cada jogador online";

		public override void Action(CommandCaller caller, string input, string[] args)
		{
			int online = 0;
			for (int i = 0; i < Main.maxPlayers; i++) {
				if (!Main.player[i].active) continue;
				online++;
				caller.Reply($"{Main.player[i].name}: {PingProbe.Describe(i)}");
			}
			if (online == 0) caller.Reply("ninguem online");
		}
	}
}
