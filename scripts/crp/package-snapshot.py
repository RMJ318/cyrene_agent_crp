"""Package exactly the manifest's files. Never copy unregistered files or change source bytes."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument("--snapshot", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
root = Path(args.snapshot).resolve(strict=True)
output = Path(args.output).resolve()
if output.is_relative_to(root) or output.exists():
    raise SystemExit("CRP_PACKAGE_OUTPUT_DENIED")
manifest_bytes = (root / "snapshot.json").read_bytes()
manifest = json.loads(manifest_bytes)
files = manifest.get("files")
if manifest.get("version") != 1 or not isinstance(files, dict) or not files or len(files) > 10000:
    raise SystemExit("CRP_PACKAGE_MANIFEST")

def verified(relative, expected=None):
    if not relative or "\\" in relative or ":" in relative or any(p in ("", ".", "..") for p in relative.split("/")):
        raise ValueError("CRP_PACKAGE_PATH")
    current = root
    for part in relative.split("/"):
        current /= part
        if current.is_symlink():
            raise ValueError("CRP_PACKAGE_PATH")
    if not current.resolve(strict=True).is_relative_to(root) or not current.is_file():
        raise ValueError("CRP_PACKAGE_PATH")
    if expected and hashlib.sha256(current.read_bytes()).hexdigest() != expected:
        raise ValueError("CRP_PACKAGE_SOURCE_CHANGED")
    return current

output.parent.mkdir(parents=True, exist_ok=True)
with output.open("xb") as destination:
    with tarfile.open(fileobj=destination, mode="w:gz") as archive:
        archive.add(verified("snapshot.json"), arcname="snapshot.json", recursive=False)
        for relative, expected in sorted(files.items()):
            archive.add(verified(relative, expected), arcname=relative, recursive=False)
for relative, expected in files.items():
    verified(relative, expected)
if (root / "snapshot.json").read_bytes() != manifest_bytes:
    raise SystemExit("CRP_PACKAGE_SOURCE_CHANGED")
print(json.dumps({"packagedFiles": len(files), "manifestIncluded": True, "sourceUnchanged": True, "modelCalls": 0}))
