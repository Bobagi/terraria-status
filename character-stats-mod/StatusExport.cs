using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;              // ships with tModLoader
using Terraria;
using Terraria.ID;
using Terraria.ModLoader;

namespace StatusExport
{
	// Server-side (side = Server in build.txt) mod: every few seconds it writes a
	// JSON snapshot of the online players' character stats + a small world summary
	// to the save directory, so the terraria-status web page can show them in its
	// player modal and world panel.
	//
	// Because it is side = Server, PLAYERS DO NOT NEED THIS MOD — it does not
	// change the required modlist and nobody gets kicked for not having it.
	//
	// It reads only data the server already receives for multiplayer sync
	// (life/mana/defense, equipped items, inventory, buffs) plus world flags the
	// server owns (day/night, hardmode, downed bosses). It writes nothing to
	// gameplay and adds no content.
	public class StatusExport : Mod { }

	// ---- persistent per-player death counter -------------------------------
	// Terraria has no accessible lifetime death count, so we keep our own. It is
	// keyed by character name (unique enough on a small friends' server) and
	// persisted to a side file so it survives server restarts.
	public static class DeathTracker
	{
		private static readonly object Gate = new object();
		public static Dictionary<string, int> Deaths = new Dictionary<string, int>();
		private static string FilePath => Path.Combine(Main.SavePath, "playerdeaths.json");

		public static void Load()
		{
			lock (Gate)
			{
				try
				{
					if (File.Exists(FilePath))
						Deaths = JsonConvert.DeserializeObject<Dictionary<string, int>>(File.ReadAllText(FilePath))
							?? new Dictionary<string, int>();
				}
				catch { Deaths = new Dictionary<string, int>(); }
			}
		}

		public static void Save()
		{
			lock (Gate)
			{
				try
				{
					string tmp = FilePath + ".tmp";
					File.WriteAllText(tmp, JsonConvert.SerializeObject(Deaths));
					File.Copy(tmp, FilePath, true);
					File.Delete(tmp);
				}
				catch { /* a status side file must never destabilize the server */ }
			}
		}

		public static void Increment(string name)
		{
			if (string.IsNullOrEmpty(name)) return;
			lock (Gate) { Deaths.TryGetValue(name, out int n); Deaths[name] = n + 1; }
		}

		public static int Get(string name)
		{
			if (string.IsNullOrEmpty(name)) return 0;
			lock (Gate) { Deaths.TryGetValue(name, out int n); return n; }
		}
	}

	// Counts deaths on the dedicated server (Kill runs server-side for each player).
	public class DeathCounter : ModPlayer
	{
		public override void Kill(double damage, int hitDirection, bool pvp, Terraria.DataStructures.PlayerDeathReason damageSource)
		{
			if (Main.dedServ) DeathTracker.Increment(Player.name);
		}
	}

	public class StatsExporterSystem : ModSystem
	{
		private const int IntervalTicks = 180; // ~3 s at 60 fps
		private int _tick;
		private bool _loggedOk, _loggedErr;

		public override void OnModLoad() { DeathTracker.Load(); }

		// PostUpdateEverything fires every tick on a dedicated server (unlike some
		// player/world hooks that can be skipped headless).
		public override void PostUpdateEverything()
		{
			// Only ever run on a dedicated server.
			if (!Main.dedServ) return;
			if (++_tick < IntervalTicks) return;
			_tick = 0;

			// The whole body is guarded: a mod must never destabilize the server,
			// and this one only produces a side file — if anything throws, log it
			// once and skip rather than spamming the tick loop.
			try
			{
				var players = Main.player
					.Where(p => p != null && p.active)
					.Select(BuildPlayer)
					.ToList();

				var payload = new
				{
					updatedAt = System.DateTime.UtcNow.ToString("o"),
					world = BuildWorld(),
					players
				};

				// Main.SavePath is the tModLoader save dir (e.g. /data/tModLoader in
				// the Docker image), which is exactly where the site reads from.
				string tmp = Path.Combine(Main.SavePath, "playerstats.json.tmp");
				string dst = Path.Combine(Main.SavePath, "playerstats.json");
				File.WriteAllText(tmp, JsonConvert.SerializeObject(payload));
				File.Copy(tmp, dst, true);   // near-atomic replace so the reader never sees a half file
				File.Delete(tmp);
				DeathTracker.Save();
				if (!_loggedOk) { Mod.Logger.Info($"StatusExport: writing {players.Count} player(s) to {dst}"); _loggedOk = true; }
			}
			catch (System.Exception e)
			{
				// Log once so a real problem is diagnosable, but never destabilize the server.
				if (!_loggedErr) { Mod.Logger.Warn("StatusExport export failed: " + e); _loggedErr = true; }
			}
		}

