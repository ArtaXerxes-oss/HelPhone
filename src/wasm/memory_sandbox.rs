//! Spike #602 — per-purpose WebAssembly sandbox with its own linear memory.
//!
//! One instance of this module is created per trust domain (encrypted audio
//! processing, ZK witness scratch). Each instance owns exactly one linear
//! memory and can only address that memory, so an out-of-bounds bug in the
//! audio path cannot read ZK secrets: they live in a different instance's
//! memory. Cross-domain transfer is done by the host (src/utils/wasmLoader.js),
//! either with a multi-memory `memory.copy` bridge or a JS copy fallback.
//!
//! Deliberately `no_std` with raw exports instead of wasm-bindgen: the loader
//! needs direct control over which memory is exported/imported, and the
//! module stays ~1 KB with no JS glue. Build (no Cargo project needed):
//!
//!   npm run build:wasm-sandbox
//!   # = rustc --target wasm32-unknown-unknown --crate-type cdylib -C opt-level=s \
//!   #         -C panic=abort -C strip=symbols src/wasm/memory_sandbox.rs \
//!   #         -o src/wasm/memory_sandbox.wasm
#![no_std]

use core::arch::wasm32;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    wasm32::unreachable()
}

extern "C" {
    static __heap_base: u8;
}

const PAGE: usize = 65_536;
static mut HEAP_TOP: usize = 0;

fn heap_base() -> usize {
    // SAFETY: linker-provided symbol; only its address is used.
    unsafe { &__heap_base as *const u8 as usize }
}

/// Bump allocator: returns an 8-byte aligned pointer to `len` bytes, growing
/// linear memory as needed. Returns 0 when the memory cannot grow.
#[no_mangle]
pub extern "C" fn sandbox_alloc(len: usize) -> usize {
    // SAFETY: single-threaded wasm instance; HEAP_TOP is only touched here and in reset.
    unsafe {
        if HEAP_TOP == 0 {
            HEAP_TOP = heap_base();
        }
        let ptr = (HEAP_TOP + 7) & !7;
        let end = match ptr.checked_add(len) {
            Some(e) => e,
            None => return 0,
        };
        let have = wasm32::memory_size(0) * PAGE;
        if end > have {
            let need = (end - have + PAGE - 1) / PAGE;
            if wasm32::memory_grow(0, need) == usize::MAX {
                return 0;
            }
        }
        HEAP_TOP = end;
        ptr
    }
}

/// Wipes every byte allocated so far, then releases all allocations.
#[no_mangle]
pub extern "C" fn sandbox_reset() {
    // SAFETY: see sandbox_alloc.
    unsafe {
        if HEAP_TOP > heap_base() {
            sandbox_wipe(heap_base(), HEAP_TOP - heap_base());
        }
        HEAP_TOP = heap_base();
    }
}

/// Zeroes `len` bytes at `ptr` with volatile writes the optimiser cannot elide,
/// so ZK witnesses/keys do not linger in linear memory after use.
#[no_mangle]
pub extern "C" fn sandbox_wipe(ptr: usize, len: usize) {
    let p = ptr as *mut u8;
    for i in 0..len {
        // SAFETY: caller passes a range previously returned by sandbox_alloc.
        unsafe { core::ptr::write_volatile(p.add(i), 0) };
    }
}

/// FNV-1a over `len` bytes: lets the host verify a transfer without copying
/// the payload back out.
#[no_mangle]
pub extern "C" fn sandbox_checksum(ptr: usize, len: usize) -> u32 {
    let bytes = unsafe { core::slice::from_raw_parts(ptr as *const u8, len) };
    let mut h: u32 = 0x811c_9dc5;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Stand-in for audio DSP: applies a Q8 fixed-point gain to 16-bit PCM
/// in place with saturation. Returns the peak absolute sample afterwards.
#[no_mangle]
pub extern "C" fn audio_gain(ptr: usize, samples: usize, gain_q8: i32) -> u32 {
    let pcm = unsafe { core::slice::from_raw_parts_mut(ptr as *mut i16, samples) };
    let mut peak = 0u32;
    for s in pcm.iter_mut() {
        let v = ((*s as i32 * gain_q8) >> 8).clamp(i16::MIN as i32, i16::MAX as i32);
        *s = v as i16;
        peak = peak.max(v.unsigned_abs());
    }
    peak
}
