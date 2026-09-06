import type { ObjectId } from 'mongodb'

/** Immutable authored world definition. Revisioned CDN keys let clients cache safely. */
export interface InteractiveAssetDoc {
  id: string
  key: string
  role: 'plate' | 'sprite' | 'scene' | 'portrait' | 'texture'
  revision: number
  /**
   * Real pixel size of the published file, measured by the asset pipeline.
   *
   * The client cannot lay the map out without this. Plates stack into a column
   * whose slices must be proportional to the art, and a sprite drawn into a
   * square box is stretched. Both failures are silent — the map still renders,
   * just wrong — so the numbers are generated from what was actually uploaded
   * and never hand-authored. Absent until the asset exists.
   */
  width?: number
  height?: number
}

/**
 * How a place is currently known to the player.
 *
 * `rumoured` is the one that does the work: the place is not drawn at all, its
 * region is under fog, and it is revealed when the fiction first names it. It
 * costs no bespoke art until it becomes enterable, which is what lets the map
 * be far larger than the art budget.
 */
export type InteractiveVisibility = 'open' | 'sealed' | 'rumoured'

/**
 * A landmark placed on the terrain plate.
 *
 * Position is normalised against the whole stitched map, not a plate, so
 * re-stitching at a different resolution never moves anything. `anchor` is the
 * point of the sprite that sits on `x, y`. These landmarks are dioramas drawn
 * with their own ground plot, so `center` is what places them: `base` would put
 * the plot's front edge on the point and lift the whole building half its own
 * height off the plaza it belongs in. `base` remains correct for a tall sprite
 * with no ground of its own, which is why both exist. Coordinates are measured
 * against the delivered plate, so the anchor must match how they were measured.
 */
export interface InteractiveSpriteDoc {
  asset_id: string
  x: number
  y: number
  scale: number
  anchor: 'base' | 'center'
  z: number
  /**
   * In-plane rotation in degrees, clockwise, about the sprite's centre.
   *
   * This corrects ALIGNMENT ONLY — a landmark that must continue a line the
   * plate already painted (a gate in a wall, a bridge between two banks) and
   * whose own ground axis runs at a slightly different angle to that line.
   * Marblegate's towers sat 4 degrees steeper than Corvane's wall, so the gate
   * closed the gap but read as pinned across it rather than built into it.
   *
   * It CANNOT fix a camera mismatch. A sprite drawn at a different elevation
   * to the plate is wrong in three dimensions and no 2D rotation recovers it —
   * that is a regeneration, matched against a crop of the plate itself. Trying
   * to rotate out a camera error cost four generations before this was
   * understood; keep the two failures separate.
   */
  rotation?: number
  /** Swapped in when the named flag is true. */
  variants?: { flag: string; asset_id: string }[]
}

/**
 * How a place is drawn on the terrain.
 *
 * `sprite` composites the landmark art onto the plate. It only works where the
 * plate is open, organic ground — a sprite carries its own paving and walls,
 * and over painted architecture it reads as a sticker no matter where it is
 * put. Measured on the delivered plates: the largest genuinely empty square is
 * 24-44px while a landmark needs 144-224px, so a built-up plate has no honest
 * position at all.
 *
 * `marker` is the answer there: the painting already shows the city, so the
 * place is named and pinned rather than redrawn, and its landmark art is shown
 * large in the selection panel instead — where it is legible and composites
 * against nothing.
 */
export type InteractiveMapRender = 'sprite' | 'marker'

export interface InteractiveLocationDoc {
  id: string
  title: string
  description: string
  realm: string
  visibility: InteractiveVisibility
  map_render: InteractiveMapRender
  sprite: InteractiveSpriteDoc
  /** Absent for map-presence places, which are never entered. */
  scene_asset_id?: string
  /** Authored scene copy. Kept as data so the client renders rather than writes. */
  scene_headline?: string
  scene_body?: string
  routes: string[]
  /** Gates travel. A sealed place with no unlock flag is scenery. */
  unlock_flag?: string
  /** Player-facing reason the place is shut. Never mechanical. */
  sealed_reason?: string
  /** Lifts fog and promotes `rumoured` to `sealed`. */
  reveal_flag?: string
}

export interface InteractiveRealmDoc {
  id: string
  title: string
  /** Normalised band of the stitched map this realm occupies. */
  y_from: number
  y_to: number
}

/** One square painting, stacked top to bottom into the whole map. */
export interface InteractivePlateDoc {
  asset_id: string
  order: number
}

/**
 * Renderer selection is world data. A template world swaps art and vocabulary
 * without any renderer change — that is the whole point of the genre pack.
 */
export interface InteractiveMapStyleDoc {
  renderer: 'terrain_plate_scene_graph' | 'landmark_scene_graph' | 'layered_atlas'
  skin: string
  plates: InteractivePlateDoc[]
  /** Aspect of the stitched map; the client sizes its canvas from this. */
  map_aspect: { width: number; height: number }
  fog_asset_id?: string
  sealed_marker_asset_id?: string
}

export interface InteractiveWorldDoc {
  _id: ObjectId
  key: string
  version: number
  title: string
  chapter_title: string
  map_style: InteractiveMapStyleDoc
  realms: InteractiveRealmDoc[]
  assets: InteractiveAssetDoc[]
  locations: InteractiveLocationDoc[]
  created_at: Date
  updated_at: Date
}

/** Per-instance state is the canonical source for unlocked routes and choices. */
export interface InteractiveWorldStateDoc {
  _id: ObjectId
  instance_id: ObjectId
  player_id: ObjectId
  world_key: string
  current_location_id: string
  unlocked_location_ids: string[]
  /** Places whose fog has lifted. Separate from unlocked: seen is not open. */
  revealed_location_ids: string[]
  flags: Record<string, boolean>
  seen_scene_ids: string[]
  sequence: number
  created_at: Date
  updated_at: Date
}
