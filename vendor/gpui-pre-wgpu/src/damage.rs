//! HERDR: damage tracking for partial redraw.
//!
//! GPUI rebuilds the whole [`Scene`] every frame and the renderer rasterizes every pixel of
//! the window. On a CPU rasterizer (Mesa llvmpipe or lavapipe, e.g. in a remote desktop
//! without GPU access) that costs tens of milliseconds per frame at desktop window sizes,
//! even when one line of text changed. This module splits the frame into tiles, hashes per
//! tile the sequence of primitives that can touch it, and compares that with the previous
//! frame, so the renderer can redraw only the tiles whose primitives changed.
//!
//! A primitive's draw order number is left out of its hash: inserting a primitive shifts the
//! order numbers of everything painted after it, but only the relative order of the
//! primitives touching a tile decides that tile's pixels, and the per-tile sequence already
//! records it.

use gpui::{
    Bounds, DevicePixels, MonochromeSprite, Path, PolychromeSprite, PrimitiveBatch, Quad,
    ScaledPixels, Scene, Shadow, Size, SubpixelSprite, TransformationMatrix, Underline,
};
use smallvec::SmallVec;
use std::ops::Range;

pub(crate) const TILE_WIDTH: u32 = 64;
pub(crate) const TILE_HEIGHT: u32 = 32;
/// Damage is merged down to at most this many scissor rectangles. Each rectangle replays the
/// frame's draw calls, so more rectangles trade vertex work for less fragment work.
pub(crate) const MAX_RECTS: usize = 6;
/// Past this share of the frame a partial redraw saves little; everything is redrawn.
const FULL_REDRAW_SHARE: f64 = 0.6;
/// Rasterization rounds coverage to whole pixels and edges are antialiased; one pixel of
/// slack keeps every pixel a primitive can touch inside its tiles.
const SLACK: f32 = 1.0;

const KIND_SHADOW: u64 = 1;
const KIND_QUAD: u64 = 2;
const KIND_PATH: u64 = 3;
const KIND_UNDERLINE: u64 = 4;
const KIND_MONOCHROME: u64 = 5;
const KIND_SUBPIXEL: u64 = 6;
const KIND_POLYCHROME: u64 = 7;

const EMPTY_TILE: u64 = 0x243f_6a88_85a3_08d3;

/// Hashes a primitive's bytes except its draw order. The primitive structs are `repr(C)` and
/// made only of 4-byte fields (the renderer's layout tests pin their sizes), so they have no
/// padding, and the renderer already uploads them as raw bytes.
macro_rules! pod_hash {
    ($kind:expr, $value:expr, $ty:ty) => {{
        let value: &$ty = $value;
        hash_skipping(
            $kind,
            value,
            std::mem::offset_of!($ty, order),
            std::mem::size_of_val(&value.order),
        )
    }};
}

/// A rectangle of the frame to redraw, in device pixels, aligned to tiles and clamped to
/// the frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DamageRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl DamageRect {
    pub fn area(&self) -> u64 {
        u64::from(self.width) * u64::from(self.height)
    }

    fn right(&self) -> u32 {
        self.x + self.width
    }

    fn bottom(&self) -> u32 {
        self.y + self.height
    }

    fn union(&self, other: &Self) -> Self {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        Self {
            x,
            y,
            width: self.right().max(other.right()) - x,
            height: self.bottom().max(other.bottom()) - y,
        }
    }

    /// Whether this rectangle overlaps `bounds` (with slack), e.g. to skip a path batch
    /// that cannot reach any damaged pixel.
    pub fn touches(&self, bounds: &Bounds<ScaledPixels>) -> bool {
        self.reaches(&rect(bounds, SLACK))
    }

    /// Whether `area` (`[x0, y0, x1, y1]`) overlaps this rectangle. A NaN edge counts as
    /// unbounded, as in damage tracking, so such a primitive is never culled.
    pub fn reaches(&self, area: &[f32; 4]) -> bool {
        let x0 = area[0].max(f32::MIN);
        let y0 = area[1].max(f32::MIN);
        let x1 = area[2].min(f32::MAX);
        let y1 = area[3].min(f32::MAX);
        x0 < self.right() as f32
            && (self.x as f32) < x1
            && y0 < self.bottom() as f32
            && (self.y as f32) < y1
    }
}