		// ---- world summary ----------------------------------------------------
		private static object BuildWorld()
		{
			// In-game 24h clock (the standard Terraria time→hour conversion).
			double t = Main.time;
			if (!Main.dayTime) t += 54000.0;
			t = t / 86400.0 * 24.0 - 7.5;
			if (t < 0.0) t += 24.0;
			int hh = (int)t, mm = (int)((t - hh) * 60.0);

			var downed = new Dictionary<string, bool>
			{
				["eyeOfCthulhu"]   = NPC.downedBoss1,
				["evilBoss"]       = NPC.downedBoss2,   // Eater of Worlds / Brain of Cthulhu
				["skeletron"]      = NPC.downedBoss3,
				["queenBee"]       = NPC.downedQueenBee,
				["deerclops"]      = NPC.downedDeerclops,
				["wallOfFlesh"]    = Main.hardMode,
				["queenSlime"]     = NPC.downedQueenSlime,
				["destroyer"]      = NPC.downedMechBoss1,
				["theTwins"]       = NPC.downedMechBoss2,
				["skeletronPrime"] = NPC.downedMechBoss3,
				["plantera"]       = NPC.downedPlantBoss,
				["golem"]          = NPC.downedGolemBoss,
				["empress"]        = NPC.downedEmpressOfLight,
				["duke"]           = NPC.downedFishron,
				["cultist"]        = NPC.downedAncientCultist,
				["moonLord"]       = NPC.downedMoonlord,
			};

			// Coarse progression stage for the "level" proxy.
			string stage =
				NPC.downedMoonlord ? "Fim de jogo (Moon Lord)" :
				NPC.downedGolemBoss ? "Pós-Golem" :
				NPC.downedPlantBoss ? "Pós-Plantera" :
				(NPC.downedMechBoss1 && NPC.downedMechBoss2 && NPC.downedMechBoss3) ? "Pós-mecânicos" :
				(NPC.downedMechBoss1 || NPC.downedMechBoss2 || NPC.downedMechBoss3) ? "Hardmode (mecânicos)" :
				Main.hardMode ? "Hardmode" :
				NPC.downedBoss3 ? "Pré-Wall of Flesh" :
				(NPC.downedBoss1 || NPC.downedBoss2) ? "Pré-Skeletron" :
				"Pré-boss";

			return new
			{
				dayTime = Main.dayTime,
				timeText = $"{hh:00}:{mm:00}",
				moonPhase = Main.moonPhase,
				hardMode = Main.hardMode,
				bloodMoon = Main.bloodMoon,
				eclipse = Main.eclipse,
				pumpkinMoon = Main.pumpkinMoon,
				snowMoon = Main.snowMoon,
				progression = stage,
				downed
			};
		}

		// ---- one player -------------------------------------------------------
		private static object BuildPlayer(Player p)
		{
			// Equipped functional gear: armor[0..2] head/body/legs, [3..9] accessories.
			var equips = new List<object>();
			for (int i = 0; i <= 9 && i < p.armor.Length; i++)
				if (p.armor[i] != null && !p.armor[i].IsAir) equips.Add(Item(p.armor[i]));

			// Vanity (social) armor + accessories: armor[10..19].
			var vanity = new List<object>();
			for (int i = 10; i <= 19 && i < p.armor.Length; i++)
				if (p.armor[i] != null && !p.armor[i].IsAir) vanity.Add(Item(p.armor[i]));

			// Utility equips: pet / light pet / minecart / mount / hook.
			var misc = new List<object>();
			for (int i = 0; i < p.miscEquips.Length; i++)
				if (p.miscEquips[i] != null && !p.miscEquips[i].IsAir) misc.Add(Item(p.miscEquips[i]));

			// Main inventory (slots 0..49).
			var inventory = new List<object>();
			int invCount = 0;
			for (int i = 0; i < 50 && i < p.inventory.Length; i++)
			{
				var it = p.inventory[i];
				if (it == null || it.IsAir) continue;
				invCount++;
				if (inventory.Count < 50) inventory.Add(Item(it));
			}

			// Ammo slots (54..57).
			var ammo = new List<object>();
			for (int i = 54; i <= 57 && i < p.inventory.Length; i++)
				if (p.inventory[i] != null && !p.inventory[i].IsAir) ammo.Add(Item(p.inventory[i]));

			// Wealth: total coin value across the inventory, split plat/gold/silver/copper.
			long copper = 0;
			for (int i = 0; i < p.inventory.Length; i++)
			{
				var it = p.inventory[i];
				if (it == null || it.IsAir) continue;
				if (it.type == ItemID.CopperCoin) copper += it.stack;
				else if (it.type == ItemID.SilverCoin) copper += 100L * it.stack;
				else if (it.type == ItemID.GoldCoin) copper += 10000L * it.stack;
				else if (it.type == ItemID.PlatinumCoin) copper += 1000000L * it.stack;
			}
			var wealth = new
			{
				plat = (int)(copper / 1000000L),
				gold = (int)(copper / 10000L % 100),
				silver = (int)(copper / 100L % 100),
				copper = (int)(copper % 100),
			};

