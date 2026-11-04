using Terraria;
using Terraria.GameContent.Bestiary;
using Terraria.ID;
using Terraria.ModLoader;
using Terraria.ModLoader.IO;

namespace StatusExport
{
	// Eater of Worlds and Brain of Cthulhu share one vanilla flag (NPC.downedBoss2), and
	// Boss Checklist reuses it for both. The widened world has Corruption AND Crimson, so
	// the site wants each one on its own: this system records each kill and saves it with
	// the world. Kills from before it existed come from the world's bestiary kill counts.
	public class EvilBosses : ModSystem
	{
		private static bool _eater, _brain;

		public static bool Eater => _eater || (NPC.downedBoss2 && Kills(NPCID.EaterofWorldsHead) > 0);
		public static bool Brain => _brain || (NPC.downedBoss2 && Kills(NPCID.BrainofCthulhu) > 0);

		private static int Kills(int npcId)
		{
			try {
				return ContentSamples.NpcBestiaryCreditIdsByNpcNetIds.TryGetValue(npcId, out string id)
					? Main.BestiaryTracker.Kills.GetKillCount(id) : 0;
			}
			catch { return 0; }
		}

		internal static void Downed(NPC npc)
		{
			if (npc.type == NPCID.BrainofCthulhu) { _brain = true; return; }
			if (npc.type < NPCID.EaterofWorldsHead || npc.type > NPCID.EaterofWorldsTail) return;
			// The worm dies one segment at a time; the boss is down when no other segment is left.
			foreach (NPC other in Main.ActiveNPCs) {
				if (other.whoAmI != npc.whoAmI && other.type >= NPCID.EaterofWorldsHead && other.type <= NPCID.EaterofWorldsTail) return;
			}
			_eater = true;
		}

		public override void ClearWorld() { _eater = _brain = false; }

		public override void SaveWorldData(TagCompound tag)
		{
			if (Eater) tag["eater"] = true;
			if (Brain) tag["brain"] = true;
		}

		public override void LoadWorldData(TagCompound tag)
		{
			_eater = tag.GetBool("eater");
			_brain = tag.GetBool("brain");
		}
	}

	public class EvilBossKills : GlobalNPC
	{
		public override void OnKill(NPC npc) => EvilBosses.Downed(npc);
	}
}
