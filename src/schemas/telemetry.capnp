# HelPhone live-map telemetry: Cap'n Proto schema (spike, ADR-014).
#
# Logically identical to telemetry.fbs and telemetry.proto. See the .fbs
# file for the field semantics; this file only repeats what differs.
#
# The hand-written reader in src/utils/binaryParser.js hard-codes the slot
# offsets that the capnp compiler assigns to these fields. They are pinned
# in the comments below (from `capnp compile -ocapnp telemetry.capnp`); any
# change here must be re-checked with that command and mirrored there.
#
# Enums are 16 bits on the wire in Cap'n Proto (vs 8 in FlatBuffers).

@0xd662a3a15e12d407;

enum ObjectKind {
  request @0;
  responder @1;
}

enum Status {
  pending @0;
  enroute @1;
  resolved @2;
  cancelled @3;
}

enum Priority {
  low @0;
  medium @1;
  high @2;
  critical @3;
}

struct MapObject {
  # Data section: 5 words (40 bytes). Pointer section: 3 words.
  id @0 :UInt32;              # bits[0, 32)
  latE6 @1 :Int32;            # bits[32, 64)
  lngE6 @2 :Int32;            # bits[64, 96)
  etaSeconds @3 :UInt32;      # bits[96, 128)
  requestId @4 :UInt32;       # bits[128, 160)
  tsMs @5 :Float64;           # bits[192, 256)
  headingCdeg @6 :UInt16;     # bits[160, 176)
  speedCms @7 :UInt16;        # bits[176, 192)
  kind @8 :ObjectKind;        # bits[256, 272)
  status @9 :Status;          # bits[272, 288)
  priority @10 :Priority;     # bits[288, 304)
  emergencyType @11 :Text;    # ptr[0]
  responder @12 :Text;        # ptr[1]
  trail @13 :List(Int32);     # ptr[2]
}

struct TelemetryFrame {
  # Data section: 2 words. Pointer section: 1 word.
  seq @0 :UInt32;             # bits[0, 32)
  sentAtMs @1 :Float64;       # bits[64, 128)
  objects @2 :List(MapObject); # ptr[0]
}
