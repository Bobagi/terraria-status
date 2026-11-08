using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;              // ships with tModLoader
using Terraria;
using Terraria.GameContent.Events;
using Terraria.ID;
using Terraria.ModLoader;

namespace StatusExport
{
	// Boss fights, invasions and deaths, appended to serverevents.jsonl next to the world,
	// one JSON object per line. The terraria-status app tails the file and posts the
	// events to Discord. The mod itself never touches the network.
	//
	// Line shapes (v = 1):
	//   boss_kill   { boss, bossKey, durationSec, participants:[{name, damage, deaths}] }
	//   boss_wipe   { boss, bossKey, durationSec, lifePct, participants:[...] }
	//   event_start { event }     event_end { event, durationSec }
	//   death       { name, inBoss }
	public static class EventLog
	{
		private static readonly object Gate = new object();
		private const long RotateBytes = 20L * 1024 * 1024;
		private static string FilePath => Path.Combine(Main.SavePath, "serverevents.jsonl");

		public static void Write(string type, IDictionary<string, object> fields)
		{
			try
			{
				var line = new Dictionary<string, object>
				{
					["v"] = 1,
					["id"] = Guid.NewGuid().ToString("N"),
					["t"] = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),
					["type"] = type,
				};
				foreach (var kv in fields) line[kv.Key] = kv.Value;
				lock (Gate)
				{
					var info = new FileInfo(FilePath);
					if (info.Exists && info.Length > RotateBytes) File.Move(FilePath, FilePath + ".1", true);
					File.AppendAllText(FilePath, JsonConvert.SerializeObject(line) + "\n");
				}
			}
			catch { /* a side file must never destabilize the server */ }
		}
	}

	// Who hit which boss for how much, and when the boss finally dies.
	//
	// Damage: tModLoader's OnHitByItem / OnHitByProjectile run on the client that dealt the hit,
	// so a dedicated server cannot count with them. What the server does see is the strike packet
	// (DamageNPC, 28) with the sender's player slot. For every strike on a boss we note the sender
	// and the boss's life just BEFORE vanilla handles the packet, and settle it just AFTER (next
	// strike, next tick, or the boss's death): damage = life before - life after. That is exact
	// (no overkill, defense already applied) and needs nothing on the client. Worm-like bosses share
	// one life pool through NPC.realLife, so the pool owner is the one measured.
	public static class BossFights
	{
		private sealed class Fight
		{
			public string Group, Name;
			public DateTime Start = DateTime.UtcNow;
			public DateTime? EmptySince;
			public int LifePct = 100;
			public long MaxLife;
			public readonly Dictionary<string, long> Damage = new Dictionary<string, long>();
			public readonly Dictionary<string, int> Deaths = new Dictionary<string, int>();
		}

		private static readonly object Gate = new object();
		private static readonly Dictionary<string, Fight> Fights = new Dictionary<string, Fight>();
		private static readonly Dictionary<string, DateTime> RecentlyEnded = new Dictionary<string, DateTime>();

		// The strike waiting to be settled.
		private static bool pendingValid;
		private static string pendingPlayer, pendingGroup, pendingName;
		private static int pendingLifeIdx, pendingLifeType, pendingBefore;

		// Group key and display name of the fight an NPC belongs to, null when it is not part of one.
		// A group is one fight: the Twins are two NPCs, Skeletron has hands, Moon Lord has parts.
		private static string GroupOf(NPC n, out string name)
		{
			name = null;
			switch (n.type)
			{
				case NPCID.EaterofWorldsHead: case NPCID.EaterofWorldsBody: case NPCID.EaterofWorldsTail:
					name = "Eater of Worlds"; return "EaterofWorlds";
				case NPCID.TheDestroyer: case NPCID.TheDestroyerBody: case NPCID.TheDestroyerTail:
					name = "The Destroyer"; return "TheDestroyer";
				case NPCID.Retinazer: case NPCID.Spazmatism:
					name = "The Twins"; return "TheTwins";
				case NPCID.SkeletronHead: case NPCID.SkeletronHand:
					name = "Skeletron"; return "Skeletron";
				case NPCID.SkeletronPrime: case NPCID.PrimeCannon: case NPCID.PrimeSaw: case NPCID.PrimeVice: case NPCID.PrimeLaser:
					name = "Skeletron Prime"; return "SkeletronPrime";
				case NPCID.Golem: case NPCID.GolemHead: case NPCID.GolemFistLeft: case NPCID.GolemFistRight: case NPCID.GolemHeadFree:
					name = "Golem"; return "Golem";
				case NPCID.WallofFlesh: case NPCID.WallofFleshEye:
					name = "Wall of Flesh"; return "WallofFlesh";
				case NPCID.MoonLordCore: case NPCID.MoonLordHead: case NPCID.MoonLordHand:
					name = "Moon Lord"; return "MoonLord";
			}
			if (!n.boss) return null;
			name = Lang.GetNPCNameValue(n.type);
			return n.type < NPCID.Count ? NPCID.Search.GetName(n.type) : (n.ModNPC?.FullName ?? name);
		}

		// Is this death the one that ends the fight? Bosses with parts end with their main NPC;
		// the rest end when no other NPC of the group is left.
		private static bool IsFinalKill(NPC dead, string group)
		{
			switch (group)
			{
				case "Skeletron": return dead.type == NPCID.SkeletronHead;
				case "SkeletronPrime": return dead.type == NPCID.SkeletronPrime;
				case "Golem": return dead.type == NPCID.Golem;
				case "WallofFlesh": return dead.type == NPCID.WallofFlesh;
				case "MoonLord": return dead.type == NPCID.MoonLordCore;
				default: return !OtherAlive(dead, group);
			}
		}

		// Segments that share the dead NPC's life pool (worms: body and tail point at the head through
		// realLife) are still active for a tick after the pool dies and then vanish without OnKill, so
		// they do not count as "still alive". Without this, the Destroyer never ended as a kill.
		private static bool OtherAlive(NPC dead, string group)
		{
			int pool = dead.realLife >= 0 ? dead.realLife : dead.whoAmI;
			for (int i = 0; i < Main.maxNPCs; i++)
			{
				NPC n = Main.npc[i];
				if (n == null || !n.active || n.life <= 0 || i == dead.whoAmI || i == pool || n.realLife == pool) continue;
				if (GroupOf(n, out _) == group) return true;
			}
			return false;
		}

		private static Fight GetFight(string group, string name)
		{
			if (!Fights.TryGetValue(group, out Fight f)) Fights[group] = f = new Fight { Group = group, Name = name };
			return f;
		}

		// Called with the sender and target of a strike packet, before vanilla applies it.
		public static void BeginStrike(int player, int npcIndex)
		{
			if (player < 0 || player >= Main.maxPlayers || npcIndex < 0 || npcIndex >= Main.maxNPCs) return;
			NPC n = Main.npc[npcIndex];
			if (n == null || !n.active || n.life <= 0) return;
			string group = GroupOf(n, out string name);
			if (group == null) return;
			int lifeIdx = n.realLife >= 0 && n.realLife < Main.maxNPCs ? n.realLife : npcIndex;
			NPC pool = Main.npc[lifeIdx];
			if (pool == null || !pool.active) return;
			lock (Gate)
			{
				pendingValid = true;
				pendingPlayer = Main.player[player].name;
				pendingGroup = group;
				pendingName = name;
				pendingLifeIdx = lifeIdx;
				pendingLifeType = pool.type;
				pendingBefore = pool.life;
			}
		}

		// Settles the waiting strike: how much life did the boss lose to it?
		public static void ResolvePending()
		{
			lock (Gate)
			{
				if (!pendingValid) return;
				pendingValid = false;
				NPC pool = Main.npc[pendingLifeIdx];
				int after = pool != null && pool.active && pool.type == pendingLifeType ? Math.Max(0, pool.life) : 0;
				long dealt = pendingBefore - after;
				if (dealt <= 0 || string.IsNullOrEmpty(pendingPlayer)) return;
				Fight f = GetFight(pendingGroup, pendingName);
				f.Damage.TryGetValue(pendingPlayer, out long total);
				f.Damage[pendingPlayer] = total + dealt;
			}
		}

		public static void OnNpcKilled(NPC npc)
		{
			if (!Main.dedServ) return;
			ResolvePending();
			string group = GroupOf(npc, out string name);
			if (group == null) return;
			lock (Gate)
			{
				if (!IsFinalKill(npc, group)) return;
				// Segmented bosses can report several final-looking deaths in one tick.
				if (RecentlyEnded.TryGetValue(group, out DateTime at) && (DateTime.UtcNow - at).TotalSeconds < 10) return;
				if (!Fights.TryGetValue(group, out Fight f)) f = new Fight { Group = group, Name = name };   // killed without a recorded hit
				Fights.Remove(group);
				RecentlyEnded[group] = DateTime.UtcNow;
				Emit("boss_kill", f, null);
			}
		}

		public static void OnPlayerDeath(string name)
		{
			if (string.IsNullOrEmpty(name)) return;
			bool inBoss = false;
			lock (Gate)
			{
				foreach (Fight f in Fights.Values)
				{
					f.Deaths.TryGetValue(name, out int d);
					f.Deaths[name] = d + 1;
					inBoss = true;
				}
			}
			EventLog.Write("death", new Dictionary<string, object> { ["name"] = name, ["inBoss"] = inBoss });
		}

		// Every ~0.5 s: track each fight's remaining life and close the ones whose boss is gone
		// without dying (despawned, or everyone died) as a lost fight.
		public static void Tick()
		{
			lock (Gate)
			{
				if (Fights.Count == 0) return;
				var done = new List<string>();
				foreach (var kv in Fights)
				{
					Fight f = kv.Value;
					long life = 0, max = 0;
					bool alive = false;
					for (int i = 0; i < Main.maxNPCs; i++)
					{
						NPC n = Main.npc[i];
						if (n == null || !n.active || n.life <= 0 || GroupOf(n, out _) != kv.Key) continue;
						alive = true;
						if (n.realLife < 0 || n.realLife == i) { life += n.life; max += n.lifeMax; }
					}
					if (alive)
					{
						f.EmptySince = null;
						if (max > 0) f.LifePct = (int)Math.Min(100, 100 * life / max);
						if (max > f.MaxLife) f.MaxLife = max;
						continue;
					}
					if (f.EmptySince == null) { f.EmptySince = DateTime.UtcNow; continue; }
					if ((DateTime.UtcNow - f.EmptySince.Value).TotalSeconds >= 8) done.Add(kv.Key);
				}
				foreach (string key in done)
				{
					Fight f = Fights[key];
					Fights.Remove(key);
					if (f.Damage.Count == 0) continue;
					// Safety net: the boss vanished without a recognised final kill, but the players took
					// its whole life pool, so it died (a boss with parts whose last death we missed).
					long dealt = f.Damage.Values.Sum();
					if (f.MaxLife > 0 && dealt >= f.MaxLife * 99 / 100)
					{
						RecentlyEnded[key] = DateTime.UtcNow;
						Emit("boss_kill", f, null);
					}
					else if ((DateTime.UtcNow - f.Start).TotalSeconds >= 10) Emit("boss_wipe", f, f.LifePct);
				}
			}
		}

		// Forget everything without reporting (world reload, admin clearhostile).
		public static void Reset()
		{
			lock (Gate) { Fights.Clear(); RecentlyEnded.Clear(); pendingValid = false; }
		}

		private static void Emit(string type, Fight f, int? lifePct)
		{
			var players = f.Damage.OrderByDescending(kv => kv.Value)
				.Select(kv => new Dictionary<string, object>
				{
					["name"] = kv.Key,
					["damage"] = kv.Value,
					["deaths"] = f.Deaths.TryGetValue(kv.Key, out int d) ? d : 0,
				}).ToList();
			// Players who died in the fight without landing a hit still belong in the report.
			foreach (var kv in f.Deaths)
				if (!f.Damage.ContainsKey(kv.Key))
					players.Add(new Dictionary<string, object> { ["name"] = kv.Key, ["damage"] = 0L, ["deaths"] = kv.Value });

			var fields = new Dictionary<string, object>
			{
				["boss"] = f.Name,
				["bossKey"] = f.Group,
				["durationSec"] = (int)(DateTime.UtcNow - f.Start).TotalSeconds,
				["participants"] = players.Take(16).ToList(),
			};
			if (lifePct.HasValue) fields["lifePct"] = lifePct.Value;
			EventLog.Write(type, fields);
			try { AnnounceInChat(type, f, lifePct); }
			catch (Exception e) { ModContent.GetInstance<StatusExport>()?.Logger.Warn("BossFights chat: " + e.Message); }
		}

		private static readonly System.Globalization.CultureInfo PtBr = new System.Globalization.CultureInfo("pt-BR");
		private static string Num(double v) => Math.Round(v).ToString("N0", PtBr);

		// The same summary the Discord feed posts, short enough for the in-game chat.
		private static void AnnounceInChat(string type, Fight f, int? lifePct)
		{
			if (Main.netMode != NetmodeID.Server) return;
			double secs = Math.Max(1, (DateTime.UtcNow - f.Start).TotalSeconds);
			long total = f.Damage.Values.Sum();
			bool kill = type == "boss_kill";
			string head = kill
				? $"{f.Name} derrotado em {(int)secs}s · {Num(total)} de dano"
				: $"{f.Name} venceu esta rodada ({(int)secs}s, ainda com {lifePct ?? 0}% da vida)";
			var color = kill ? new Microsoft.Xna.Framework.Color(255, 200, 60) : new Microsoft.Xna.Framework.Color(220, 90, 70);
			Terraria.Chat.ChatHelper.BroadcastChatMessage(Terraria.Localization.NetworkText.FromLiteral(head), color);
			int rank = 0;
			foreach (var kv in f.Damage.OrderByDescending(kv => kv.Value).Take(5))
			{
				rank++;
				int pct = total > 0 ? (int)Math.Round(100.0 * kv.Value / total) : 0;
				int deaths = f.Deaths.TryGetValue(kv.Key, out int d) ? d : 0;
				string line = $"  {rank}. {kv.Key}: {Num(kv.Value)} ({Num(kv.Value / secs)} DPS, {pct}%)" + (deaths > 0 ? $" · {deaths} morte{(deaths > 1 ? "s" : "")}" : "");
				Terraria.Chat.ChatHelper.BroadcastChatMessage(Terraria.Localization.NetworkText.FromLiteral(line), color);
			}
		}
	}

	public class BossFightWatcher : ModSystem
	{
		private const byte DamageNpcMessage = 28;   // NPC strike, vanilla message id
		private int tick;

		public override void OnWorldLoad() { BossFights.Reset(); }

		// Runs just before vanilla handles the packet; never swallows it.
		public override bool HijackGetData(ref byte messageType, ref BinaryReader reader, int playerNumber)
		{
			if (Main.netMode != NetmodeID.Server || messageType != DamageNpcMessage) return false;
			BossFights.ResolvePending();            // the previous strike is finished by now
			long start = reader.BaseStream.Position;
			short npcIndex;
			try { npcIndex = reader.ReadInt16(); }
			catch (IOException) { return false; }
			finally { reader.BaseStream.Position = start; }
			try { BossFights.BeginStrike(playerNumber, npcIndex); }
			catch (Exception e) { Mod.Logger.Warn("BossFights strike: " + e.Message); }
			return false;
		}

		public override void PostUpdateEverything()
		{
			if (!Main.dedServ) return;
			try
			{
				BossFights.ResolvePending();
				if (++tick % 30 == 0) BossFights.Tick();
			}
			catch (Exception e) { Mod.Logger.Warn("BossFights tick: " + e.Message); }
		}
	}

	// Server-side only: fires in single player or on the server, so the dedicated check is explicit.
	public class BossKillWatcher : GlobalNPC
	{
		public override void OnKill(NPC npc)
		{
			try { BossFights.OnNpcKilled(npc); }
			catch (Exception e) { ModContent.GetInstance<StatusExport>()?.Logger.Warn("BossFights kill: " + e.Message); }
		}
	}

	// Blood moon, eclipse, pumpkin/frost moon, invasions and the Old One's Army: start and end,
	// with how long each lasted. Whatever is already running when the server boots is not announced.
	public class WorldEventWatcher : ModSystem
	{
		private readonly Dictionary<string, DateTime> active = new Dictionary<string, DateTime>();
		private bool primed;
		private int tick;

		public override void OnWorldLoad() { active.Clear(); primed = false; }

		public override void PostUpdateEverything()
		{
			if (!Main.dedServ || ++tick % 60 != 0) return;
			try { Poll(); }
			catch (Exception e) { Mod.Logger.Warn("WorldEvents: " + e.Message); }
		}

		private void Poll()
		{
			var now = new Dictionary<string, bool>
			{
				["bloodMoon"] = Main.bloodMoon,
				["eclipse"] = Main.eclipse,
				["pumpkinMoon"] = Main.pumpkinMoon,
				["frostMoon"] = Main.snowMoon,
				["goblins"] = Main.invasionType == 1,
				["frostLegion"] = Main.invasionType == 2,
				["pirates"] = Main.invasionType == 3,
				["martians"] = Main.invasionType == 4,
				["oldOnesArmy"] = DD2Event.Ongoing,
			};
			foreach (var kv in now)
			{
				bool was = active.TryGetValue(kv.Key, out DateTime since);
				if (kv.Value && !was)
				{
					active[kv.Key] = DateTime.UtcNow;
					if (primed) EventLog.Write("event_start", new Dictionary<string, object> { ["event"] = kv.Key });
				}
				else if (!kv.Value && was)
				{
					active.Remove(kv.Key);
					if (primed)
						EventLog.Write("event_end", new Dictionary<string, object>
						{
							["event"] = kv.Key,
							["durationSec"] = (int)(DateTime.UtcNow - since).TotalSeconds,
						});
				}
			}
			primed = true;
		}
	}
}
