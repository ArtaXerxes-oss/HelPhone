//! Differential-privacy checks for zone bounding boxes (#529).
//!
//! A claimant's coordinates are private witnesses, so the chain can never see
//! (or verify noise added to) them. What it *can* enforce is the shape of the
//! public region the proof commits to, using only integer arithmetic:
//!
//! 1. **Laplace bound.** With sensitivity `s` and privacy budget `ε`, Laplace
//!    noise has scale `b = s / ε`, and stays within `b · t` of the true value
//!    with probability `1 - e^-t`. A box narrower than `b · t` cannot hold a
//!    location fuzzed at that ε, so it is rejected: the region must be at least
//!    as coarse as the noise it claims to hide behind.
//! 2. **Grid alignment.** Box edges must sit on `grid`-sized cell boundaries,
//!    so a box cannot be slid or trimmed by an arbitrary amount around a target.
//! 3. **Overlap guard (spatial k-anonymity).** Boxes are closed (a claimant on an
//!    edge is inside both neighbours), so two zones that overlap or merely
//!    touch let anyone inside both be localised to their intersection. That
//!    intersection must still be at least the Laplace-bound size on each axis
//!    and cover at least `k_cells` grid cells.
//!
//! These are policy checks on public data, not a proof that noise was added.

use soroban_sdk::{contracttype, BytesN};

/// Stored coordinates: `floor(lon * 1e7) + 1_800_000_000`, so at most 3.6e9.
pub const MAX_X: u64 = 3_600_000_000;
/// Stored coordinates: `floor(lat * 1e7) + 900_000_000`, so at most 1.8e9.
pub const MAX_Y: u64 = 1_800_000_000;

/// Zones remembered for the overlap guard. The scan is O(this), so it is
/// bounded; a zone older than the newest `MAX_TRACKED_ZONES` is no longer
/// checked against.
pub const MAX_TRACKED_ZONES: u32 = 128;

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct PrivacyParams {
    /// Off by default so existing deployments behave exactly as before.
    pub enabled: bool,
    /// ε × 1000 (1000 = ε of 1.0). Must be > 0.
    pub epsilon_milli: u32,
    /// Largest change one person's location can make, in stored-coordinate units.
    pub sensitivity: u64,
    /// The `t` in the `b · t` tail bound. 3 is roughly a 95% bound.
    pub tail_mult: u32,
    /// Cell size, in stored-coordinate units, that box edges must align to.
    pub grid: u64,
    /// Minimum grid cells any overlap of two zones must still cover.
    pub k_cells: u32,
}