/// Instances closer than this in draw order are drawn as one run; the instances in between
/// only cost vertex work, as the scissor discards their pixels.
const RUN_GAP: usize = 16;

/// For a partial redraw: per damaged rectangle, the runs of `instances` (indices into the
/// slice) that can reach it. Drawing only these through the rectangle's scissor gives the
/// same pixels as drawing every instance, without paying vertex work for the whole frame.
pub(crate) fn visible_runs<T>(
    instances: &[T],
    rects: &[DamageRect],
    area: impl Fn(&T) -> [f32; 4],
) -> SmallVec<[(DamageRect, Range<u32>); 8]> {
    let mut runs: SmallVec<[(DamageRect, Range<u32>); 8]> = SmallVec::new();
    for rect in rects {
        let mut current: Option<Range<usize>> = None;
        for (index, instance) in instances.iter().enumerate() {
            if !rect.reaches(&area(instance)) {
                continue;
            }
            current = match current {
                Some(run) if index - run.end < RUN_GAP => Some(run.start..index + 1),
                Some(run) => {
                    runs.push((*rect, run.start as u32..run.end as u32));
                    Some(index..index + 1)
                }
                None => Some(index..index + 1),
            };
        }
        if let Some(run) = current {
            runs.push((*rect, run.start as u32..run.end as u32));
        }
    }
    runs
}

/// What a frame has to redraw compared with the pixels kept from the previous frame.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Damage {
    /// Redraw the whole frame.
    Full,
    /// Nothing visible changed.
    Nothing,
    /// Redraw these disjoint rectangles and keep everything else.
    Rects(SmallVec<[DamageRect; MAX_RECTS]>),
}

impl Damage {
    /// Pixels redrawn, given the frame size.
    pub fn area(&self, size: Size<DevicePixels>) -> u64 {
        match self {
            Damage::Full => size.width.0.max(0) as u64 * size.height.0.max(0) as u64,
            Damage::Nothing => 0,
            Damage::Rects(rects) => rects.iter().map(DamageRect::area).sum(),
        }
    }
}

/// Per-tile hashes of the primitives a frame draws, in draw order.
pub(crate) struct TileHashes {
    width: u32,
    height: u32,
    columns: u32,
    rows: u32,
    hashes: Vec<u64>,
}

impl TileHashes {
    fn empty(size: Size<DevicePixels>) -> Self {
        let width = size.width.0.max(0) as u32;
        let height = size.height.0.max(0) as u32;
        let columns = width.div_ceil(TILE_WIDTH);
        let rows = height.div_ceil(TILE_HEIGHT);
        Self {
            width,
            height,
            columns,
            rows,
            hashes: vec![EMPTY_TILE; columns as usize * rows as usize],
        }
    }

    pub fn of_scene(scene: &Scene, size: Size<DevicePixels>) -> Self {
        let mut tiles = Self::empty(size);
        // The same order the renderer draws in, so each tile sees its primitives in paint order.
        for batch in scene.batches() {
            match batch {
                PrimitiveBatch::Shadows(range) => {
                    for shadow in &scene.shadows[range] {
                        tiles.add(shadow_area(shadow), pod_hash!(KIND_SHADOW, shadow, Shadow));
                    }
                }
                PrimitiveBatch::Quads(range) => {
                    for quad in &scene.quads[range] {
                        tiles.add(quad_area(quad), pod_hash!(KIND_QUAD, quad, Quad));
                    }
                }
                PrimitiveBatch::Paths(range) => {
                    for path in &scene.paths[range] {
                        let area = masked(rect(&path.bounds, SLACK), &path.content_mask.bounds);
                        tiles.add(area, path_hash(path));
                    }
                }
                PrimitiveBatch::Underlines(range) => {
                    for underline in &scene.underlines[range] {
                        let hash = pod_hash!(KIND_UNDERLINE, underline, Underline);
                        tiles.add(underline_area(underline), hash);
                    }
                }
                PrimitiveBatch::MonochromeSprites { range, .. } => {
                    for sprite in &scene.monochrome_sprites[range] {
                        let hash = pod_hash!(KIND_MONOCHROME, sprite, MonochromeSprite);
                        tiles.add(monochrome_area(sprite), hash);
                    }
                }
                PrimitiveBatch::SubpixelSprites { range, .. } => {
                    for sprite in &scene.subpixel_sprites[range] {
                        let hash = pod_hash!(KIND_SUBPIXEL, sprite, SubpixelSprite);
                        tiles.add(subpixel_area(sprite), hash);
                    }
                }
                PrimitiveBatch::PolychromeSprites { range, .. } => {
                    for sprite in &scene.polychrome_sprites[range] {
                        let hash = pod_hash!(KIND_POLYCHROME, sprite, PolychromeSprite);
                        tiles.add(polychrome_area(sprite), hash);
                    }
                }
                // The wgpu renderer does not draw surfaces (macOS video only).
                PrimitiveBatch::Surfaces(_) => {}
            }
        }
        tiles
    }

