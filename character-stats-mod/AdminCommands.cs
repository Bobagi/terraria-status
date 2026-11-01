using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using Terraria;
using Terraria.DataStructures;
using Terraria.ID;
using Terraria.Localization;
using Terraria.ModLoader;

namespace StatusExport
{
	// Console-only admin commands. CommandType.Console means they can only be typed
	// on the server console (`docker exec tmodloader inject "..."`, i.e. root on the
	// VPS), never from the in-game chat, so players can't reach them.
	//
	// Items, coins, NPCs and events are all spawned by the server and synced to
	// clients with vanilla packets, so players still don't need this mod.
	// Use tools/tmod-admin.sh on the host to run one and read its reply.

	// Console input runs on its own thread, and game state (Main.item, Main.npc)
	// belongs to the main loop. Commands wait here for the next tick. With nobody
	// online the loop is idle, so they run right away, the state is quiet then.
	public class AdminQueue : ModSystem
	{
		private static readonly ConcurrentQueue<Action> Pending = new ConcurrentQueue<Action>();

		public static void Run(Action action)
		{
			if (Netplay.HasClients) Pending.Enqueue(action);
			else action();
		}

		public override void PostUpdateEverything()
		{
			while (Pending.TryDequeue(out var action)) action();
		}
	}

	public class AdminError : Exception
	{
		public AdminError(string message) : base(message) { }
	}

	public abstract class AdminCommand : ModCommand
	{
		protected const int MaxPiles = 50;
		protected const int MaxSpawns = 20;

		public override CommandType Type => CommandType.Console;

		public sealed override void Action(CommandCaller caller, string input, string[] args)
		{
			AdminQueue.Run(() =>
			{
				try { Execute(caller, args); }
				catch (AdminError e) { caller.Reply("erro: " + e.Message); }
				catch (Exception e)
				{
					caller.Reply("erro: " + e.Message);
					Mod.Logger.Warn($"admin command '{input}' failed: {e}");
				}
			});
		}

		protected abstract void Execute(CommandCaller caller, string[] args);

		protected void Need(string[] args, int count)
		{
			if (args.Length < count) throw new AdminError("uso: " + Usage);
		}

		// Names are compared without spaces, so Terra_Blade, "terrablade" and
		// Terra Blade (joined back by the caller) all match.
		public static string Norm(string s) =>
			new string((s ?? "").Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());

		protected static IEnumerable<Player> Online() => Main.player.Where(p => p != null && p.active);

		protected static Player FindPlayer(string query)
		{
			string q = Norm(query);
			var online = Online().ToList();
			var hits = online.Where(p => Norm(p.name) == q).ToList();
			if (hits.Count == 0) hits = online.Where(p => Norm(p.name).StartsWith(q)).ToList();
			if (hits.Count == 1) return hits[0];
			string names = online.Count == 0 ? "ninguem" : string.Join(", ", online.Select(p => p.name));
			throw new AdminError(hits.Count == 0
				? $"jogador '{query}' nao esta online (online: {names})"
				: $"'{query}' e ambiguo (online: {names})");
		}

		// Resolves a numeric id, an internal name or a display name. Ambiguous
		// partial names are refused instead of guessed: wrong boss on a live world.
		protected static int Resolve(string query, int count, Func<int, string> display, Func<int, string> intern, string kind)
		{
			if (int.TryParse(query, out int id))
			{
				if (id > 0 && id < count) return id;
				throw new AdminError($"{kind} {id} nao existe");
			}
			string q = Norm(query);
			var all = Enumerable.Range(1, count - 1);
			var exact = all.Where(i => Norm(intern(i)) == q || Norm(display(i)) == q).ToList();
			if (exact.Count >= 1) return exact[0];
			var partial = all.Where(i => Norm(display(i)).Contains(q)).Take(9).ToList();
			if (partial.Count == 1) return partial[0];
			if (partial.Count == 0) throw new AdminError($"{kind} '{query}' nao encontrado");
			throw new AdminError($"{kind} '{query}' e ambiguo: " + string.Join(", ", partial.Select(i => $"{i}={display(i)}")));
		}

		protected static int ResolveItem(string q) =>
			Resolve(q, ItemLoader.ItemCount, Lang.GetItemNameValue, i => ItemID.Search.TryGetName(i, out var n) ? n : "", "item");

