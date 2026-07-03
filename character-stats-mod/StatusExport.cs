using System.IO;
using System.Linq;
using Newtonsoft.Json;              // ships with tModLoader
using Terraria;
using Terraria.ID;
using Terraria.ModLoader;

namespace StatusExport
{
	// Server-side (side = Server in build.txt) mod: every few seconds it writes a
	// JSON snapshot of the online players' character stats to the save directory,
	// so the terraria-status web page can show them in its player modal.
	//
	// Because it is side = Server, PLAYERS DO NOT NEED THIS MOD — it does not
	// change the required modlist and nobody gets kicked for not having it.
	//
	// It reads only data the server already receives for multiplayer sync
	// (life/mana/defense, equipped items, inventory, buffs). It writes nothing to
	// gameplay and adds no content.
	public class StatusExport : Mod { }

	public class StatsExporterSystem : ModSystem
	{
		private const int IntervalTicks = 180; // ~3 s at 60 fps
		private int _tick;
		private bool _loggedOk, _loggedErr;

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
					players
				};

				// Main.SavePath is the tModLoader save dir (e.g. /data/tModLoader in
				// the Docker image), which is exactly where the site reads from.
				string tmp = Path.Combine(Main.SavePath, "playerstats.json.tmp");
				string dst = Path.Combine(Main.SavePath, "playerstats.json");
				File.WriteAllText(tmp, JsonConvert.SerializeObject(payload));
				File.Copy(tmp, dst, true);   // near-atomic replace so the reader never sees a half file
				File.Delete(tmp);
				if (!_loggedOk) { Mod.Logger.Info($"StatusExport: writing {players.Count} player(s) to {dst}"); _loggedOk = true; }
			}
			catch (System.Exception e)
			{
				// Log once so a real problem is diagnosable, but never destabilize the server.
				if (!_loggedErr) { Mod.Logger.Warn("StatusExport export failed: " + e); _loggedErr = true; }
			}
		}

		private static object BuildPlayer(Player p)
		{
			// Equipped: armor[0..2] = head/body/legs, [3..9] = accessories.
			var equips = new System.Collections.Generic.List<object>();
			for (int i = 0; i <= 9 && i < p.armor.Length; i++)
			{
				var it = p.armor[i];
				if (it != null && !it.IsAir)
					equips.Add(new { name = it.AffixName() });
			}

			// Main inventory (slots 0..49): visible loadout highlights.
			var inventory = new System.Collections.Generic.List<object>();
			int invCount = 0;
			for (int i = 0; i < 50 && i < p.inventory.Length; i++)
			{
				var it = p.inventory[i];
				if (it == null || it.IsAir) continue;
				invCount++;
				if (inventory.Count < 40)
					inventory.Add(new { name = it.Name, stack = it.stack });
			}

			// Active buffs.
			var buffs = new System.Collections.Generic.List<string>();
			for (int i = 0; i < p.buffType.Length; i++)
			{
				if (p.buffType[i] > 0 && p.buffTime[i] > 0)
					buffs.Add(Lang.GetBuffName(p.buffType[i]));
			}

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
				inventoryCount = invCount,
				equips,
				buffs,
				inventory
			};
		}
	}
}