    fn add(&mut self, rect: [f32; 4], hash: u64) {
        // f32::max/min return the other operand for NaN, so a NaN edge spreads to the frame
        // edge: over-covering is safe, under-covering would leave stale pixels.
        let x0 = rect[0].max(0.0);
        let y0 = rect[1].max(0.0);
        let x1 = rect[2].min(self.width as f32);
        let y1 = rect[3].min(self.height as f32);
        if !(x0 < x1 && y0 < y1) {
            return;
        }
        let first_column = (x0 as u32 / TILE_WIDTH).min(self.columns - 1);
        let last_column = ((x1.ceil() as u32).saturating_sub(1) / TILE_WIDTH).min(self.columns - 1);
        let first_row = (y0 as u32 / TILE_HEIGHT).min(self.rows - 1);
        let last_row = ((y1.ceil() as u32).saturating_sub(1) / TILE_HEIGHT).min(self.rows - 1);
        for row in first_row..=last_row {
            let start = (row * self.columns) as usize;
            for tile in
                &mut self.hashes[start + first_column as usize..=start + last_column as usize]
            {
                *tile = fmix64(tile.wrapping_mul(0x9e37_79b9_7f4a_7c15) ^ hash);
            }
        }
    }

    /// What must be redrawn to turn a frame that showed `previous` into this one.
    pub fn damage_since(&self, previous: &Self) -> Damage {
        if (self.width, self.height) != (previous.width, previous.height) {
            return Damage::Full;
        }
        let mut rects: SmallVec<[DamageRect; 32]> = SmallVec::new();
        // Runs of changed tiles per row, merged with the run above when they span the same
        // columns.
        let mut open: SmallVec<[usize; 32]> = SmallVec::new();
        for row in 0..self.rows {
            let mut next_open: SmallVec<[usize; 32]> = SmallVec::new();
            let mut column = 0;
            while column < self.columns {
                let index = (row * self.columns + column) as usize;
                if self.hashes[index] == previous.hashes[index] {
                    column += 1;
                    continue;
                }
                let start = column;
                while column < self.columns
                    && self.hashes[(row * self.columns + column) as usize]
                        != previous.hashes[(row * self.columns + column) as usize]
                {
                    column += 1;
                }
                let run = self.tile_rect(start, column, row, row + 1);
                if let Some(&above) = open
                    .iter()
                    .find(|&&i| rects[i].x == run.x && rects[i].width == run.width)
                {
                    rects[above].height = run.bottom() - rects[above].y;
                    next_open.push(above);
                } else {
                    rects.push(run);
                    next_open.push(rects.len() - 1);
                }
            }
            open = next_open;
        }
        if rects.is_empty() {
            return Damage::Nothing;
        }
        while rects.len() > MAX_RECTS {
            // Merge the pair whose union adds the least redrawn area.
            let mut best = (0, 1, u64::MAX);
            for i in 0..rects.len() {
                for j in i + 1..rects.len() {
                    let union = rects[i].union(&rects[j]);
                    let growth = union
                        .area()
                        .saturating_sub(rects[i].area() + rects[j].area());
                    if growth < best.2 {
                        best = (i, j, growth);
                    }
                }
            }
            let (i, j, _) = best;
            let merged = rects[i].union(&rects[j]);
            rects.swap_remove(j);
            rects[i] = merged;
            // A union can overlap other rectangles; fold those in so rectangles stay disjoint
            // (a primitive drawn twice through overlapping scissors would blend twice).
            fold_overlaps(&mut rects, i);
        }
        let area: u64 = rects.iter().map(DamageRect::area).sum();
        if area as f64 > FULL_REDRAW_SHARE * f64::from(self.width) * f64::from(self.height) {
            return Damage::Full;
        }
        Damage::Rects(rects.into_iter().collect())
    }

