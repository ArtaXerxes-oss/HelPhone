//! Render-path telemetry reader compiled to WebAssembly.
//! Combines FlatBuffers / Cap'n Proto render-path readers (spike, ADR-014)
//! with the zero-allocation telemetry frame reader (ISP-032).

#![no_std]
#![allow(static_mut_refs)]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// ===========================================================================
// ISP-032 Telemetry Frame Reader
// ===========================================================================

const MAGIC: u32 = 0x4845_4C50;
const VERSION: u8 = 1;
const FRAME_BYTES: usize = 40;
const INPUT_CAP: usize = 64 * 1024;
const MAX_FRAMES: usize = INPUT_CAP / FRAME_BYTES;
const OUTPUT_LEN: usize = MAX_FRAMES * 8;

static mut INPUT: [u8; INPUT_CAP] = [0; INPUT_CAP];
static mut OUTPUT: [f64; OUTPUT_LEN] = [0.0; OUTPUT_LEN];

#[no_mangle]
pub extern "C" fn input_ptr() -> *const u8 {
    core::ptr::addr_of!(INPUT).cast::<u8>()
}

#[no_mangle]
pub extern "C" fn input_cap() -> usize {
    INPUT_CAP
}

#[no_mangle]
pub extern "C" fn output_ptr() -> *const f64 {
    core::ptr::addr_of!(OUTPUT).cast::<f64>()
}

#[no_mangle]
pub extern "C" fn output_cap() -> usize {
    MAX_FRAMES
}

#[inline]
fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

#[inline]
fn read_f64(bytes: &[u8], offset: usize) -> f64 {
    f64::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7],
    ])
}

#[inline]
fn read_f32(bytes: &[u8], offset: usize) -> f32 {
    f32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

#[inline]
fn parse_one(input: &[u8], offset: usize, out: &mut [f64]) -> i32 {
    if offset + FRAME_BYTES > input.len() {
        return -1;
    }
    let frame = &input[offset..offset + FRAME_BYTES];

    if read_u32(frame, 0) != MAGIC {
        return -2;
    }
    if frame[4] != VERSION {
        return -3;
    }

    let kind = frame[5];
    if !(1..=5).contains(&kind) {
        return -4;
    }

    let priority = frame[6];
    if priority > 2 {
        return -5;
    }

    let flags = frame[7];
    let seq = read_u32(frame, 8);
    let ts = read_f64(frame, 12);
    let lat = read_f64(frame, 20);
    let lng = read_f64(frame, 28);
    let accuracy = read_f32(frame, 36);

    if !ts.is_finite() || !lat.is_finite() || !lng.is_finite() || !accuracy.is_finite() {
        return -6;
    }
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lng) {
        return -7;
    }

    out[0] = seq as f64;
    out[1] = ts;
    out[2] = lat;
    out[3] = lng;
    out[4] = accuracy as f64;
    out[5] = kind as f64;
    out[6] = priority as f64;
    out[7] = flags as f64;
    0
}

/// Parse the staged batch. Returns the number of frames on success, or a
/// negative status code on the first invalid frame.
#[no_mangle]
pub extern "C" fn parse_batch(len: usize, count: usize) -> i32 {
    if count == 0 || count > MAX_FRAMES || len < count * FRAME_BYTES || len > INPUT_CAP {
        return -1;
    }

    let input: &[u8] = unsafe { core::slice::from_raw_parts(INPUT.as_ptr(), len) };
    let output: &mut [f64] = unsafe { core::slice::from_raw_parts_mut(OUTPUT.as_mut_ptr(), OUTPUT_LEN) };

    for index in 0..count {
        let out = &mut output[index * 8..index * 8 + 8];
        let status = parse_one(input, index * FRAME_BYTES, out);
        if status != 0 {
            return status;
        }
    }
    count as i32
}

/// Single-frame compatibility entry point (used by parity tests).
#[no_mangle]
pub extern "C" fn parse_frame(len: usize) -> i32 {
    let parsed = parse_batch(len, 1);
    if parsed == 1 {
        0
    } else {
        parsed
    }
}

// ===========================================================================
// ADR-014 FlatBuffers & Cap'n Proto Render-Path Readers
// ===========================================================================

static mut NEEDED: u32 = 0;

/// Capacity required by the last call that returned -2.
#[no_mangle]
pub extern "C" fn needed() -> u32 {
    unsafe { NEEDED }
}

#[inline(always)]
fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    let s = b.get(at..at.checked_add(2)?)?;
    Some(u16::from_le_bytes([s[0], s[1]]))
}

#[inline(always)]
fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    let s = b.get(at..at.checked_add(4)?)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

