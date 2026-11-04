using System;
using System.Collections.Generic;
using System.Linq;
using Terraria.Localization;
using Terraria.ModLoader;

namespace StatusExport
{
	// Bosses, minibosses and events added by other mods (Fargo's Souls and friends),
	// read from Boss Checklist's public API so any mod that registers there shows up
	// on the site with no code here. Vanilla entries are kept apart: most of the vanilla
	// list comes from NPC flags in StatusExport.cs, and only what vanilla never tracks
	// (moon events, Flying Dutchman, Martian Saucer) is read here, see VanillaDowned.
	public static class ModBosses
	{
		private static List<Dictionary<string, object>> _entries;
		private static Dictionary<string, Dictionary<string, object>> _all;
		private static bool _failed;

		private static bool Load()
		{
			if (_failed) return false;
			if (_entries != null) return true;
			if (!ModLoader.TryGetMod("BossChecklist", out Mod checklist)) { _failed = true; return false; }
			var mod = ModContent.GetInstance<StatusExport>();
			if (checklist.Call("GetBossInfoDictionary", mod, "2.0") is not Dictionary<string, Dictionary<string, object>> all) return false;
			_all = all;
			_entries = all.Values.Where(e => e.TryGetValue("modSource", out var src) && src as string != "Terraria").ToList();
			return true;
		}

		// Boss Checklist's own flag for a vanilla entry, e.g. "Terraria BloodMoon".
		// False when Boss Checklist is missing or has no such entry.
		public static bool VanillaDowned(string key)
		{
			try { return Load() && _all.TryGetValue(key, out var e) && SafeDowned(e); }
			catch { return false; }
		}

		public static List<object> Snapshot()
		{
			if (_failed) return null;
			try {
				if (!Load()) return null;
				return _entries
					.OrderBy(e => Convert.ToSingle(e["progression"]))
					.Select(e => (object)new {
						key = e["key"] as string,
						mod = e["modSource"] as string,
						name = (e["displayName"] as LocalizedText)?.Value ?? e["key"] as string,
						kind = (bool)e["isEvent"] ? "event" : (bool)e["isMiniboss"] ? "miniboss" : "boss",
						progression = Convert.ToSingle(e["progression"]),
						downed = SafeDowned(e),
						head = HeadTexture(e),
					})
					.ToList();
			}
			catch (Exception ex) {
				_failed = true;
				ModContent.GetInstance<StatusExport>().Logger.Warn("StatusExport: Boss Checklist read failed, mod bosses disabled: " + ex.Message);
				return null;
			}
		}

		private static bool SafeDowned(Dictionary<string, object> e)
		{
			try { return e["downed"] is Func<bool> f && f(); }
			catch { return false; }
		}

		// Map-head texture path of the entry's first modded NPC, e.g.
		// "FargowiltasSouls/Content/Bosses/MutantBoss/MutantBoss_Head_Boss". The site
		// only uses it to look up an icon it extracted itself; it never fetches it.
		private static string HeadTexture(Dictionary<string, object> e)
		{
			if (e["npcIDs"] is not List<int> ids) return null;
			foreach (int id in ids) {
				var npc = NPCLoader.GetNPC(id);
				if (npc != null) return npc.BossHeadTexture;
			}
			return null;
		}
	}
}