    fn tile_rect(
        &self,
        first_column: u32,
        end_column: u32,
        first_row: u32,
        end_row: u32,
    ) -> DamageRect {
        let x = first_column * TILE_WIDTH;
        let y = first_row * TILE_HEIGHT;
        DamageRect {
            x,
            y,
            width: (end_column * TILE_WIDTH).min(self.width) - x,
            height: (end_row * TILE_HEIGHT).min(self.height) - y,
        }
    }
}

fn overlaps(a: &DamageRect, b: &DamageRect) -> bool {
    a.x < b.right() && b.x < a.right() && a.y < b.bottom() && b.y < a.bottom()
}

fn fold_overlaps(rects: &mut SmallVec<[DamageRect; 32]>, mut index: usize) {
    loop {
        let Some(other) =
            (0..rects.len()).find(|&k| k != index && overlaps(&rects[k], &rects[index]))
        else {
            return;
        };
        let merged = rects[index].union(&rects[other]);
        rects.swap_remove(other);
        // swap_remove moved the last element into `other`; follow `index` if it was last.
        if index == rects.len() {
            index = other;
        }
        rects[index] = merged;
    }
}

/// `bounds` as `[x0, y0, x1, y1]`, grown by `grow`. Negative sizes still rasterize (the quad
/// just flips), so the corners are ordered.
fn rect(bounds: &Bounds<ScaledPixels>, grow: f32) -> [f32; 4] {
    let x0 = bounds.origin.x.0;
    let y0 = bounds.origin.y.0;
    let x1 = x0 + bounds.size.width.0;
    let y1 = y0 + bounds.size.height.0;
    [
        x0.min(x1) - grow,
        y0.min(y1) - grow,
        x0.max(x1) + grow,
        y0.max(y1) + grow,
    ]
}

/// `geometry` clipped by a content mask: the shaders discard fragments outside the mask.
fn masked(geometry: [f32; 4], mask: &Bounds<ScaledPixels>) -> [f32; 4] {
    let mask = rect(mask, SLACK);
    [
        geometry[0].max(mask[0]),
        geometry[1].max(mask[1]),
        geometry[2].min(mask[2]),
        geometry[3].min(mask[3]),
    ]
}

/// The pixels a primitive can touch, `[x0, y0, x1, y1]` with slack: what damage tracking
/// marks dirty, and what a partial redraw draws an instance for.
pub(crate) fn quad_area(quad: &Quad) -> [f32; 4] {
    masked(rect(&quad.bounds, SLACK), &quad.content_mask.bounds)
}

pub(crate) fn underline_area(underline: &Underline) -> [f32; 4] {
    masked(
        rect(&underline.bounds, SLACK),
        &underline.content_mask.bounds,
    )
}

pub(crate) fn monochrome_area(sprite: &MonochromeSprite) -> [f32; 4] {
    sprite_rect(
        &sprite.bounds,
        &sprite.content_mask.bounds,
        &sprite.transformation,
    )
}

pub(crate) fn subpixel_area(sprite: &SubpixelSprite) -> [f32; 4] {
    sprite_rect(
        &sprite.bounds,
        &sprite.content_mask.bounds,
        &sprite.transformation,
    )
}

pub(crate) fn polychrome_area(sprite: &PolychromeSprite) -> [f32; 4] {
    masked(rect(&sprite.bounds, SLACK), &sprite.content_mask.bounds)
}

