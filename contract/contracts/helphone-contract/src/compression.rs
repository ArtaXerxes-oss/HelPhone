use soroban_sdk::{BytesN, Env};

/// Lossless 16-byte encoding: signed latitude (i32), signed longitude (i32), ledger timestamp (u64).
pub fn pack_location(env: &Env, lat: i32, lng: i32, timestamp: u64) -> BytesN<16> {
    let mut bytes = [0u8; 16];
    bytes[..4].copy_from_slice(&lat.to_be_bytes());
    bytes[4..8].copy_from_slice(&lng.to_be_bytes());
    bytes[8..].copy_from_slice(&timestamp.to_be_bytes());
    BytesN::from_array(env, &bytes)
}

pub fn unpack_location(packed: &BytesN<16>) -> (i32, i32, u64) {
    let bytes = packed.to_array();
    (
        i32::from_be_bytes(bytes[..4].try_into().expect("four-byte latitude")),
        i32::from_be_bytes(bytes[4..8].try_into().expect("four-byte longitude")),
        u64::from_be_bytes(bytes[8..].try_into().expect("eight-byte timestamp")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Env;

    #[test]
    fn round_trips_signed_coordinates_and_full_timestamp() {
        let env = Env::default();
        let cases = [
            (-90_000_000, -180_000_000, 0),
            (90_000_000, 180_000_000, u64::MAX),
        ];
        for (lat, lng, timestamp) in cases {
            assert_eq!(
                unpack_location(&pack_location(&env, lat, lng, timestamp)),
                (lat, lng, timestamp)
            );
        }
    }
}
