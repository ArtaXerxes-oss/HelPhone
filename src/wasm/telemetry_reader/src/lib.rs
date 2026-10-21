//! Zero-allocation telemetry frame reader.
//!
//! The JS bridge copies a whole batch into a fixed staging buffer, calls
//! `parse_batch(len, count)` once, and reads a fixed-size output array. No
//! Vec, no per-frame boundary crossing, no per-frame allocation.
//!
//! Output layout (8 × f64 per frame):
//!   seq | ts | lat | lng | accuracy | kind | priority | flags
//!
//! Status codes (negative):
//!   -1 truncated, -2 bad magic, -3 bad version, -4 bad kind, -5 bad priority,
//!   -6 non-finite, -7 out-of-range latitude/longitude

#![allow(static_mut_refs)]

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