pub(crate) fn shadow_area(shadow: &Shadow) -> [f32; 4] {
    // vs_shadow: inset shadows cover the element; drop shadows leave 3 sigma for the blur.
    let geometry = if shadow.inset != 0 {
        rect(&shadow.element_bounds, SLACK)
    } else {
        rect(&shadow.bounds, 3.0 * shadow.blur_radius.0.abs() + SLACK)
    };
    masked(geometry, &shadow.content_mask.bounds)
}

fn sprite_rect(
    bounds: &Bounds<ScaledPixels>,
    mask: &Bounds<ScaledPixels>,
    transformation: &TransformationMatrix,
) -> [f32; 4] {
    if *transformation == TransformationMatrix::unit() {
        return masked(rect(bounds, SLACK), mask);
    }
    let [x0, y0, x1, y1] = rect(bounds, 0.0);
    let m = transformation.rotation_scale;
    let [tx, ty] = transformation.translation;
    let mut out = [
        f32::INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
    ];
    for (x, y) in [(x0, y0), (x1, y0), (x0, y1), (x1, y1)] {
        // Both readings of the row-major matrix, so a layout mixup can only over-cover.
        for (px, py) in [
            (m[0][0] * x + m[0][1] * y, m[1][0] * x + m[1][1] * y),
            (m[0][0] * x + m[1][0] * y, m[0][1] * x + m[1][1] * y),
        ] {
            out = [
                out[0].min(px + tx),
                out[1].min(py + ty),
                out[2].max(px + tx),
                out[3].max(py + ty),
            ];
        }
    }
    masked(
        [
            out[0] - SLACK,
            out[1] - SLACK,
            out[2] + SLACK,
            out[3] + SLACK,
        ],
        mask,
    )
}

pub(crate) fn hash_skipping<T>(kind: u64, value: &T, skip_offset: usize, skip_len: usize) -> u64 {
    // SAFETY: see `pod_hash!`; `T` is one of the scene's padding-free `repr(C)` primitives.
    let bytes = unsafe {
        std::slice::from_raw_parts(value as *const T as *const u8, std::mem::size_of::<T>())
    };
    let hash = hash_bytes(kind, &bytes[..skip_offset]);
    fmix64(hash_bytes(hash, &bytes[skip_offset + skip_len..]))
}

fn path_hash(path: &Path<ScaledPixels>) -> u64 {
    let mut hash = KIND_PATH;
    for value in [
        path.bounds.origin.x.0,
        path.bounds.origin.y.0,
        path.bounds.size.width.0,
        path.bounds.size.height.0,
        path.content_mask.bounds.origin.x.0,
        path.content_mask.bounds.origin.y.0,
        path.content_mask.bounds.size.width.0,
        path.content_mask.bounds.size.height.0,
    ] {
        hash = mix(hash, u64::from(value.to_bits()));
    }
    // SAFETY: `Background` and `PathVertex<ScaledPixels>` are `repr(C)` structs of 4-byte
    // fields (uploaded to the GPU as raw bytes the same way), so they have no padding.
    let color = unsafe {
        std::slice::from_raw_parts(
            &path.color as *const _ as *const u8,
            std::mem::size_of_val(&path.color),
        )
    };
    hash = hash_bytes(hash, color);
    let vertices = unsafe {
        std::slice::from_raw_parts(
            path.vertices.as_ptr() as *const u8,
            std::mem::size_of_val(path.vertices.as_slice()),
        )
    };
    fmix64(hash_bytes(hash, vertices))
}

#[inline]
fn mix(hash: u64, word: u64) -> u64 {
    (hash.rotate_left(5) ^ word).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95)
}

fn hash_bytes(mut hash: u64, bytes: &[u8]) -> u64 {
    let mut chunks = bytes.chunks_exact(8);
    for chunk in &mut chunks {
        hash = mix(hash, u64::from_le_bytes(chunk.try_into().unwrap()));
    }
    let rest = chunks.remainder();
    if !rest.is_empty() {
        let mut word = [0u8; 8];
        word[..rest.len()].copy_from_slice(rest);
        hash = mix(hash, u64::from_le_bytes(word));
    }
    mix(hash, bytes.len() as u64)
}

