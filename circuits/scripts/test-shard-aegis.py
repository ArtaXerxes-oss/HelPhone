import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("shard-aegis.py")
SPEC = importlib.util.spec_from_file_location("shard_aegis", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ShardAegisTests(unittest.TestCase):
    def test_shards_reassemble_and_manifest_sizes_match(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "aegis.json"
            payload = bytes(range(256)) * 9
            source.write_bytes(payload)
            manifest_path = MODULE.shard(source, root / "out", 512)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            rebuilt = b"".join((manifest_path.parent / item["file"]).read_bytes() for item in manifest["chunks"])
            self.assertEqual(rebuilt, payload)
            self.assertTrue(all(item["bytes"] <= 512 for item in manifest["chunks"]))


if __name__ == "__main__":
    unittest.main()
