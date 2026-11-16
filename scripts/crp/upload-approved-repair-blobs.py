"""Upload immutable blobs for the user-approved repair. This does not move any Git ref."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

p = argparse.ArgumentParser()
p.add_argument("--repair", required=True)
p.add_argument("--output", required=True)
a = p.parse_args()
root = Path(a.repair).resolve(strict=True)
proposal = json.loads((root / "proposal.json").read_text(encoding="utf8"))
if proposal["approval"] != "USER_APPROVED_FOUR_ACQUISITIONS" or proposal["newAcquisitions"] != 4 or not proposal.get("legacyValidationPassed"):
    raise SystemExit("CRP_PUBLICATION_REVIEW_REQUIRED")
allowed = {"archive/rp/library/" + name for name in ("audit/knowledge-results.json", "rp/registry.json", "rp/retrieval-index.json", "rp/trees.json", "trees/backlinks.json", "verification-plan.json")}
if set(proposal["candidateMetadataFilesChanged"]) != allowed:
    raise SystemExit("CRP_PUBLICATION_SCOPE_CHANGED")
import base64
files = []
for relative in sorted(allowed):
    path = root / "candidate" / relative
    body = path.read_bytes()
    expected = hashlib.sha1(b"blob " + str(len(body)).encode() + b"\0" + body).hexdigest()
    payload = {"encoding": "base64", "content": base64.b64encode(body).decode()}
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf8", dir=root, suffix=".json", delete=False) as temp:
        json.dump(payload, temp)
        temp_name = temp.name
    try:
        sha = subprocess.check_output(["gh", "api", "--method", "POST", "repos/RMJ318/code-life-archive/git/blobs", "--input", temp_name, "--jq", ".sha"],
            env={**os.environ, "GH_PROMPT_DISABLED": "1", "GH_DEBUG": ""}, text=True, timeout=60).strip()
    finally:
        Path(temp_name).unlink()
    if sha != expected:
        raise SystemExit("CRP_PUBLICATION_BLOB_MISMATCH")
    files.append({"path": relative, "sha": sha, "mode": "100644", "type": "blob", "sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body)})
report = {"repository": "RMJ318/code-life-archive", "baseCommit": "fdaa6924eebbf6dae01a56035d24b21da217c376", "refUpdated": False, "newAcquisitions": 4, "files": files}
with Path(a.output).open("x", encoding="utf8") as file:
    json.dump(report, file, indent=2)
print(json.dumps({"uploadedImmutableBlobs": len(files), "refUpdated": False, "newAcquisitions": 4}))
