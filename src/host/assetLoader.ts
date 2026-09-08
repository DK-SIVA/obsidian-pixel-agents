import { PNG } from 'pngjs';
import { ASSET_PNG_BASE64, ASSET_TEXT } from '../assets/assetData.js';

// PNG / Asset Parsing constants
const PNG_ALPHA_THRESHOLD = 128;
const WALL_PIECE_WIDTH = 16;
const WALL_PIECE_HEIGHT = 32;
const WALL_GRID_COLS = 4;
const WALL_BITMASK_COUNT = 16;
const FLOOR_PATTERN_COUNT = 7;
const FLOOR_TILE_SIZE = 16;
const CHARACTER_DIRECTIONS = ['down', 'up', 'right'] as const;
const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;
const CHAR_FRAMES_PER_ROW = 7;
const CHAR_COUNT = 6;

export interface FurnitureAsset {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  partOfGroup?: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
}

export interface LoadedAssets {
  catalog: FurnitureAsset[];
  sprites: Record<string, string[][]>;
}

export interface LoadedWallTiles {
  sprites: string[][][];
}

export interface LoadedFloorTiles {
  sprites: string[][][];
}

export interface CharacterDirectionSprites {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

export interface LoadedCharacterSprites {
  characters: CharacterDirectionSprites[];
}

/**
 * The desktop app read these files from disk next to the executable. A BRAT
 * release is only main.js + manifest.json + styles.css, so the same bytes are
 * baked into the bundle instead (see scripts/gen-assets.mjs). Decoding still
 * goes through pngjs, so the sprite data handed to the UI is exactly what the
 * Electron version produced.
 */
function hasAsset(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(ASSET_PNG_BASE64, key);
}

function readAsset(key: string): Buffer {
  return Buffer.from(ASSET_PNG_BASE64[key], 'base64');
}

function pixelToHex(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
}

function pngToSpriteData(pngBuffer: Buffer, width: number, height: number): string[][] {
  try {
    const png = PNG.sync.read(pngBuffer);
    const sprite: string[][] = [];
    const data = png.data;

    for (let y = 0; y < height; y++) {
      const row: string[] = [];
      for (let x = 0; x < width; x++) {
        const idx = (y * png.width + x) * 4;
        const a = data[idx + 3];
        if (a < PNG_ALPHA_THRESHOLD) {
          row.push('');
        } else {
          row.push(pixelToHex(data[idx], data[idx + 1], data[idx + 2]));
        }
      }
      sprite.push(row);
    }
    return sprite;
  } catch (err) {
    console.warn(`Failed to parse PNG: ${err instanceof Error ? err.message : err}`);
    const sprite: string[][] = [];
    for (let y = 0; y < height; y++) {
      sprite.push(new Array(width).fill(''));
    }
    return sprite;
  }
}

/**
 * Load pre-colored character sprites (6 sheets, each 112x96).
 * Each sheet has 3 direction rows (down, up, right) x 7 frames (16x32 each).
 */
export function loadCharacterSprites(): LoadedCharacterSprites | null {
  try {
    const characters: CharacterDirectionSprites[] = [];

    for (let ci = 0; ci < CHAR_COUNT; ci++) {
      const key = `characters/char_${ci}.png`;
      if (!hasAsset(key)) {
        console.log(`[AssetLoader] No character sprite embedded for: ${key}`);
        return null;
      }

      const png = PNG.sync.read(readAsset(key));
      const charData: CharacterDirectionSprites = { down: [], up: [], right: [] };

      for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx++) {
        const dir = CHARACTER_DIRECTIONS[dirIdx];
        const rowOffsetY = dirIdx * CHAR_FRAME_H;
        const frames: string[][][] = [];

        for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
          const sprite: string[][] = [];
          const frameOffsetX = f * CHAR_FRAME_W;
          for (let y = 0; y < CHAR_FRAME_H; y++) {
            const row: string[] = [];
            for (let x = 0; x < CHAR_FRAME_W; x++) {
              const idx = ((rowOffsetY + y) * png.width + (frameOffsetX + x)) * 4;
              const a = png.data[idx + 3];
              if (a < PNG_ALPHA_THRESHOLD) {
                row.push('');
              } else {
                row.push(pixelToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2]));
              }
            }
            sprite.push(row);
          }
          frames.push(sprite);
        }
        charData[dir] = frames;
      }
      characters.push(charData);
    }

    console.log(`[AssetLoader] Loaded ${characters.length} character sprites (${CHAR_FRAMES_PER_ROW} frames x 3 directions each)`);
    return { characters };
  } catch (err) {
    console.error(`[AssetLoader] Error loading character sprites: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Load floor tile patterns from floors.png (7 tiles, 16px each, horizontal strip). */
export function loadFloorTiles(): LoadedFloorTiles | null {
  try {
    if (!hasAsset('floors.png')) {
      console.log('[AssetLoader] No floors.png embedded — renderer will use fallback');
      return null;
    }

    const png = PNG.sync.read(readAsset('floors.png'));
    const sprites: string[][][] = [];

    for (let t = 0; t < FLOOR_PATTERN_COUNT; t++) {
      const sprite: string[][] = [];
      for (let y = 0; y < FLOOR_TILE_SIZE; y++) {
        const row: string[] = [];
        for (let x = 0; x < FLOOR_TILE_SIZE; x++) {
          const px = t * FLOOR_TILE_SIZE + x;
          const idx = (y * png.width + px) * 4;
          const a = png.data[idx + 3];
          if (a < PNG_ALPHA_THRESHOLD) {
            row.push('');
          } else {
            row.push(pixelToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2]));
          }
        }
        sprite.push(row);
      }
      sprites.push(sprite);
    }

    console.log(`[AssetLoader] Loaded ${sprites.length} floor tile patterns`);
    return { sprites };
  } catch (err) {
    console.error(`[AssetLoader] Error loading floor tiles: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Load wall tiles from walls.png (64x128, 4x4 grid of 16x32 pieces). */
export function loadWallTiles(): LoadedWallTiles | null {
  try {
    if (!hasAsset('walls.png')) {
      console.log('[AssetLoader] No walls.png embedded');
      return null;
    }

    const png = PNG.sync.read(readAsset('walls.png'));
    const sprites: string[][][] = [];

    for (let mask = 0; mask < WALL_BITMASK_COUNT; mask++) {
      const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
      const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
      const sprite: string[][] = [];
      for (let r = 0; r < WALL_PIECE_HEIGHT; r++) {
        const row: string[] = [];
        for (let c = 0; c < WALL_PIECE_WIDTH; c++) {
          const idx = ((oy + r) * png.width + (ox + c)) * 4;
          const a = png.data[idx + 3];
          if (a < PNG_ALPHA_THRESHOLD) {
            row.push('');
          } else {
            row.push(pixelToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2]));
          }
        }
        sprite.push(row);
      }
      sprites.push(sprite);
    }

    console.log(`[AssetLoader] Loaded ${sprites.length} wall tile pieces`);
    return { sprites };
  } catch (err) {
    console.error(`[AssetLoader] Error loading wall tiles: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Load furniture assets from furniture-catalog.json + individual sprites. */
export function loadFurnitureAssets(): LoadedAssets | null {
  try {
    const catalogText = ASSET_TEXT['furniture/furniture-catalog.json'];
    if (!catalogText) {
      console.log('[AssetLoader] No furniture catalog embedded — renderer will use fallback');
      return null;
    }

    const catalogData = JSON.parse(catalogText);
    const catalog: FurnitureAsset[] = catalogData.assets || [];
    const sprites: Record<string, string[][]> = {};

    for (const asset of catalog) {
      try {
        if (!hasAsset(asset.file)) {
          console.warn(`  Asset file not embedded: ${asset.file}`);
          continue;
        }
        sprites[asset.id] = pngToSpriteData(readAsset(asset.file), asset.width, asset.height);
      } catch (err) {
        console.warn(`  Error loading ${asset.id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    console.log(`[AssetLoader] Loaded ${Object.keys(sprites).length} / ${catalog.length} furniture assets`);
    return { catalog, sprites };
  } catch (err) {
    console.error(`[AssetLoader] Error loading furniture assets: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** The stock office, used until the user has saved a layout of their own. */
export function loadDefaultLayout(): Record<string, unknown> | null {
  try {
    const text = ASSET_TEXT['default-layout.json'];
    return text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch (err) {
    console.error(`[AssetLoader] Error parsing default layout: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
