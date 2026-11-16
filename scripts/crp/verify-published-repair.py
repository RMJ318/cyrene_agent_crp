"""Verify immutable GitHub content and the exact tree delta before moving any branch."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess

p = argparse.ArgumentParser()
p.add_argument("--blobs", required=True)
p.add_argument("--commit", required=True)
p.add_argument("--tree", required=True)
p.add_argument("--output", required=True)
a = p.parse_args()
manifest = json.loads(Path(a.blobs).read_text(encoding="utf8"))
repo = manifest["repository"]
if repo != "RMJ318/code-life-archive" or manifest["newAcquisitions"] != 4:
    raise SystemExit("CRP_READBACK_SCOPE")

def get(endpoint):
    return json.loads(subprocess.check_output(["gh", "api", "repos/" + repo + "/" + endpoint], env={**os.environ, "GH_PROMPT_DISABLED": "1", "GH_DEBUG": ""}, timeout=60))

commit = get("git/commits/" + a.commit)
if commit["tree"]["sha"] != a.tree or [parent["sha"] for parent in commit["parents"]] != [manifest["baseCommit"]]:
    raise SystemExit("CRP_READBACK_COMMIT")
old = get("git/trees/" + manifest["baseCommit"] + "?recursive=1")
new = get("git/trees/" + a.tree + "?recursive=1")
if old.get("truncated") or new.get("truncated"):
    raise SystemExit("CRP_READBACK_TREE_TRUNCATED")
before = {row["path"]: (row["sha"], row["mode"], row["type"]) for row in old["tree"] if row["type"] != "tree"}
after = {row["path"]: (row["sha"], row["mode"], row["type"]) for row in new["tree"] if row["type"] != "tree"}
changed = {path for path in before.keys() | after.keys() if before.get(path) != after.get(path)}
if changed != {file["path"] for file in manifest["files"]}:
    raise SystemExit("CRP_READBACK_UNRELATED_CHANGE")
for file in manifest["files"]:
    if after[file["path"]][0] != file["sha"]:
        raise SystemExit("CRP_READBACK_TREE_BLOB")
    blob = get("git/blobs/" + file["sha"])
    body = base64.b64decode(blob["content"])
    if hashlib.sha256(body).hexdigest() != file["sha256"] or len(body) != file["bytes"]:
        raise SystemExit("CRP_READBACK_CONTENT_HASH")
report = {"repository": repo, "commit": a.commit, "tree": a.tree, "baseCommit": manifest["baseCommit"], "verifiedBlobs": len(manifest["files"]),
          "changedPaths": sorted(changed), "allOtherPathsUnchanged": True, "rawSourceFilesChanged": 0, "readbackAt": datetime.now(timezone.utc).isoformat(), "branchMovedByThisCommand": False}
with Path(a.output).open("x", encoding="utf8") as file:
    json.dump(report, file, indent=2)
print(json.dumps(report))
