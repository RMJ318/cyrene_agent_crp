"""Refresh only derived indexes for the explicitly approved four-record repair, in its isolated candidate."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

p = argparse.ArgumentParser()
p.add_argument("--candidate", required=True)
p.add_argument("--base", required=True)
p.add_argument("--validators", required=True)
a = p.parse_args()
root, base, validators = (Path(x).resolve(strict=True) for x in (a.candidate, a.base, a.validators))
proposal_path = root.parent / "proposal.json"
proposal = json.loads(proposal_path.read_text(encoding="utf8"))
if root.is_relative_to(base) or base.is_relative_to(root) or proposal["newAcquisitions"] != 4 or proposal["baseSnapshotId"] != json.loads((base / "snapshot.json").read_bytes())["snapshotId"]:
    raise SystemExit("CRP_REPAIR_FINALIZATION_SCOPE")
pins = {"crp.py": "8c89608a54b2ab22d2ef24cd9e413529b8033280", "tree_indexes.py": "f61f6f83d58c6b614169f2d36ae2e56621eca7b7", "profiles_cases.py": "210681c6741995795925ba83fab3434d5ba726c3"}
for name, expected in pins.items():
    body = (validators / name).read_bytes()
    if hashlib.sha1(b"blob " + str(len(body)).encode() + b"\0" + body).hexdigest() != expected:
        raise SystemExit("CRP_REPAIR_VALIDATOR_HASH")
sys.path.insert(0, str(validators))
import crp
import tree_indexes
data = crp.load_data(root)
evs = crp.get(root, crp.ROOT + "/evidence/registry.json", {})
crp.check(root, crp.get(root, crp.ROOT + "/sources.json", {}), evs, data)
manifest = json.loads((root / "snapshot.json").read_bytes())
outputs = tree_indexes.outputs(data, evs)
relative = crp.ROOT + "/rp/retrieval-index.json"
retrieval = crp.get(root, relative, {})
retrieval["entity_ids"]["acquisitions"] = sorted(crp.get(root, crp.ROOT + "/rp/registry.json", {})["acquisitions"])
outputs[relative] = crp.enc(retrieval)
for relative, body in outputs.items():
    if relative not in manifest["files"]:
        raise SystemExit("CRP_REPAIR_UNEXPECTED_INDEX")
    (root / relative).write_bytes(body)
    manifest["files"][relative] = hashlib.sha256(body).hexdigest()
plan_path = crp.ROOT + "/verification-plan.json"
if plan_path in manifest["files"]:
    plan = crp.get(root, plan_path, {})
    for relative in plan.get("files", {}):
        if relative != plan_path and relative in manifest["files"]:
            plan["files"][relative] = manifest["files"][relative]
    body = crp.enc(plan)
    (root / plan_path).write_bytes(body)
    manifest["files"][plan_path] = hashlib.sha256(body).hexdigest()
(root / "snapshot.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf8")
links = tree_indexes.validate_stored(root, evs)
base_manifest = json.loads((base / "snapshot.json").read_bytes())
changed = []
for relative, digest in base_manifest["files"].items():
    if hashlib.sha256((base / relative).read_bytes()).hexdigest() != digest:
        raise SystemExit("CRP_REPAIR_BASE_CHANGED")
    if manifest["files"][relative] != digest:
        changed.append(relative)
for relative in changed:
    if relative.endswith(".md"):
        raise SystemExit("CRP_REPAIR_SOURCE_TEXT_CHANGED")
proposal.update({"approval": "USER_APPROVED_FOUR_ACQUISITIONS", "candidateMetadataFilesChanged": sorted(changed), "legacyValidationPassed": True, "bidirectionalTreeLinks": links})
proposal_path.write_text(json.dumps(proposal, ensure_ascii=False, indent=2), encoding="utf8")
print(json.dumps({"legacyValidationPassed": True, "bidirectionalTreeLinks": links, "changedMetadataFiles": sorted(changed), "newAcquisitions": 4, "originalFilesUnchanged": len(base_manifest["files"]), "fullAuditPromoted": False}))
