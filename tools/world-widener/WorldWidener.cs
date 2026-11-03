using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using Terraria;
using Terraria.DataStructures;
using Terraria.ID;
using Terraria.IO;
using Terraria.ModLoader;
using Terraria.ModLoader.IO;
using Terraria.WorldBuilding;

namespace WorldWidener
{
	// Temporary tool, run only on a scratch copy of the server. Two sessions:
	//  1. generation session: the real world generator (vanilla + every loaded mod)
	//     builds a world with a custom size (WW_GEN_W x WW_GEN_H) and forced evil,
	//     then "ww hardmode" and "ww export" write the new columns to disk.
	//  2. widen session: the existing world is loaded, "ww import" grows its width
	//     in memory, pastes the exported columns to the right and the server saves it.
	public class GenSize : ModSystem
	{
		public override void PreWorldGen()
		{
			string evil = Environment.GetEnvironmentVariable("WW_GEN_EVIL");
			if (evil == "crimson") WorldGen.WorldGenParam_Evil = 1;
			else if (evil == "corruption") WorldGen.WorldGenParam_Evil = 0;
			Mod.Logger.Info($"WorldWidener: evil param {WorldGen.WorldGenParam_Evil}");

			string w = Environment.GetEnvironmentVariable("WW_GEN_W");
			string h = Environment.GetEnvironmentVariable("WW_GEN_H");
			if (string.IsNullOrEmpty(w) || string.IsNullOrEmpty(h)) return;

			Main.maxTilesX = int.Parse(w);
			Main.maxTilesY = int.Parse(h);
			WorldGen.setWorldSize();
			Main.sectionManager = new WorldSections((Main.maxTilesX - 1) / Main.sectionWidth + 1, (Main.maxTilesY - 1) / Main.sectionHeight + 1);
			Mod.Logger.Info($"WorldWidener: generating {Main.maxTilesX}x{Main.maxTilesY}");
		}
	}

	public class WidenCommand : ModCommand
	{
		public override CommandType Type => CommandType.Console;
		public override string Command => "ww";
		public override string Usage => "ww info <out.json> | ww dump <out.bin> | ww hardmode <cobalt> <mythril> <adamantite> <smashes> | ww export <dir> <x0> | ww import <dir> <newWidth> | ww swapores <x0> <from:to,...>";

		public override void Action(CommandCaller caller, string input, string[] args)
		{
			try {
				switch (args.Length > 0 ? args[0] : "") {
					case "info": Info(args[1]); break;
					case "dump": Dump(args[1]); break;
					case "hardmode": Hardmode(int.Parse(args[1]), int.Parse(args[2]), int.Parse(args[3]), int.Parse(args[4])); break;
					case "export": Export(args[1], int.Parse(args[2])); break;
					case "import": Import(args[1], int.Parse(args[2])); break;
					case "swapores": SwapOres(int.Parse(args[1]), args[2]); break;
					default: caller.Reply(Usage); return;
				}
				caller.Reply("ww " + args[0] + ": ok");
			}
			catch (Exception e) {
				caller.Reply("ww erro: " + e);
				Mod.Logger.Error("ww failed", e);
			}
		}

		// ---------- info / dump (read only) ----------

		static void Info(string path)
		{
			var sb = new StringBuilder();
			sb.Append('{');
			void Kv(string k, object v) => sb.Append('"').Append(k).Append("\":").Append(v is string s ? "\"" + s.Replace("\"", "'") + "\"" : Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture).ToLowerInvariant()).Append(',');
			Kv("maxTilesX", Main.maxTilesX);
			Kv("maxTilesY", Main.maxTilesY);
			Kv("worldSurface", Main.worldSurface);
			Kv("rockLayer", Main.rockLayer);
			Kv("dungeonX", Main.dungeonX);
			Kv("dungeonY", Main.dungeonY);
			Kv("spawnTileX", Main.spawnTileX);
			Kv("spawnTileY", Main.spawnTileY);
			Kv("crimson", WorldGen.crimson);
			Kv("hardMode", Main.hardMode);
			Kv("altarCount", WorldGen.altarCount);
			Kv("oreCopper", WorldGen.SavedOreTiers.Copper);
			Kv("oreIron", WorldGen.SavedOreTiers.Iron);
			Kv("oreSilver", WorldGen.SavedOreTiers.Silver);
			Kv("oreGold", WorldGen.SavedOreTiers.Gold);
			Kv("oreCobalt", WorldGen.SavedOreTiers.Cobalt);
			Kv("oreMythril", WorldGen.SavedOreTiers.Mythril);
			Kv("oreAdamantite", WorldGen.SavedOreTiers.Adamantite);
			Kv("tileCount", TileLoader.TileCount);
			Kv("wallCount", WallLoader.WallCount);
			Kv("treeX", string.Join(" ", Main.treeX));
			Kv("caveBackX", string.Join(" ", Main.caveBackX));

