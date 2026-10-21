#!/usr/bin/env python3
"""Split a large aegis.json asset into cacheable, bounded-size files."""

import argparse
import hashlib
import json
from pathlib import Path


def shard(source: Path, output: Path, chunk_bytes: int) -> Path:
    if chunk_bytes < 1:
        raise ValueError("chunk size must be positive")
    if source.stat().st_size == 0:
        raise ValueError("cannot shard an empty circuit artifact")
    output.mkdir(parents=True, exist_ok=True)
    files = []
    with source.open("rb") as stream:
        index = 0
        while chunk := stream.read(chunk_bytes):
            name = f"aegis.chunk{index:04d}"
            (output / name).write_bytes(chunk)
            files.append({"file": name, "bytes": len(chunk), "sha256": hashlib.sha256(chunk).hexdigest()})
            index += 1
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(part)
    manifest = {"version": 1, "bytes": source.stat().st_size, "sha256": digest.hexdigest(), "chunks": files}
    target = output / "aegis.manifest.json"
    target.write_text(json.dumps(manifest, separators=(",", ":")) + "\n", encoding="utf-8")
    return target


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--chunk-bytes", type=int, default=5 * 1024 * 1024)
    args = parser.parse_args()
    print(shard(args.source, args.output, args.chunk_bytes))


if __name__ == "__main__":
    main()