		protected static int ResolveNpc(string q) =>
			Resolve(q, NPCLoader.NPCCount, i => Lang.GetNPCNameValue(i), i => NPCID.Search.TryGetName(i, out var n) ? n : "", "npc");

		protected static int ResolveBuff(string q) =>
			Resolve(q, BuffLoader.BuffCount, i => Lang.GetBuffName(i), i => BuffID.Search.TryGetName(i, out var n) ? n : "", "buff");

		protected static int ResolvePrefix(string q) =>
			Resolve(q, PrefixLoader.PrefixCount, i => i < Lang.prefix.Length ? Lang.prefix[i].Value : PrefixLoader.GetPrefix(i).DisplayName.Value,
				i => PrefixID.Search.TryGetName(i, out var n) ? n : "", "prefixo");

		protected static IEntitySource Source => new EntitySource_DebugCommand("StatusExport admin");

		// Drops `stack` of an item on the player, split in max-stack piles. The
		// client picks it up on the next frame, with or without inventory room left
		// for it the pile stays on the ground next to them.
		protected static void Drop(Player p, int type, int stack, int prefix = 0)
		{
			int max = Math.Max(1, ContentSamples.ItemsByType[type].maxStack);
			if (stack / max + 1 > MaxPiles) throw new AdminError($"quantidade demais: limite de {MaxPiles} pilhas de {max}");
			for (int left = stack; left > 0; left -= max)
			{
				int index = Item.NewItem(Source, p.getRect(), type, Math.Min(left, max), noBroadcast: true, prefixGiven: prefix, noGrabDelay: true);
				NetMessage.SendData(MessageID.SyncItem, -1, -1, null, index, 1f);
			}
		}

		protected static int Int(string s, string what)
		{
			if (!int.TryParse(s, out int n) || n < 0) throw new AdminError($"{what} invalido: '{s}'");
			return n;
		}
	}

	public class WhoCommand : AdminCommand
	{
		public override string Command => "who";
		public override string Usage => "who";
		public override string Description => "Jogadores online: vida, mana, posicao";

		protected override void Execute(CommandCaller caller, string[] args)
		{
			var online = Online().ToList();
			if (online.Count == 0) { caller.Reply("ninguem online"); return; }
			foreach (var p in online)
				caller.Reply($"{p.name}: vida {p.statLife}/{p.statLifeMax2} mana {p.statMana}/{p.statManaMax2} tile {(int)(p.Center.X / 16)},{(int)(p.Center.Y / 16)}{(p.dead ? " MORTO" : "")}");
		}
	}

	public class FindCommand : AdminCommand
	{
		public override string Command => "find";
		public override string Usage => "find <item|npc|buff> <texto>";
		public override string Description => "Procura ids por nome";

		protected override void Execute(CommandCaller caller, string[] args)
		{
			Need(args, 2);
			string q = Norm(string.Concat(args.Skip(1)));
			(int count, Func<int, string> name) = args[0] switch
			{
				"item" => (ItemLoader.ItemCount, (Func<int, string>)Lang.GetItemNameValue),
				"npc" => (NPCLoader.NPCCount, i => Lang.GetNPCNameValue(i)),
				"buff" => (BuffLoader.BuffCount, i => Lang.GetBuffName(i)),
				_ => throw new AdminError("uso: " + Usage),
			};
			var hits = Enumerable.Range(1, count - 1).Where(i => Norm(name(i)).Contains(q)).ToList();
			foreach (int i in hits.Take(15))
				caller.Reply(args[0] == "npc" ? $"{i} {name(i)} (head {NPCID.Sets.BossHeadTextures[i]})" : $"{i} {name(i)}");
			caller.Reply(hits.Count > 15 ? $"... {hits.Count} no total, refine a busca" : $"{hits.Count} encontrado(s)");
		}
	}

	public class GiveCommand : AdminCommand
	{
		public override string Command => "give";
		public override string Usage => "give <jogador> <item> [quantidade] [prefixo]";
		public override string Description => "Entrega item (id ou nome, troque espaco por _)";

		protected override void Execute(CommandCaller caller, string[] args)
		{
			Need(args, 2);
			var p = FindPlayer(args[0]);
			int type = ResolveItem(args[1]);
			int stack = args.Length > 2 ? Int(args[2], "quantidade") : 1;
			int prefix = args.Length > 3 ? ResolvePrefix(args[3]) : 0;
			if (stack < 1) throw new AdminError("quantidade precisa ser 1 ou mais");
			Drop(p, type, stack, prefix);
			caller.Reply($"{stack}x {Lang.GetItemNameValue(type)} entregue a {p.name}");
		}
	}