			sb.Append("\"chests\":[");
			sb.Append(string.Join(",", Main.chest.Where(c => c != null).Select(c =>
				$"{{\"x\":{c.x},\"y\":{c.y},\"items\":{c.item.Count(i => i != null && !i.IsAir)},\"name\":\"{(c.name ?? "").Replace("\"", "'")}\"}}")));
			sb.Append("],\"signs\":[");
			sb.Append(string.Join(",", Main.sign.Where(s => s != null).Select(s => $"{{\"x\":{s.x},\"y\":{s.y}}}")));
			sb.Append("],\"tileEntities\":[");
			sb.Append(string.Join(",", TileEntity.ByID.Values.Select(t =>
				$"{{\"x\":{t.Position.X},\"y\":{t.Position.Y},\"type\":\"{t.GetType().FullName}\"}}")));
			sb.Append("],\"townNPCs\":[");
			sb.Append(string.Join(",", Main.npc.Where(n => n.active && n.townNPC).Select(n =>
				$"{{\"type\":{n.type},\"name\":\"{n.FullName.Replace("\"", "'")}\",\"homeX\":{n.homeTileX},\"homeY\":{n.homeTileY},\"homeless\":{n.homeless.ToString().ToLowerInvariant()},\"x\":{(int)(n.position.X / 16)},\"y\":{(int)(n.position.Y / 16)}}}")));
			sb.Append("],\"modTiles\":{");
			sb.Append(string.Join(",", Enumerable.Range(TileID.Count, TileLoader.TileCount - TileID.Count).Select(t => $"\"{t}\":\"{TileLoader.GetTile(t).FullName}\"")));
			sb.Append("},\"modWalls\":{");
			sb.Append(string.Join(",", Enumerable.Range(WallID.Count, WallLoader.WallCount - WallID.Count).Select(t => $"\"{t}\":\"{WallLoader.GetWall(t).FullName}\"")));
			sb.Append("}}");
			File.WriteAllText(path, sb.ToString());
		}

		// Compact grid for rendering and analysis outside the game:
		// header int32 width, int32 height, then per tile (x-major):
		// uint16 tile (0xFFFF = empty), uint16 wall, uint8 liquid amount, uint8 liquid type.
		static void Dump(string path)
		{
			using var w = new BinaryWriter(File.Create(path));
			w.Write(Main.maxTilesX);
			w.Write(Main.maxTilesY);
			for (int x = 0; x < Main.maxTilesX; x++) {
				for (int y = 0; y < Main.maxTilesY; y++) {
					Tile t = Main.tile[x, y];
					w.Write(t.HasTile ? t.TileType : (ushort)0xFFFF);
					w.Write(t.WallType);
					w.Write(t.LiquidAmount);
					w.Write((byte)t.LiquidType);
				}
			}
		}

		// ---------- generation session ----------

		// Turns the freshly generated world into Hardmode the same way defeating the
		// Wall of Flesh does (hallow and evil stripes), then grows Hardmode ores the
		// same way smashing altars does, with the existing world's ore choices.
		static void Hardmode(int cobalt, int mythril, int adamantite, int smashes)
		{
			if (!Main.hardMode) {
				WorldGen.smCallBack(null);
				Main.hardMode = true;
			}
			WorldGen.SavedOreTiers.Cobalt = cobalt;
			WorldGen.SavedOreTiers.Mythril = mythril;
			WorldGen.SavedOreTiers.Adamantite = adamantite;
			WorldGen.altarCount = 0;
			for (int i = 0; i < smashes; i++)
				WorldGen.SmashAltar(Main.maxTilesX / 2, Main.maxTilesY / 2);
		}

		static int StructSize<T>() where T : unmanaged => Unsafe.SizeOf<T>();

		static void WriteStruct<T>(BinaryWriter w, ref T value) where T : unmanaged
		{
			w.Write(MemoryMarshal.AsBytes(MemoryMarshal.CreateSpan(ref value, 1)));
		}

		static void ReadStruct<T>(BinaryReader r, ref T value) where T : unmanaged
		{
			Span<byte> dst = MemoryMarshal.AsBytes(MemoryMarshal.CreateSpan(ref value, 1));
			int read = r.Read(dst);
			if (read != dst.Length) throw new EndOfStreamException();
		}

		static string Layout() =>
			$"{StructSize<TileTypeData>()},{StructSize<WallTypeData>()},{StructSize<LiquidData>()},{StructSize<TileWallWireStateData>()},{StructSize<TileWallBrightnessInvisibilityData>()}";

		static string TypeTable() =>
			string.Join("|", Enumerable.Range(TileID.Count, TileLoader.TileCount - TileID.Count).Select(t => TileLoader.GetTile(t).FullName))
			+ "#" + string.Join("|", Enumerable.Range(WallID.Count, WallLoader.WallCount - WallID.Count).Select(t => WallLoader.GetWall(t).FullName));

		static void Export(string dir, int x0)
		{
			Directory.CreateDirectory(dir);
			using (var w = new BinaryWriter(File.Create(Path.Combine(dir, "tiles.bin")))) {
				for (int x = x0; x < Main.maxTilesX; x++) {
					for (int y = 0; y < Main.maxTilesY; y++) {
						Tile t = Main.tile[x, y];
						WriteStruct(w, ref t.Get<TileTypeData>());
						WriteStruct(w, ref t.Get<WallTypeData>());
						WriteStruct(w, ref t.Get<LiquidData>());
						WriteStruct(w, ref t.Get<TileWallWireStateData>());
						WriteStruct(w, ref t.Get<TileWallBrightnessInvisibilityData>());
					}
				}
			}

			var chests = new List<TagCompound>();
			foreach (Chest c in Main.chest) {
				if (c == null || c.x < x0) continue;
				chests.Add(new TagCompound {
					["x"] = c.x, ["y"] = c.y, ["name"] = c.name ?? "",
					["items"] = c.item.Select(i => i == null ? new TagCompound() : ItemIO.Save(i)).ToList(),
				});
			}
			var signs = new List<TagCompound>();
			foreach (Sign s in Main.sign) {
				if (s == null || s.x < x0) continue;
				signs.Add(new TagCompound { ["x"] = s.x, ["y"] = s.y, ["text"] = s.text ?? "" });
			}
			int tileEntities = TileEntity.ByID.Values.Count(t => t.Position.X >= x0);

			TagIO.ToFile(new TagCompound {
				["x0"] = x0, ["width"] = Main.maxTilesX, ["height"] = Main.maxTilesY,
				["layout"] = Layout(), ["types"] = TypeTable(),
				["worldSurface"] = Main.worldSurface, ["rockLayer"] = Main.rockLayer,
				["chests"] = chests, ["signs"] = signs, ["tileEntities"] = tileEntities,
			}, Path.Combine(dir, "meta.nbt"));

			ModContent.GetInstance<WorldWidener>().Logger.Info($"export: x {x0}..{Main.maxTilesX}, {chests.Count} chests, {signs.Count} signs, {tileEntities} tile entities (not exported)");
		}

		// ---------- widen session ----------

		static bool IsSurfaceSolid(Tile t) =>
			t.HasTile && Main.tileSolid[t.TileType] && !Main.tileSolidTop[t.TileType] && !TileID.Sets.Platforms[t.TileType];

		// Top of the ground in a column: first solid tile with solid ground under it,
		// so floating islands and lone blocks in the sky don't count. Water counts as
		// ground too, so the ocean surface is found instead of the sea floor.
		static int SurfaceY(int x, int fromY)
		{
			for (int y = fromY; y < Main.maxTilesY - 60; y++) {
				Tile t = Main.tile[x, y];
				if (t.LiquidAmount > 0 && !t.HasTile) {
					int water = 0;
					for (int k = 0; k < 20; k++) if (Main.tile[x, y + k].LiquidAmount > 0 || IsSurfaceSolid(Main.tile[x, y + k])) water++;
					if (water >= 18) return y;
				}
				if (!IsSurfaceSolid(t)) continue;
				int solid = 0;
				for (int k = 0; k < 60; k++) if (IsSurfaceSolid(Main.tile[x, y + k])) solid++;
				if (solid >= 45) return y;
			}
			return (int)Main.worldSurface;
		}

		static bool IsLooseObject(Tile t) =>
			t.HasTile && !TileID.Sets.BasicChest[t.TileType] && (Main.tileFrameImportant[t.TileType] || t.TileType == TileID.Trees || t.TileType == TileID.PalmTree
				|| TileID.Sets.IsATreeTrunk[t.TileType] || t.TileType == TileID.Plants || t.TileType == TileID.Vines);

		static void ClearTile(int x, int y, bool wall)
		{
			Tile t = Main.tile[x, y];
			t.HasTile = false;
			t.TileType = 0;
			t.LiquidAmount = 0;
			if (wall) t.WallType = 0;
		}

		// Column whose ground is water at the surface (open sea), looking from the sky down.
		static bool IsSeaColumn(int x, int skyFrom)
		{
			for (int y = skyFrom; y < Main.worldSurface + 50; y++) {
				Tile t = Main.tile[x, y];
				if (t.LiquidAmount > 0 && t.LiquidType == LiquidID.Water) return true;
				if (IsSurfaceSolid(t)) return false;
			}
			return false;
		}

		// Every world rolls one ore of each pair. Columns x0.. get the other one of each
		// pair, so the merged world has all of them. Veins keep their shape and place.
		static void SwapOres(int x0, string map)
		{
			var swap = map.Split(',').Select(p => p.Split(':')).ToDictionary(p => ushort.Parse(p[0]), p => ushort.Parse(p[1]));
			var counts = swap.Keys.ToDictionary(k => k, k => 0);
			for (int x = x0; x < Main.maxTilesX; x++)
				for (int y = 0; y < Main.maxTilesY; y++) {
					Tile t = Main.tile[x, y];
					if (t.HasTile && swap.TryGetValue(t.TileType, out ushort to)) { counts[t.TileType]++; t.TileType = to; }
				}
			ModContent.GetInstance<WorldWidener>().Logger.Info("swapores: " + string.Join(", ", counts.Select(kv => $"{kv.Key}->{swap[kv.Key]}: {kv.Value}")));
		}

		static void CopyColumn(int from, int to)
		{
			for (int y = 0; y < Main.maxTilesY; y++) {
				Tile dst = Main.tile[to, y];
				dst.CopyFrom(Main.tile[from, y]);
				if (IsLooseObject(dst)) ClearTile(to, y, false);
			}
		}

		static void Import(string dir, int newWidth)
		{
			var log = ModContent.GetInstance<WorldWidener>().Logger;
			var meta = TagIO.FromFile(Path.Combine(dir, "meta.nbt"));
			int x0 = meta.GetInt("x0");
			int genWidth = meta.GetInt("width");
			int height = meta.GetInt("height");
			int oldWidth = Main.maxTilesX;
			int offset = oldWidth;
			if (x0 != 0) throw new Exception("export must start at column 0 (the whole generated world)");
			if (oldWidth + genWidth != newWidth) throw new Exception($"{oldWidth} + {genWidth} != {newWidth}");
			if (height != Main.maxTilesY) throw new Exception($"export height {height} != world height {Main.maxTilesY}");
			if (meta.GetString("layout") != Layout()) throw new Exception("tile data layout differs between sessions");
			if (meta.GetString("types") != TypeTable()) throw new Exception("modded tile/wall ids differ between sessions");
			if (newWidth > Main.tile.Width) throw new Exception($"tilemap capacity {Main.tile.Width} < {newWidth}");

			int skyFrom = (int)(Main.worldSurface * 0.35);
			// Grow the world and paste the whole generated world to the right.
			Main.maxTilesX = newWidth;
			WorldGen.setWorldSize();
			Main.sectionManager = new WorldSections((Main.maxTilesX - 1) / Main.sectionWidth + 1, (Main.maxTilesY - 1) / Main.sectionHeight + 1);

			using (var r = new BinaryReader(File.OpenRead(Path.Combine(dir, "tiles.bin")))) {
				for (int x = offset; x < newWidth; x++) {
					for (int y = 0; y < height; y++) {
						Tile t = Main.tile[x, y];
						ReadStruct(r, ref t.Get<TileTypeData>());
						ReadStruct(r, ref t.Get<WallTypeData>());
						ReadStruct(r, ref t.Get<LiquidData>());
						ReadStruct(r, ref t.Get<TileWallWireStateData>());
						ReadStruct(r, ref t.Get<TileWallBrightnessInvisibilityData>());
					}
				}
				if (r.BaseStream.Position != r.BaseStream.Length) throw new Exception("tiles.bin has trailing data");
			}

			int chests = 0, signs = 0;
			foreach (var c in meta.GetList<TagCompound>("chests")) {
				int cx = c.GetInt("x") + offset, cy = c.GetInt("y");
				int idx = Chest.CreateChest(cx, cy);
				if (idx < 0) { log.Warn($"no free chest slot for {cx},{cy}"); continue; }
				Main.chest[idx].name = c.GetString("name");
				var items = c.GetList<TagCompound>("items").ToList();
				for (int k = 0; k < items.Count && k < Main.chest[idx].item.Length; k++)
					Main.chest[idx].item[k] = items[k].Count == 0 ? new Item() : ItemIO.Load(items[k]);
				chests++;
			}
			foreach (var s in meta.GetList<TagCompound>("signs")) {
				int idx = Sign.ReadSign(s.GetInt("x") + offset, s.GetInt("y"), true);
				if (idx >= 0) { Sign.TextSign(idx, s.GetString("text")); signs++; }
			}

			// Each world's outermost columns are the hidden border, the generator leaves a
			// solid wall there. Now they sit in the middle of the map: replace them with
			// the neighbouring column.
			CopyColumn(offset + 3, offset);
			CopyColumn(offset + 3, offset + 1);
			CopyColumn(offset + 3, offset + 2);
			CopyColumn(oldWidth - 4, oldWidth - 1);
			CopyColumn(oldWidth - 4, oldWidth - 2);

			// The old right ocean and the new left ocean now touch in the middle of the
			// map, where the game no longer treats them as ocean. Fill both seas with
			// ground, from one shore to the other: grass on top, dirt down to the old sea
			// floor. Caves under the sea floor are left alone.
			int oldSea = oldWidth - 1;
			while (oldSea > oldWidth - 700 && IsSeaColumn(oldSea - 1, skyFrom)) oldSea--;
			int newSeaTo = offset;
			while (newSeaTo < offset + 700 && IsSeaColumn(newSeaTo, skyFrom)) newSeaTo++;
			if (oldSea > oldWidth - 50 || newSeaTo < offset + 50) throw new Exception($"sea not found: old from {oldSea}, new to {newSeaTo}");

			int bridgeFrom = oldSea - 8, bridgeTo = newSeaTo + 8;
			int a = SurfaceY(bridgeFrom - 1, skyFrom), b = SurfaceY(bridgeTo, skyFrom);
			// Sea chests would end up buried or floating: lift them out now and set them
			// back down on the new ground afterwards, same column, same items.
			var lifted = new List<(int id, ushort type, int style)>();
			for (int i = 0; i < Main.maxChests; i++) {
				Chest c = Main.chest[i];
				if (c == null || c.x < bridgeFrom - 1 || c.x >= bridgeTo || c.y > Main.worldSurface + 150) continue;
				Tile tl = Main.tile[c.x, c.y];
				if (!tl.HasTile || !TileID.Sets.BasicChest[tl.TileType]) continue;
				lifted.Add((i, tl.TileType, tl.TileFrameX / 36));
				for (int dx = 0; dx < 2; dx++) for (int dy = 0; dy < 2; dy++) ClearTile(c.x + dx, c.y + dy, false);
			}

			var groundAt = new int[bridgeTo - bridgeFrom];
			int filled = 0;
			for (int x = bridgeFrom; x < bridgeTo; x++) {
				double t = (double)(x - bridgeFrom) / (bridgeTo - bridgeFrom);
				double sm = t * t * (3 - 2 * t);
				int ground = (int)Math.Round(a + (b - a) * sm);
				groundAt[x - bridgeFrom] = ground;
				for (int y = 0; y < ground; y++) {
					Tile f = Main.tile[x, y];
					if (f.HasTile || f.LiquidAmount > 0) ClearTile(x, y, true);
				}
				for (int y = ground; y < Main.worldSurface + 150; y++) {
					Tile f = Main.tile[x, y];
					if (y > ground + 6 && IsSurfaceSolid(f)) break; // sea floor reached
					if (f.HasTile && !IsSurfaceSolid(f)) ClearTile(x, y, false);
					f.LiquidAmount = 0;
					f.HasTile = true;
					f.Slope = SlopeType.Solid;
					f.IsHalfBlock = false;
					f.TileType = y == ground ? TileID.Grass : TileID.Dirt;
					if (y > ground + 8) f.WallType = WallID.DirtUnsafe;
					filled++;
				}
			}
			// Trees and grass on the new ground, grown with the game's own functions.
			var rnd = WorldGen.genRand;
			for (int x = bridgeFrom + 4; x < bridgeTo - 4; x += rnd.Next(5, 12)) {
				int g = groundAt[x - bridgeFrom];
				if (Main.tile[x, g].TileType == TileID.Grass) WorldGen.GrowTree(x, g);
			}
			for (int x = bridgeFrom; x < bridgeTo; x++) {
				int g = groundAt[x - bridgeFrom];
				if (!Main.tile[x, g - 1].HasTile && Main.tile[x, g].TileType == TileID.Grass && rnd.NextDouble() < 0.5)
					WorldGen.PlaceTile(x, g - 1, TileID.Plants, true, false, -1, rnd.Next(0, 11));
			}

			foreach (var (id, type, style) in lifted) {
				Chest c = Main.chest[id];
				int cx = Math.Clamp(c.x, bridgeFrom, bridgeTo - 2);
				int g0 = groundAt[cx - bridgeFrom], g1 = groundAt[cx + 1 - bridgeFrom];
				int top = Math.Min(g0, g1) - 2;
				for (int dx = 0; dx < 2; dx++) {
					int gx = cx + dx, g = dx == 0 ? g0 : g1;
					for (int y = top + 2; y < g; y++) { Tile f = Main.tile[gx, y]; f.HasTile = true; f.TileType = TileID.Dirt; f.Slope = SlopeType.Solid; f.IsHalfBlock = false; }
					for (int dy = 0; dy < 2; dy++) {
						Tile f = Main.tile[gx, top + dy];
						f.ClearEverything();
						f.HasTile = true;
						f.TileType = type;
						f.TileFrameX = (short)(style * 36 + dx * 18);
						f.TileFrameY = (short)(dy * 18);
					}
					Tile under = Main.tile[gx, top + 2];
					under.Slope = SlopeType.Solid; under.IsHalfBlock = false;
				}
				c.x = cx; c.y = top;
				log.Info($"sea chest {id} moved onto the new ground at {cx},{top}");
			}

			// Underground the two worlds meet on a straight vertical line. Run the
			// generator's own blob and cave tools along it so the seam looks generated.
			var rand = WorldGen.genRand;
			for (int y = (int)Main.worldSurface - 20; y < Main.maxTilesY - 12; y += 7) {
				int x = offset + rand.Next(-12, 13);
				ushort fillType = y < Main.rockLayer ? TileID.Dirt : y < Main.maxTilesY - 200 ? TileID.Stone : TileID.Ash;
				WorldGen.TileRunner(x, y, rand.Next(8, 16), rand.Next(10, 30), fillType);
				if (rand.NextDouble() < 0.65)
					WorldGen.TileRunner(offset + rand.Next(-20, 21), y + rand.Next(-4, 5), rand.Next(5, 12), rand.Next(15, 45), -1);
				if (y > Main.rockLayer && rand.NextDouble() < 0.35)
					WorldGen.TileRunner(offset + rand.Next(-20, 21), y, rand.Next(4, 8), rand.Next(6, 14), y < Main.maxTilesY - 200 ? TileID.Dirt : TileID.Hellstone);
			}
			for (int x = offset - 40; x < offset + 40; x++)
				for (int y = (int)Main.worldSurface - 40; y < Main.maxTilesY; y++)
					if (IsLooseObject(Main.tile[x, y])) ClearTile(x, y, false);

			for (int x = bridgeFrom - 10; x < bridgeTo + 10; x++)
				for (int y = 0; y < Main.worldSurface + 40; y++)
					if (IsLooseObject(Main.tile[x, y]) && (x < bridgeFrom + 2 || x >= bridgeTo - 2)) ClearTile(x, y, false);

			for (int x = bridgeFrom - 12; x < bridgeTo + 12; x++)
				for (int y = 1; y < Main.maxTilesY - 1; y++) {
					WorldGen.TileFrame(x, y, true, true);
					Framing.WallFrame(x, y, true);
				}

			int oldSeaFrom = oldSea, oldShore = a, newShore = b;
			log.Info($"import: width {oldWidth} -> {newWidth}; old sea {oldSeaFrom}..{oldWidth} (shore y {oldShore}); new sea {offset}..{newSeaTo} (shore y {newShore}); land bridge {bridgeFrom}..{bridgeTo} ({filled} tiles filled, {lifted.Count} sea chests moved); {chests} chests, {signs} signs");
		}
	}

	public class WorldWidener : Mod { }
}
