using System;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using Terraria;
using Terraria.ModLoader;
using Terraria.Net.Sockets;

namespace StatusExport
{
	// Network latency as the server's kernel measures it on each player's TCP
	// connection (Linux TCP_INFO round-trip time), so nothing is needed on the client.
	public static class PingProbe
	{
		private const int IpProtoTcp = 6;
		private const int TcpInfoOption = 11;
		private const int RttOffset = 68;     // struct tcp_info: __u32 tcpi_rtt, microseconds
		private const int RttVarOffset = 72;  // __u32 tcpi_rttvar

		private static readonly FieldInfo ConnectionField =
			typeof(TcpSocket).GetField("_connection", BindingFlags.Instance | BindingFlags.NonPublic);

		// Returns (rtt, jitter) in milliseconds, or null when it can't be read.
		public static (double rtt, double jitter)? Read(int playerIndex)
		{
			if (!RuntimeInformation.IsOSPlatform(OSPlatform.Linux)) return null;
			if (playerIndex < 0 || playerIndex >= Netplay.Clients.Length) return null;
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

		public static string Describe(int playerIndex)
		{
			var ping = Read(playerIndex);
			if (ping == null) return "sem medida";
			var (rtt, jitter) = ping.Value;
			string verdict = rtt < 80 ? "bom" : rtt < 150 ? "ok" : rtt < 250 ? "alto" : "muito alto";
			return $"{rtt:0} ms (variacao {jitter:0} ms, {verdict})";
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
