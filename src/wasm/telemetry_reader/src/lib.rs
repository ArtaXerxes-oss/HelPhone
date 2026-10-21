//! Render-path telemetry reader compiled to WebAssembly (spike, ADR-014).
//!
//! Mirrors `readFlatBuffersPositions` / `readCapnpPositions` in
//! src/utils/binaryParser.js: given a frame that the host has copied into
//! linear memory, it writes id, kind, status, lat, lng and heading into a
//! struct-of-arrays output region. The JS wrapper is
//! src/utils/binaryParserWasm.js.
//!
//! Output layout for capacity `cap` (a multiple of 4), starting at `out`:
//!   id: u32[cap] | lat_e6: i32[cap] | lng_e6: i32[cap] |
//!   heading_cdeg: u16[cap] | kind: u8[cap] | status: u8[cap]
//!
//! Return value: object count (>= 0), or
//!   -1  malformed input (out-of-bounds offset, wrong pointer kind, ...)
//!   -2  `cap` too small; `needed()` reports the required capacity.
//! Every read is bounds-checked, so a hostile frame cannot read outside
//! the input slice.

#![no_std]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

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
