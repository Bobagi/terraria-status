using Terraria;
using Terraria.ModLoader;

namespace StatusExport
{
	// Multiplies natural enemy spawns on the whole server. spawnRate is the average number of
	// ticks between spawn attempts (lower = more often) and maxSpawns is the cap of enemies
	// around each player, so both are scaled: dividing only the rate would hit the cap quickly
	// and change little. Spawning happens on the server, so players need nothing installed.
	public class SpawnRate : GlobalNPC
	{
		public const int Default = 3;
		public static int Multiplier = Default;

		public override void EditSpawnRate(Player player, ref int spawnRate, ref int maxSpawns)
		{
			if (Multiplier == 1)
				return;
			spawnRate = System.Math.Max(1, spawnRate / Multiplier);
			maxSpawns *= Multiplier;
		}
	}

	public class SpawnRateCommand : AdminCommand
	{
		public override string Command => "spawnrate";
		public override string Usage => "spawnrate [1-10]";
		public override string Description => "Mostra ou muda o multiplicador de spawn de inimigos (padrao 3, volta ao padrao no restart)";

		protected override void Execute(CommandCaller caller, string[] args)
		{
			if (args.Length > 0)
			{
				if (!int.TryParse(args[0], out int m) || m < 1 || m > 10)
					throw new AdminError("uso: " + Usage);
				SpawnRate.Multiplier = m;
			}
			caller.Reply("spawnrate " + SpawnRate.Multiplier + "x");
		}
	}
}