impl PrivacyParams {
    /// ε = 1, sensitivity 0.01° (~1.1 km) → b = 100_000, min box 300_000
    /// (0.03°), 10_000-unit (~110 m) grid, overlaps of at least 25 cells.
    pub const fn defaults() -> Self {
        Self {
            enabled: false,
            epsilon_milli: 1_000,
            sensitivity: 100_000,
            tail_mult: 3,
            grid: 10_000,
            k_cells: 25,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[contracttype]
pub struct BoundingBox {
    pub x_min: u64,
    pub x_max: u64,
    pub y_min: u64,
    pub y_max: u64,
}

/// A zone registered for the overlap guard.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct TrackedZone {
    pub campaign_id: BytesN<32>,
    pub bbox: BoundingBox,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrivacyError {
    /// A parameter is zero, or the derived minimum overflows / cannot fit the map.
    InvalidParams,
    /// Not a real box: inverted, or outside the coordinate encoding range.
    Malformed,
    /// An edge is not on a grid boundary.
    NotOnGrid,
    /// Narrower than the Laplace bound on some axis.
    TooSmall,
    /// Overlaps another zone in a region below the k-anonymity bound.
    OverlapTooSmall,
}

/// Laplace scale `b = ceil(sensitivity / ε)`.
pub fn laplace_scale(p: &PrivacyParams) -> Option<u64> {
    if p.epsilon_milli == 0 {
        return None;
    }
    p.sensitivity
        .checked_mul(1_000)
        .map(|n| n.div_ceil(p.epsilon_milli as u64))
}

/// Smallest allowed box side: `b · t`, rounded up to a whole grid cell.
pub fn min_dimension(p: &PrivacyParams) -> Option<u64> {
    if p.grid == 0 {
        return None;
    }
    laplace_scale(p)?
        .checked_mul(p.tail_mult as u64)?
        .div_ceil(p.grid)
        .checked_mul(p.grid)
}

impl PrivacyParams {
    pub fn validate(&self) -> Result<(), PrivacyError> {
        if self.sensitivity == 0 || self.tail_mult == 0 || self.k_cells == 0 {
            return Err(PrivacyError::InvalidParams);
        }
        match min_dimension(self) {
            // The smallest legal box has to fit on the map.
            Some(m) if m > 0 && m <= MAX_Y => Ok(()),
            _ => Err(PrivacyError::InvalidParams),
        }
    }
}

/// Read a box from the first 128 bytes of the public inputs: four 32-byte
/// big-endian words, each holding a `u64`. A word with any high byte set is
/// not a valid `u64` and yields `None`.
pub fn parse_box(prefix: &[u8]) -> Option<BoundingBox> {
    if prefix.len() < 128 {
        return None;
    }
    let word = |i: usize| -> Option<u64> {
        let w = &prefix[i * 32..(i + 1) * 32];
        if w[..24].iter().any(|b| *b != 0) {
            return None;
        }
        let mut lo = [0u8; 8];
        lo.copy_from_slice(&w[24..]);
        Some(u64::from_be_bytes(lo))
    };
    Some(BoundingBox {
        x_min: word(0)?,
        x_max: word(1)?,
        y_min: word(2)?,
        y_max: word(3)?,
    })
}

/// Check a single box against the Laplace bound and the grid.
pub fn validate_box(p: &PrivacyParams, b: &BoundingBox) -> Result<(), PrivacyError> {
    p.validate()?;
    if b.x_min >= b.x_max || b.y_min >= b.y_max || b.x_max > MAX_X || b.y_max > MAX_Y {
        return Err(PrivacyError::Malformed);
    }
    if [b.x_min, b.x_max, b.y_min, b.y_max].iter().any(|v| v % p.grid != 0) {
        return Err(PrivacyError::NotOnGrid);
    }
    let min = min_dimension(p).ok_or(PrivacyError::InvalidParams)?;
    if b.x_max - b.x_min < min || b.y_max - b.y_min < min {
        return Err(PrivacyError::TooSmall);
    }
    Ok(())
}

/// Side lengths of the intersection of two *closed* boxes, or `None` if they
/// are disjoint. Boxes that only touch intersect in a zero-width line.
pub fn intersection(a: &BoundingBox, b: &BoundingBox) -> Option<(u64, u64)> {
    let x_min = a.x_min.max(b.x_min);
    let x_max = a.x_max.min(b.x_max);
    let y_min = a.y_min.max(b.y_min);
    let y_max = a.y_max.min(b.y_max);
    if x_min > x_max || y_min > y_max {
        None
    } else {
        Some((x_max - x_min, y_max - y_min))
    }
}

/// A new zone may be disjoint from `other`, or overlap it by at least the
/// Laplace bound on each axis and `k_cells` grid cells: never by less.
pub fn check_overlap(
    p: &PrivacyParams,
    new: &BoundingBox,
    other: &BoundingBox,
) -> Result<(), PrivacyError> {
    let Some((w, h)) = intersection(new, other) else {
        return Ok(());
    };
    let min = min_dimension(p).ok_or(PrivacyError::InvalidParams)?;
    let cells = (w / p.grid).saturating_mul(h / p.grid);
    if w < min || h < min || cells < p.k_cells as u64 {
        return Err(PrivacyError::OverlapTooSmall);
    }
    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;

    const ON: PrivacyParams = PrivacyParams {
        enabled: true,
        ..PrivacyParams::defaults()
    };

    fn bx(x_min: u64, x_max: u64, y_min: u64, y_max: u64) -> BoundingBox {
        BoundingBox { x_min, x_max, y_min, y_max }
    }

    fn word(v: u64) -> [u8; 32] {
        let mut w = [0u8; 32];
        w[24..].copy_from_slice(&v.to_be_bytes());
        w
    }

    fn prefix(b: &BoundingBox) -> [u8; 128] {
        let mut out = [0u8; 128];
        for (i, v) in [b.x_min, b.x_max, b.y_min, b.y_max].iter().enumerate() {
            out[i * 32..(i + 1) * 32].copy_from_slice(&word(*v));
        }
        out
    }

    #[test]
    fn laplace_scale_is_sensitivity_over_epsilon() {
        assert_eq!(laplace_scale(&ON), Some(100_000)); // 100_000 / 1.0
        let half = PrivacyParams { epsilon_milli: 500, ..ON };
        assert_eq!(laplace_scale(&half), Some(200_000)); // smaller ε, more noise
        let tenth = PrivacyParams { epsilon_milli: 100, ..ON };
        assert_eq!(laplace_scale(&tenth), Some(1_000_000));
    }

    #[test]
    fn laplace_scale_rounds_up_never_down() {
        let p = PrivacyParams { sensitivity: 10, epsilon_milli: 3_000, ..ON };
        assert_eq!(laplace_scale(&p), Some(4)); // 10 / 3.0 = 3.33 -> 4
    }

    #[test]
    fn laplace_scale_rejects_zero_epsilon_and_overflow() {
        assert_eq!(laplace_scale(&PrivacyParams { epsilon_milli: 0, ..ON }), None);
        assert_eq!(laplace_scale(&PrivacyParams { sensitivity: u64::MAX, ..ON }), None);
    }

    #[test]
    fn min_dimension_is_b_times_t_rounded_up_to_the_grid() {
        assert_eq!(min_dimension(&ON), Some(300_000)); // 100_000 * 3
        let p = PrivacyParams { sensitivity: 100_001, ..ON }; // b = 100_001, *3 = 300_003
        assert_eq!(min_dimension(&p), Some(310_000)); // up to next 10_000
    }

    #[test]
    fn stronger_privacy_demands_a_bigger_box() {
        let strict = PrivacyParams { epsilon_milli: 250, ..ON };
        assert!(min_dimension(&strict) > min_dimension(&ON));
    }

    #[test]
    fn params_validation() {
        assert_eq!(ON.validate(), Ok(()));
        for bad in [
            PrivacyParams { epsilon_milli: 0, ..ON },
            PrivacyParams { sensitivity: 0, ..ON },
            PrivacyParams { tail_mult: 0, ..ON },
            PrivacyParams { grid: 0, ..ON },
            PrivacyParams { k_cells: 0, ..ON },
            // Minimum box larger than the whole map.
            PrivacyParams { sensitivity: MAX_Y, ..ON },
            PrivacyParams { sensitivity: u64::MAX, ..ON },
        ] {
            assert_eq!(bad.validate(), Err(PrivacyError::InvalidParams), "{bad:?}");
        }
    }

    #[test]
    fn parse_box_reads_four_big_endian_words() {
        let b = bx(1_000_000, 2_000_000, 3_000_000, 4_000_000);
        assert_eq!(parse_box(&prefix(&b)), Some(b));
        // Trailing bytes (campaign id, ...) are ignored.
        let mut long = [7u8; 160];
        long[..128].copy_from_slice(&prefix(&b));
        assert_eq!(parse_box(&long), Some(b));
    }

    #[test]
    fn parse_box_rejects_short_input_and_words_wider_than_u64() {
        assert_eq!(parse_box(&[0u8; 127]), None);
        let mut p = prefix(&bx(0, 10, 0, 10));
        p[0] = 1; // high byte of x_min
        assert_eq!(parse_box(&p), None);
        let mut p = prefix(&bx(0, 10, 0, 10));
        p[3 * 32 + 23] = 1; // just below y_max's low 8 bytes
        assert_eq!(parse_box(&p), None);
    }

    #[test]
    fn a_box_at_exactly_the_bound_is_accepted() {
        assert_eq!(validate_box(&ON, &bx(0, 300_000, 0, 300_000)), Ok(()));
        assert_eq!(validate_box(&ON, &bx(1_000_000, 4_000_000, 2_000_000, 2_300_000)), Ok(()));
    }

    #[test]
    fn a_box_one_cell_under_the_bound_is_too_small_on_either_axis() {
        assert_eq!(validate_box(&ON, &bx(0, 290_000, 0, 300_000)), Err(PrivacyError::TooSmall));
        assert_eq!(validate_box(&ON, &bx(0, 300_000, 0, 290_000)), Err(PrivacyError::TooSmall));
    }

    #[test]
    fn edges_must_sit_on_the_grid() {
        for b in [
            bx(1, 300_001, 0, 300_000),
            bx(0, 300_000, 5, 300_005),
            bx(0, 300_001, 0, 300_000),
            bx(0, 300_000, 0, 300_500),
        ] {
            assert_eq!(validate_box(&ON, &b), Err(PrivacyError::NotOnGrid), "{b:?}");
        }
    }

    #[test]
    fn malformed_boxes_are_rejected() {
        for b in [
            bx(300_000, 0, 0, 300_000),              // inverted x
            bx(0, 300_000, 300_000, 0),              // inverted y
            bx(100_000, 100_000, 0, 300_000),        // zero width
            bx(0, 300_000, 200_000, 200_000),        // zero height
            bx(0, MAX_X + 10_000, 0, 300_000),       // beyond longitude range
            bx(0, 300_000, 0, MAX_Y + 10_000),       // beyond latitude range
        ] {
            assert_eq!(validate_box(&ON, &b), Err(PrivacyError::Malformed), "{b:?}");
        }
    }

    #[test]
    fn the_whole_map_is_a_valid_box() {
        assert_eq!(validate_box(&ON, &bx(0, MAX_X, 0, MAX_Y)), Ok(()));
    }

    #[test]
    fn intersection_of_disjoint_touching_and_nested_boxes() {
        let a = bx(0, 1_000_000, 0, 1_000_000);
        assert_eq!(intersection(&a, &bx(2_000_000, 3_000_000, 0, 1_000_000)), None);
        assert_eq!(intersection(&a, &bx(0, 1_000_000, 1_000_001, 2_000_000)), None);
        // Sharing only an edge: a zero-width line, not "no overlap".
        assert_eq!(intersection(&a, &bx(1_000_000, 2_000_000, 0, 1_000_000)), Some((0, 1_000_000)));
        // Sharing only a corner.
        assert_eq!(intersection(&a, &bx(1_000_000, 2_000_000, 1_000_000, 2_000_000)), Some((0, 0)));
        assert_eq!(intersection(&a, &bx(250_000, 750_000, 250_000, 750_000)), Some((500_000, 500_000)));
    }

    #[test]
    fn disjoint_zones_never_conflict() {
        let a = bx(0, 1_000_000, 0, 1_000_000);
        let far = bx(5_000_000, 6_000_000, 5_000_000, 6_000_000);
        assert_eq!(check_overlap(&ON, &a, &far), Ok(()));
    }

    #[test]
    fn a_generous_overlap_is_allowed() {
        let a = bx(0, 1_000_000, 0, 1_000_000);
        let b = bx(500_000, 1_500_000, 500_000, 1_500_000); // 500_000 x 500_000 overlap
        assert_eq!(check_overlap(&ON, &a, &b), Ok(()));
        assert_eq!(check_overlap(&ON, &b, &a), Ok(()), "symmetric");
    }

    #[test]
    fn a_sliver_overlap_is_rejected_because_it_pins_down_location() {
        let a = bx(0, 1_000_000, 0, 1_000_000);
        // Overlaps by 10_000 (one cell) in x: anyone in both is within a 110 m strip.
        let sliver = bx(990_000, 1_990_000, 0, 1_000_000);
        assert_eq!(check_overlap(&ON, &a, &sliver), Err(PrivacyError::OverlapTooSmall));
        assert_eq!(check_overlap(&ON, &sliver, &a), Err(PrivacyError::OverlapTooSmall));
    }

    #[test]
    fn a_shared_edge_or_corner_is_rejected() {
        let a = bx(0, 1_000_000, 0, 1_000_000);
        let edge = bx(1_000_000, 2_000_000, 0, 1_000_000);
        let corner = bx(1_000_000, 2_000_000, 1_000_000, 2_000_000);
        assert_eq!(check_overlap(&ON, &a, &edge), Err(PrivacyError::OverlapTooSmall));
        assert_eq!(check_overlap(&ON, &a, &corner), Err(PrivacyError::OverlapTooSmall));
    }

    #[test]
    fn overlap_below_k_cells_is_rejected_even_when_each_side_is_long_enough() {
        // min side is 300_000 = 30 cells, so 30 x 30 = 900 cells always clears
        // k = 25; raise k so the cell count is the binding constraint.
        let p = PrivacyParams { k_cells: 1_000, ..ON };
        let a = bx(0, 1_000_000, 0, 1_000_000);
        let b = bx(700_000, 1_700_000, 700_000, 1_700_000); // 30 x 30 = 900 cells
        assert_eq!(check_overlap(&p, &a, &b), Err(PrivacyError::OverlapTooSmall));
        assert_eq!(check_overlap(&ON, &a, &b), Ok(()));
    }

    #[test]
    fn identical_zones_overlap_completely_and_are_allowed() {
        let a = bx(0, 1_000_000, 0, 1_000_000);
        assert_eq!(check_overlap(&ON, &a, &a), Ok(()));
    }
}
