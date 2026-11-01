using System.IO;
using System.Net;
using Terraria;
using Terraria.ID;
using Terraria.Localization;
using Terraria.ModLoader;
using Terraria.Net;

namespace StatusExport
{
	// When a client's connection dies, the server keeps its session for about two
	// minutes and refuses that name with "X is already on this server". This drops
	// the dead session the moment its owner reconnects.
	//
	// Being connected under a name is not proof of being dead, so a session only
	// goes when the newcomer shares its IP or when it has stopped talking. A live
	// player can't be pushed out by someone else who picked the same name.
	public class GhostSessions : ModSystem
	{
		// Clients send several packets per second, so 5 s of silence is a dead link.
		private const int SilentTicks = 5 * 60;
		private const int JoiningState = 10;

		public override bool HijackGetData(ref byte messageType, ref BinaryReader reader, int playerNumber)
		{
			if (Main.netMode != NetmodeID.Server || messageType != MessageID.SyncPlayer) return false;
			if (Netplay.Clients[playerNumber].State >= JoiningState) return false;
			string name = PeekName(reader);
			if (string.IsNullOrEmpty(name)) return false;

			for (int i = 0; i < Main.maxPlayers; i++)
			{
				RemoteClient old = Netplay.Clients[i];
				if (i == playerNumber || !old.IsActive || Main.player[i].name != name) continue;
				if (old.TimeOutTimer < SilentTicks && !SameAddress(old, Netplay.Clients[playerNumber])) continue;

				// The vanilla check right after this hook compares player names and the
				// boot only finishes on the server loop, so the name has to go now.
				Main.player[i].name = "";
				NetMessage.BootPlayer(i, NetworkText.FromLiteral("Sessao substituida por uma nova conexao."));
				Mod.Logger.Info($"GhostSessions: replaced session {i} of {name}");
			}
			return false;
		}

		// SyncPlayer starts with player index, skin variant and hair, then the name.
		private static string PeekName(BinaryReader reader)
		{
			long start = reader.BaseStream.Position;
			try
			{
				reader.ReadBytes(3);
				return reader.ReadString().Trim();
			}
			catch (IOException)
			{
				return null;
			}
			finally
			{
				reader.BaseStream.Position = start;
			}
		}

		private static bool SameAddress(RemoteClient a, RemoteClient b)
		{
			IPAddress first = (a.Socket?.GetRemoteAddress() as TcpAddress)?.Address;
			IPAddress second = (b.Socket?.GetRemoteAddress() as TcpAddress)?.Address;
			return first != null && first.Equals(second);
		}
	}
}