	public class CoinsCommand : AdminCommand
	{
		public override string Command => "coins";
		public override string Usage => "coins <jogador> <platina> [ouro] [prata] [cobre]";
		public override string Description => "Entrega moedas";

		protected override void Execute(CommandCaller caller, string[] args)
		{
			Need(args, 2);
			var p = FindPlayer(args[0]);
			int Coin(int at, string what) => args.Length > at ? Int(args[at], what) : 0;
			int plat = Coin(1, "platina"), gold = Coin(2, "ouro"), silver = Coin(3, "prata"), copper = Coin(4, "cobre");
			if (plat + gold + silver + copper == 0) throw new AdminError("nenhuma moeda pedida");
			Drop(p, ItemID.PlatinumCoin, plat);
			Drop(p, ItemID.GoldCoin, gold);
			Drop(p, ItemID.SilverCoin, silver);
			Drop(p, ItemID.CopperCoin, copper);
			caller.Reply($"{plat}p {gold}o {silver}pr {copper}c entregue a {p.name}");
		}
	}

	public class HealCommand : AdminCommand
	{
		public override string Command => "heal";
		public override string Usage => "heal <jogador|all>";
		public override string Description => "Enche vida e mana (solta coracoes e estrelas)";

		// Life and mana are owned by the client: a value set here would be ignored,
		// so the server drops the pickups that make the client heal itself.
		protected override void Execute(CommandCaller caller, string[] args)
		{
			Need(args, 1);
			var targets = args[0] == "all" ? Online().ToList() : new List<Player> { FindPlayer(args[0]) };
			foreach (var p in targets)
			{
				int hearts = Math.Min(MaxPiles, (p.statLifeMax2 - p.statLife + 19) / 20);
				int stars = Math.Min(MaxPiles, (p.statManaMax2 - p.statMana + 99) / 100);
				for (int i = 0; i < hearts; i++) Drop(p, ItemID.Heart, 1);
				for (int i = 0; i < stars; i++) Drop(p, ItemID.Star, 1);
				caller.Reply($"{p.name}: {hearts} coracao(oes), {stars} estrela(s)");
			}
		}
	}

	public class BuffCommand : AdminCommand
	{
		public override string Command => "buff";
		public override string Usage => "buff <jogador> <buff> [segundos]";
		public override string Description => "Aplica um buff";

		protected override void Execute(CommandCaller caller, string[] args)
		{
			Need(args, 2);
			var p = FindPlayer(args[0]);
			int type = ResolveBuff(args[1]);
			int seconds = args.Length > 2 ? Int(args[2], "segundos") : 60;
			NetMessage.SendData(MessageID.AddPlayerBuff, p.whoAmI, -1, null, p.whoAmI, type, seconds * 60);
			caller.Reply($"{Lang.GetBuffName(type)} por {seconds}s em {p.name}");
		}
	}

	public class TpCommand : AdminCommand
	{
		public override string Command => "tp";
		public override string Usage => "tp <jogador> <jogador|spawn|dungeon|x y>";
		public override string Description => "Teleporta um jogador";

		protected override void Execute(CommandCaller caller, string[] args)
		{
			Need(args, 2);
			var p = FindPlayer(args[0]);
			Vector2 target;
			string label;
			if (args.Length >= 3) { target = new Vector2(Int(args[1], "x"), Int(args[2], "y")) * 16f; label = $"{args[1]},{args[2]}"; }
			else if (args[1] == "spawn") { target = new Vector2(Main.spawnTileX, Main.spawnTileY - 3) * 16f; label = "spawn"; }
			else if (args[1] == "dungeon") { target = new Vector2(Main.dungeonX, Main.dungeonY - 3) * 16f; label = "dungeon"; }
			else { var to = FindPlayer(args[1]); target = to.position; label = to.name; }

			if (!WorldGen.InWorld((int)(target.X / 16), (int)(target.Y / 16), 10)) throw new AdminError("posicao fora do mundo");
			RemoteClient.CheckSection(p.whoAmI, target);
			p.Teleport(target, TeleportationStyleID.RodOfDiscord);
			NetMessage.SendData(MessageID.TeleportEntity, -1, -1, null, 0, p.whoAmI, target.X, target.Y, TeleportationStyleID.RodOfDiscord);
			caller.Reply($"{p.name} -> {label}");
		}
	}