/// MurmurHash3's finalizer: a bijection that spreads every input bit over the output.
#[inline]
fn fmix64(mut k: u64) -> u64 {
    k ^= k >> 33;
    k = k.wrapping_mul(0xff51_afd7_ed55_8ccd);
    k ^= k >> 33;
    k = k.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    k ^ (k >> 33)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{BorderStyle, ContentMask, Corners, Edges, Hsla, Point};

    fn size(width: i32, height: i32) -> Size<DevicePixels> {
        Size {
            width: DevicePixels(width),
            height: DevicePixels(height),
        }
    }

    fn bounds(x: f32, y: f32, width: f32, height: f32) -> Bounds<ScaledPixels> {
        Bounds {
            origin: Point {
                x: ScaledPixels(x),
                y: ScaledPixels(y),
            },
            size: Size {
                width: ScaledPixels(width),
                height: ScaledPixels(height),
            },
        }
    }

    fn quad(x: f32, y: f32, width: f32, height: f32, color: Hsla) -> Quad {
        Quad {
            order: 0,
            border_style: BorderStyle::Solid,
            bounds: bounds(x, y, width, height),
            content_mask: ContentMask {
                bounds: bounds(0.0, 0.0, 10_000.0, 10_000.0),
            },
            background: color.into(),
            border_color: color,
            corner_radii: Corners::default(),
            border_widths: Edges::default(),
        }
    }

    fn scene(quads: &[Quad]) -> Scene {
        let mut scene = Scene::default();
        for quad in quads {
            scene.insert_primitive(*quad);
        }
        scene.finish();
        scene
    }

    fn damage(before: &[Quad], after: &[Quad]) -> Damage {
        let frame = size(640, 320);
        TileHashes::of_scene(&scene(after), frame)
            .damage_since(&TileHashes::of_scene(&scene(before), frame))
    }

    const BACKGROUND: [f32; 4] = [0.0, 0.0, 640.0, 320.0];

    fn background() -> Quad {
        quad(
            BACKGROUND[0],
            BACKGROUND[1],
            BACKGROUND[2],
            BACKGROUND[3],
            gpui::black(),
        )
    }

    #[test]
    fn identical_scenes_have_no_damage() {
        let quads = [background(), quad(10.0, 10.0, 20.0, 20.0, gpui::red())];
        assert_eq!(damage(&quads, &quads), Damage::Nothing);
    }

    #[test]
    fn a_changed_quad_damages_only_its_tiles() {
        let before = [background(), quad(100.0, 40.0, 20.0, 10.0, gpui::red())];
        let after = [background(), quad(100.0, 40.0, 20.0, 10.0, gpui::blue())];
        // x 99..121 is inside column 1 (64..128); y 39..51 is inside row 1 (32..64).
        assert_eq!(
            damage(&before, &after),
            Damage::Rects(SmallVec::from_slice(&[DamageRect {
                x: 64,
                y: 32,
                width: 64,
                height: 32
            }]))
        );
    }

    #[test]
    fn a_moved_quad_damages_where_it_was_and_where_it_is() {
        let before = [background(), quad(10.0, 10.0, 10.0, 10.0, gpui::red())];
        // x 499..511 and y 229..241 (with slack) stay inside one tile.
        let after = [background(), quad(500.0, 230.0, 10.0, 10.0, gpui::red())];
        let Damage::Rects(rects) = damage(&before, &after) else {
            panic!("expected rectangles");
        };
        assert_eq!(rects.len(), 2);
        assert!(rects.contains(&DamageRect {
            x: 0,
            y: 0,
            width: 64,
            height: 32
        }));
        assert!(rects.contains(&DamageRect {
            x: 448,
            y: 224,
            width: 64,
            height: 32
        }));
    }

    #[test]
    fn draw_order_shifts_alone_do_not_damage() {
        // A new quad under a wide bar raises the order numbers of the bar and of the marker
        // painted on it; tiles the new quad does not touch must stay clean.
        let bar = quad(0.0, 0.0, 640.0, 40.0, gpui::white());
        let marker = quad(400.0, 10.0, 10.0, 10.0, gpui::red());
        let before = [background(), bar, marker];
        let after = [
            background(),
            quad(10.0, 10.0, 10.0, 10.0, gpui::blue()),
            bar,
            marker,
        ];
        let orders = |quads: &[Quad]| {
            scene(quads)
                .quads
                .iter()
                .map(|q| q.order)
                .collect::<Vec<_>>()
        };
        assert_ne!(
            orders(&before).last(),
            orders(&after).last(),
            "the marker's order must shift"
        );
        assert_eq!(
            damage(&before, &after),
            Damage::Rects(SmallVec::from_slice(&[DamageRect {
                x: 0,
                y: 0,
                width: 64,
                height: 32
            }]))
        );
    }

    #[test]
    fn swapping_paint_order_damages_the_overlap() {
        let a = quad(100.0, 100.0, 20.0, 20.0, gpui::red());
        let b = quad(105.0, 105.0, 20.0, 20.0, gpui::blue());
        assert!(matches!(
            damage(&[background(), a, b], &[background(), b, a]),
            Damage::Rects(_)
        ));
    }

    #[test]
    fn a_line_of_rows_merges_into_one_rect() {
        let before: Vec<Quad> = std::iter::once(background())
            .chain((0..10).map(|i| quad(i as f32 * 60.0 + 2.0, 100.0, 50.0, 10.0, gpui::red())))
            .collect();
        let after: Vec<Quad> = std::iter::once(background())
            .chain((0..10).map(|i| quad(i as f32 * 60.0 + 2.0, 100.0, 50.0, 10.0, gpui::blue())))
            .collect();
        assert_eq!(
            damage(&before, &after),
            Damage::Rects(SmallVec::from_slice(&[DamageRect {
                x: 0,
                y: 96,
                width: 640,
                height: 32
            }]))
        );
    }

    #[test]
    fn many_scattered_changes_merge_into_few_disjoint_rects() {
        let spots = |color| -> Vec<Quad> {
            std::iter::once(background())
                .chain((0..9).map(|i| {
                    quad(
                        i as f32 * 70.0 + 3.0,
                        (i % 3) as f32 * 100.0 + 3.0,
                        4.0,
                        4.0,
                        color,
                    )
                }))
                .collect()
        };
        let Damage::Rects(rects) = damage(&spots(gpui::red()), &spots(gpui::blue())) else {
            panic!("expected rectangles");
        };
        assert!(rects.len() <= MAX_RECTS);
        for (i, a) in rects.iter().enumerate() {
            for b in rects.iter().skip(i + 1) {
                assert!(!overlaps(a, b), "{a:?} overlaps {b:?}");
            }
        }
    }

    #[test]
    fn large_changes_redraw_everything() {
        let before = [background()];
        let after = [quad(0.0, 0.0, 640.0, 320.0, gpui::white())];
        assert_eq!(damage(&before, &after), Damage::Full);
    }

    #[test]
    fn a_new_frame_size_redraws_everything() {
        let quads = scene(&[background()]);
        let damage = TileHashes::of_scene(&quads, size(640, 320))
            .damage_since(&TileHashes::of_scene(&quads, size(641, 320)));
        assert_eq!(damage, Damage::Full);
    }

    #[test]
    fn drop_shadows_damage_their_blur_margin() {
        let shadow = |color| Shadow {
            order: 0,
            blur_radius: ScaledPixels(10.0),
            bounds: bounds(200.0, 100.0, 40.0, 40.0),
            corner_radii: Corners::default(),
            content_mask: ContentMask {
                bounds: bounds(0.0, 0.0, 640.0, 320.0),
            },
            color,
            element_bounds: bounds(200.0, 100.0, 40.0, 40.0),
            element_corner_radii: Corners::default(),
            inset: 0,
            pad: 0,
        };
        let frame = size(640, 320);
        let hashes = |color| {
            let mut scene = Scene::default();
            scene.insert_primitive(shadow(color));
            scene.finish();
            TileHashes::of_scene(&scene, frame)
        };
        let Damage::Rects(rects) = hashes(gpui::blue()).damage_since(&hashes(gpui::red())) else {
            panic!("expected rectangles");
        };
        // 3 sigma = 30 px around 200..240 x 100..140, plus slack: 169..271 x 69..171.
        let covered = rects.iter().fold(rects[0], |acc, r| acc.union(r));
        assert!(covered.x <= 169 && covered.right() >= 271, "{covered:?}");
        assert!(covered.y <= 69 && covered.bottom() >= 171, "{covered:?}");
    }

    #[test]
    fn transformed_sprites_cover_their_transformed_extent() {
        let transformation = TransformationMatrix {
            rotation_scale: [[0.0, -1.0], [1.0, 0.0]],
            translation: [300.0, 0.0],
        };
        let r = sprite_rect(
            &bounds(10.0, 20.0, 30.0, 10.0),
            &bounds(0.0, 0.0, 1000.0, 1000.0),
            &transformation,
        );
        // Rotating by 90 degrees either way and translating keeps x within 300 +- 30.
        assert!(r[0] <= 300.0 - 30.0 && r[2] >= 300.0 + 30.0, "{r:?}");
    }

    #[test]
    fn visible_runs_keep_only_instances_that_reach_a_rect() {
        let quads: Vec<Quad> = (0..100)
            .map(|i| {
                quad(
                    (i % 10) as f32 * 64.0 + 8.0,
                    (i / 10) as f32 * 32.0 + 8.0,
                    8.0,
                    8.0,
                    gpui::red(),
                )
            })
            .collect();
        let row = DamageRect {
            x: 0,
            y: 64,
            width: 640,
            height: 32,
        };
        let runs = visible_runs(&quads, &[row], quad_area);
        // Row 2 of the grid: instances 20..30, drawn as one run.
        assert_eq!(runs.as_slice(), &[(row, 20..30)]);
        let corner = DamageRect {
            x: 0,
            y: 0,
            width: 64,
            height: 32,
        };
        let runs = visible_runs(&quads, &[corner, row], quad_area);
        assert_eq!(runs.as_slice(), &[(corner, 0..1), (row, 20..30)]);
    }

    #[test]
    fn nan_areas_reach_every_rect() {
        let rect = DamageRect {
            x: 64,
            y: 32,
            width: 64,
            height: 32,
        };
        assert!(rect.reaches(&[f32::NAN; 4]));
        assert!(!rect.reaches(&[0.0, 0.0, 10.0, 10.0]));
    }

    #[test]
    fn nan_geometry_covers_the_whole_frame() {
        let frame = size(640, 320);
        let mut tiles = TileHashes::empty(frame);
        tiles.add([f32::NAN, f32::NAN, f32::NAN, f32::NAN], 7);
        assert!(tiles.hashes.iter().all(|&hash| hash != EMPTY_TILE));
        assert_eq!(tiles.damage_since(&TileHashes::empty(frame)), Damage::Full);
    }

    #[test]
    fn geometry_outside_the_frame_is_ignored() {
        let frame = size(640, 320);
        let mut tiles = TileHashes::empty(frame);
        tiles.add([700.0, 10.0, 720.0, 20.0], 7);
        tiles.add([10.0, -50.0, 20.0, -10.0], 7);
        assert_eq!(
            tiles.damage_since(&TileHashes::empty(frame)),
            Damage::Nothing
        );
    }

    #[test]
    fn merged_rectangles_fold_in_overlaps() {
        let mut rects: SmallVec<[DamageRect; 32]> = SmallVec::from_slice(&[
            DamageRect {
                x: 0,
                y: 0,
                width: 128,
                height: 64,
            },
            DamageRect {
                x: 64,
                y: 32,
                width: 64,
                height: 64,
            },
            DamageRect {
                x: 512,
                y: 0,
                width: 64,
                height: 32,
            },
        ]);
        fold_overlaps(&mut rects, 0);
        assert_eq!(rects.len(), 2);
        assert!(rects.contains(&DamageRect {
            x: 0,
            y: 0,
            width: 128,
            height: 96
        }));
    }
}
