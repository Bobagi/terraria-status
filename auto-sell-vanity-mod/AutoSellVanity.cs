using Terraria;
using Terraria.ID;
using Terraria.ModLoader;

namespace AutoSellVanity
{
	// Client-side only: in vanilla the client owns its inventory (the server cannot remove
	// items from it), so the selling has to happen on the player's own game.
	public class AutoSellPlayer : ModPlayer
	{
		private const int ScanEveryTicks = 20;
		private const int MainInventorySlots = 50; // 0-49; 50-53 coins, 54-57 ammo are never touched
		private int timer;

		private static bool IsVanityJunk(Item item) =>
			!item.IsAir && item.vanity && !item.favorited && item.dye == 0;

		// Anything the player already owns when entering the world is favorited, so only
		// items that show up AFTER the mod is running get sold.
		public override void OnEnterWorld()
		{
			int protectedCount = 0;
			for (int i = 0; i < MainInventorySlots; i++)
			{
				Item item = Player.inventory[i];
				if (!item.IsAir && item.vanity && !item.favorited && item.dye == 0)
				{
					item.favorited = true;
					protectedCount++;
				}
			}
			if (protectedCount > 0)
				Main.NewText($"Auto Sell Vanity: {protectedCount} item(ns) de vanity que voce ja tinha foram favoritados (protegidos).", 150, 200, 255);
		}

		public override void PostUpdate()
		{
			if (Player.whoAmI != Main.myPlayer || Main.netMode == NetmodeID.Server) return;
			if (++timer < ScanEveryTicks) return;
			timer = 0;

			long copper = 0;
			int sold = 0;
			for (int i = 0; i < MainInventorySlots; i++)
			{
				Item item = Player.inventory[i];
				if (!IsVanityJunk(item)) continue;
				copper += (long)item.value * item.stack / 5; // vanilla sell price is value / 5
				sold += item.stack;
				item.TurnToAir();
			}
			if (sold == 0) return;

			var source = Player.GetSource_Misc("AutoSellVanity");
			GiveCoins(source, ItemID.PlatinumCoin, ref copper, 1_000_000);
			GiveCoins(source, ItemID.GoldCoin, ref copper, 10_000);
			GiveCoins(source, ItemID.SilverCoin, ref copper, 100);
			GiveCoins(source, ItemID.CopperCoin, ref copper, 1);
			Main.NewText($"Auto Sell Vanity: {sold} item(ns) vendido(s).", 150, 200, 255);
		}

		private void GiveCoins(Terraria.DataStructures.IEntitySource source, int coin, ref long copper, int unit)
		{
			int n = (int)(copper / unit);
			if (n <= 0) return;
			copper -= (long)n * unit;
			Player.QuickSpawnItem(source, coin, n);
		}
	}
}