			// Active buffs.
			var buffs = new List<object>();
			for (int i = 0; i < p.buffType.Length; i++)
			{
				if (p.buffType[i] > 0 && p.buffTime[i] > 0)
					buffs.Add(new
					{
						id = p.buffType[i] < BuffID.Count ? p.buffType[i] : -1,
						name = Lang.GetBuffName(p.buffType[i]),
					});
			}

			var held = (p.inventory[p.selectedItem] != null && !p.inventory[p.selectedItem].IsAir)
				? Item(p.inventory[p.selectedItem]) : null;

			string difficulty = p.difficulty switch
			{
				0 => "Softcore",
				1 => "Mediumcore",
				2 => "Hardcore",
				3 => "Journey",
				_ => null
			};

			return new
			{
				name = p.name,
				life = p.statLife,
				lifeMax = p.statLifeMax2,
				mana = p.statMana,
				manaMax = p.statManaMax2,
				// statDefense is a DefenseStat struct since tML 1.4.4 — coerce to the
				// effective int via its implicit conversion (serializing it raw dumps
				// {Positive,Negative,AdditiveBonus,FinalMultiplier} instead of a number).
				defense = (int)p.statDefense,
				difficulty,
				dead = p.dead,
				respawnSec = p.dead ? System.Math.Max(0, p.respawnTimer / 60) : 0,
				deaths = DeathTracker.Get(p.name),
				biome = Biome(p),
				wealth,
				held,
				inventoryCount = invCount,
				equips,
				vanity,
				misc,
				ammo,
				buffs,
				inventory
			};
		}

		// Friendly current-biome label (most specific first).
		private static string Biome(Player p)
		{
			if (p.ZoneDungeon) return "Masmorra";
			if (p.ZoneLihzhardTemple) return "Templo";
			if (p.ZoneCorrupt) return "Corrupção";
			if (p.ZoneCrimson) return "Carmim";
			if (p.ZoneHallow) return "Sagrado";
			if (p.ZoneGlowshroom) return "Cogumelos";
			if (p.ZoneJungle) return "Selva";
			if (p.ZoneSnow) return "Neve";
			if (p.ZoneDesert) return "Deserto";
			if (p.ZoneUnderworldHeight) return "Submundo";
			if (p.ZoneBeach) return "Praia";
			if (p.ZoneGraveyard) return "Cemitério";
			if (p.ZoneMeteor) return "Meteoro";
			if (p.ZoneSkyHeight) return "Espaço";
			if (p.ZoneRockLayerHeight) return "Cavernas";
			if (p.ZoneDirtLayerHeight) return "Subterrâneo";
			return "Superfície";
		}

		// Compact item descriptor: name + prefix + stack + vanilla id (for sprites)
		// + coarse kind (for a category glyph) + rarity int (for the frame colour).
		private static object Item(Item it)
		{
			string prefix = null;
			if (it.prefix > 0 && Lang.prefix != null && it.prefix < Lang.prefix.Length && Lang.prefix[it.prefix] != null)
				prefix = Lang.prefix[it.prefix].Value;

			return new
			{
				id = it.type < ItemID.Count ? it.type : -1, // vanilla only → maps to Item_<id> sprite
				name = it.Name,
				prefix,
				stack = it.stack,
				kind = Kind(it),
				rarity = it.rare,
			};
		}

		// Coarse category so the site can show a recognizable glyph even for modded
		// items (which have no vanilla sprite).
		private static string Kind(Item it)
		{
			if (it.type == ItemID.CopperCoin || it.type == ItemID.SilverCoin
				|| it.type == ItemID.GoldCoin || it.type == ItemID.PlatinumCoin) return "coin";
			if (it.pick > 0 || it.axe > 0 || it.hammer > 0) return "tool";
			if (it.damage > 0 && !it.accessory)
			{
				if (it.CountsAsClass(DamageClass.Melee)) return "melee";
				if (it.CountsAsClass(DamageClass.Ranged)) return "ranged";
				if (it.CountsAsClass(DamageClass.Magic)) return "magic";
				if (it.CountsAsClass(DamageClass.Summon)) return "summon";
				return "weapon";
			}
			if (it.accessory) return "accessory";
			if (it.headSlot >= 0 || it.bodySlot >= 0 || it.legSlot >= 0 || it.defense > 0) return "armor";
			if (it.ammo > 0 && !it.consumable) return "ammo";
			if (it.consumable && (it.buffType > 0 || it.healLife > 0 || it.healMana > 0)) return "potion";
			if (it.createTile >= 0 || it.createWall >= 0) return "block";
			return "material";
		}
	}
}
