using System.ComponentModel;
using Terraria.ModLoader;
using Terraria.ModLoader.Config;

namespace AutoSellVanity
{
	// Shows up in Settings > Mod Configuration > Auto Sell Vanity. The chat command
	// /autosell flips the same switch, so both always agree.
	public class AutoSellConfig : ModConfig
	{
		public override ConfigScope Mode => ConfigScope.ClientSide;

		[DefaultValue(true)]
		public bool Enabled;
	}

	public class AutoSellCommand : ModCommand
	{
		public override CommandType Type => CommandType.Chat;
		public override string Command => "autosell";
		public override string Description => "Liga/desliga a venda automatica de itens de vanity";
		public override string Usage => "/autosell [on|off]";

		public override void Action(CommandCaller caller, string input, string[] args)
		{
			var cfg = ModContent.GetInstance<AutoSellConfig>();
			if (args.Length > 0 && args[0] is "on" or "ligar") cfg.Enabled = true;
			else if (args.Length > 0 && args[0] is "off" or "desligar") cfg.Enabled = false;
			else cfg.Enabled = !cfg.Enabled;
			// ConfigManager.Save is internal in tModLoader, so call it by reflection.
			try
			{
				typeof(ConfigManager).GetMethod("Save", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public,
					null, new[] { typeof(ModConfig) }, null)?.Invoke(null, new object[] { cfg });
			}
			catch (System.Exception) { /* the switch still works for this session */ }
			caller.Reply("Auto Sell Vanity: " + (cfg.Enabled ? "LIGADO" : "DESLIGADO"));
		}
	}
}