#[inline(always)]
fn i32_at(b: &[u8], at: usize) -> Option<i32> {
    u32_at(b, at).map(|v| v as i32)
}

#[inline(always)]
fn u8_at(b: &[u8], at: usize) -> Option<u8> {
    b.get(at).copied()
}

struct Out {
    id: *mut u32,
    lat: *mut i32,
    lng: *mut i32,
    heading: *mut u16,
    kind: *mut u8,
    status: *mut u8,
}

impl Out {
    unsafe fn new(base: *mut u8, cap: usize) -> Out {
        Out {
            id: base as *mut u32,
            lat: base.add(4 * cap) as *mut i32,
            lng: base.add(8 * cap) as *mut i32,
            heading: base.add(12 * cap) as *mut u16,
            kind: base.add(14 * cap),
            status: base.add(15 * cap),
        }
    }

    #[inline(always)]
    unsafe fn write(&self, i: usize, id: u32, kind: u8, status: u8, lat: i32, lng: i32, heading: u16) {
        *self.id.add(i) = id;
        *self.kind.add(i) = kind;
        *self.status.add(i) = status;
        *self.lat.add(i) = lat;
        *self.lng.add(i) = lng;
        *self.heading.add(i) = heading;
    }
}

fn finish(r: Option<i32>) -> i32 {
    r.unwrap_or(-1)
}

// ---------------------------------------------------------------------------
// FlatBuffers (src/schemas/telemetry.fbs)

// vtable slots: 4 + 2 * field id
const VT_ID: usize = 4;
const VT_KIND: usize = 6;
const VT_STATUS: usize = 8;
const VT_LAT: usize = 12;
const VT_LNG: usize = 14;
const VT_HEADING: usize = 16;

#[inline(always)]
fn vt_field(b: &[u8], vt: usize, size: u16, slot: usize) -> Option<usize> {
    Some(if slot < size as usize { u16_at(b, vt + slot)? as usize } else { 0 })
}

#[inline(always)]
fn table_vtable(b: &[u8], table: usize) -> Option<usize> {
    let soff = i32_at(b, table)? as isize;
    usize::try_from(table as isize - soff).ok()
}

fn fb(b: &[u8], out: *mut u8, cap: usize) -> Option<i32> {
    let root = u32_at(b, 0)? as usize;
    let rvt = table_vtable(b, root)?;
    let rsize = u16_at(b, rvt)?;
    let objects = vt_field(b, rvt, rsize, 8)?;
    if objects == 0 {
        return Some(0);
    }
    let slot = root + objects;
    let vec = slot.checked_add(u32_at(b, slot)? as usize)?;
    let n = u32_at(b, vec)? as usize;
    if n > cap {
        unsafe { NEEDED = n as u32 };
        return Some(-2);
    }
    let o = unsafe { Out::new(out, cap) };
    // The encoder shares vtables between objects; resolve each one once.
    let mut last_vt = usize::MAX;
    let (mut f_id, mut f_kind, mut f_status, mut f_lat, mut f_lng, mut f_heading) = (0, 0, 0, 0, 0, 0);
    for i in 0..n {
        let s = vec + 4 + i * 4;
        let t = s.checked_add(u32_at(b, s)? as usize)?;
        let vt = table_vtable(b, t)?;
        if vt != last_vt {
            let size = u16_at(b, vt)?;
            f_id = vt_field(b, vt, size, VT_ID)?;
            f_kind = vt_field(b, vt, size, VT_KIND)?;
            f_status = vt_field(b, vt, size, VT_STATUS)?;
            f_lat = vt_field(b, vt, size, VT_LAT)?;
            f_lng = vt_field(b, vt, size, VT_LNG)?;
            f_heading = vt_field(b, vt, size, VT_HEADING)?;
            last_vt = vt;
        }
        let id = if f_id != 0 { u32_at(b, t + f_id)? } else { 0 };
        let kind = if f_kind != 0 { u8_at(b, t + f_kind)? } else { 0 };
        let status = if f_status != 0 { u8_at(b, t + f_status)? } else { 0 };
        let lat = if f_lat != 0 { i32_at(b, t + f_lat)? } else { 0 };
        let lng = if f_lng != 0 { i32_at(b, t + f_lng)? } else { 0 };
        let heading = if f_heading != 0 { u16_at(b, t + f_heading)? } else { 0 };
        unsafe { o.write(i, id, kind, status, lat, lng, heading) };
    }
    Some(n as i32)
}

#[no_mangle]
pub extern "C" fn fb_positions(input: *const u8, len: usize, out: *mut u8, cap: usize) -> i32 {
    let b = unsafe { core::slice::from_raw_parts(input, len) };
    finish(fb(b, out, cap))
}