	public class SpawnCommand : AdminCommand
	{
		public override string Command => "spawn";
		public override string Usage => "spawn <npc|boss> <jogador> [quantidade]";
		public override string Description => "Invoca NPC ou boss perto do jogador";

		protected override void Execute(CommandCaller caller, string[] args)
		{
			Need(args, 2);
			int type = ResolveNpc(args[0]);
			var p = FindPlayer(args[1]);
			int count = args.Length > 2 ? Int(args[2], "quantidade") : 1;
			if (count < 1 || count > MaxSpawns) throw new AdminError($"quantidade entre 1 e {MaxSpawns}");
			bool boss = ContentSamples.NpcsByNetId[type].boss || type == NPCID.EaterofWorldsHead;
			for (int i = 0; i < count; i++)
			{
				if (type == NPCID.WallofFlesh) NPC.SpawnWOF(p.position);
				else if (boss) NPC.SpawnOnPlayer(p.whoAmI, type);
				else
				{
					int index = NPC.NewNPC(Source, (int)p.Center.X + Main.rand.Next(-160, 161), (int)p.Center.Y - 160, type);
					NetMessage.SendData(MessageID.SyncNPC, -1, -1, null, index);
				}
			}
			caller.Reply($"{count}x {Lang.GetNPCNameValue(type)} perto de {p.name}");
		}
	}

	public class ClearHostileCommand : AdminCommand
	{
		public override string Command => "clearhostile";
		public override string Usage => "clearhostile";
		public override string Description => "Remove inimigos e bosses, sem drops";

		private static bool IsHostile(NPC n) =>
			n.active && !n.friendly && !n.townNPC && !NPCID.Sets.CountsAsCritter[n.type] && n.type != NPCID.TargetDummy;

		protected override void Execute(CommandCaller caller, string[] args)
		{
			int removed = 0;
			foreach (var n in Main.npc.Where(IsHostile))
			{
				n.active = false;
				NetMessage.SendData(MessageID.SyncNPC, -1, -1, null, n.whoAmI);
				removed++;
			}
			caller.Reply($"{removed} removido(s)");
		}
	}

	public class EventCommand : AdminCommand
	{
		public override string Command => "event";
		public override string Usage => "event <bloodmoon|eclipse|goblins|frost|pirates|martians|pumpkinmoon|frostmoon|rain|stop>";
		public override string Description => "Liga um evento do mundo (stop encerra todos)";

		protected override void Execute(CommandCaller caller, string[] args)
		{
			Need(args, 1);
			switch (args[0])
			{
				case "bloodmoon": SetTime(day: false); Main.bloodMoon = true; break;
				case "eclipse": SetTime(day: true); Main.eclipse = true; break;
				case "goblins": Invasion(InvasionID.GoblinArmy); break;
				case "frost": Invasion(InvasionID.SnowLegion); break;
				case "pirates": Invasion(InvasionID.PirateInvasion); break;
				case "martians": Invasion(InvasionID.MartianMadness); break;
				case "pumpkinmoon": SetTime(day: false); Main.startPumpkinMoon(); break;
				case "frostmoon": SetTime(day: false); Main.startSnowMoon(); break;
				case "rain": Main.StartRain(); Main.SyncRain(); break;
				case "stop":
					Main.bloodMoon = Main.eclipse = Main.pumpkinMoon = Main.snowMoon = false;
					Main.invasionType = Main.invasionSize = 0;
					Main.StopRain();
					Main.SyncRain();
					break;
				default: throw new AdminError("uso: " + Usage);
			}
			NetMessage.SendData(MessageID.WorldData);
			caller.Reply("event " + args[0] + " ok");
		}

		// Moons and eclipses only exist in their half of the day.
		private static void SetTime(bool day)
		{
			if (Main.dayTime != day) { Main.dayTime = day; Main.time = 0; }
		}

		private static void Invasion(int id)
		{
			Main.invasionDelay = 0;
			Main.StartInvasion(id);
			if (Main.invasionType != id) throw new AdminError("o jogo recusou: invasao em andamento ou ninguem com vida suficiente");
		}
	}
}