// ---------------------------------------------------------------------------
// Cap'n Proto (src/schemas/telemetry.capnp), unpacked, up to 64 segments.

const CP_ID: usize = 0;
const CP_LAT: usize = 4;
const CP_LNG: usize = 8;
const CP_HEADING: usize = 20;
const CP_KIND: usize = 32;
const CP_STATUS: usize = 34;
const MAX_SEGMENTS: usize = 64;

/// Follows a (possibly far / double-far) pointer. Returns the content byte
/// position and the (lo, hi) words describing it.
fn cp_resolve(b: &[u8], segs: &[usize], at: usize) -> Option<(usize, u32, u32)> {
    let lo = u32_at(b, at)?;
    let hi = u32_at(b, at + 4)?;
    if lo == 0 && hi == 0 {
        return None;
    }
    let near = |p: usize, lo: u32| -> Option<usize> {
        usize::try_from(p as isize + 8 + ((lo as i32) >> 2) as isize * 8).ok()
    };
    if lo & 3 != 2 {
        return Some((near(at, lo)?, lo, hi));
    }
    let seg = *segs.get(hi as usize)?;
    let pad = seg + (lo >> 3) as usize * 8;
    if lo & 4 == 0 {
        let plo = u32_at(b, pad)?;
        if plo & 3 == 2 {
            return None;
        }
        return Some((near(pad, plo)?, plo, u32_at(b, pad + 4)?));
    }
    let flo = u32_at(b, pad)?;
    let cseg = *segs.get(u32_at(b, pad + 4)? as usize)?;
    if flo & 7 != 2 {
        return None;
    }
    Some((cseg + (flo >> 3) as usize * 8, u32_at(b, pad + 8)?, u32_at(b, pad + 12)?))
}

fn capnp(b: &[u8], out: *mut u8, cap: usize) -> Option<i32> {
    let seg_count = u32_at(b, 0)? as usize + 1;
    if seg_count > MAX_SEGMENTS {
        return None;
    }
    let mut segs = [0usize; MAX_SEGMENTS];
    let mut at = (4 + 4 * seg_count + 7) & !7;
    for (i, s) in segs.iter_mut().enumerate().take(seg_count) {
        *s = at;
        at = at.checked_add(u32_at(b, 4 + 4 * i)? as usize * 8)?;
    }
    if at > b.len() {
        return None;
    }
    let segs = &segs[..seg_count];
    let (frame, rlo, rhi) = cp_resolve(b, segs, segs[0])?;
    if rlo & 3 != 0 {
        return None;
    }
    let data_bytes = (rhi & 0xffff) as usize * 8;
    if rhi >> 16 == 0 {
        return Some(0);
    }
    let (tag, llo, lhi) = match cp_resolve(b, segs, frame + data_bytes) {
        Some(r) => r,
        None => return Some(0),
    };
    if llo & 3 != 1 || lhi & 7 != 7 {
        return None;
    }
    let n = (u32_at(b, tag)? >> 2) as usize;
    let tag_hi = u32_at(b, tag + 4)?;
    let elem_data = (tag_hi & 0xffff) as usize * 8;
    let stride = elem_data + (tag_hi >> 16) as usize * 8;
    if n.checked_mul(stride)? > (lhi >> 3) as usize * 8 {
        return None;
    }
    if n > cap {
        unsafe { NEEDED = n as u32 };
        return Some(-2);
    }
    let o = unsafe { Out::new(out, cap) };
    let field = |s: usize, off: usize, size: usize| off + size <= elem_data && s + off + size <= b.len();
    let mut s = tag + 8;
    for i in 0..n {
        let id = if field(s, CP_ID, 4) { u32_at(b, s + CP_ID)? } else { 0 };
        let lat = if field(s, CP_LAT, 4) { i32_at(b, s + CP_LAT)? } else { 0 };
        let lng = if field(s, CP_LNG, 4) { i32_at(b, s + CP_LNG)? } else { 0 };
        let heading = if field(s, CP_HEADING, 2) { u16_at(b, s + CP_HEADING)? } else { 0 };
        let kind = if field(s, CP_KIND, 2) { u16_at(b, s + CP_KIND)? as u8 } else { 0 };
        let status = if field(s, CP_STATUS, 2) { u16_at(b, s + CP_STATUS)? as u8 } else { 0 };
        unsafe { o.write(i, id, kind, status, lat, lng, heading) };
        s += stride;
    }
    Some(n as i32)
}

#[no_mangle]
pub extern "C" fn capnp_positions(input: *const u8, len: usize, out: *mut u8, cap: usize) -> i32 {
    let b = unsafe { core::slice::from_raw_parts(input, len) };
    finish(capnp(b, out, cap))
}
