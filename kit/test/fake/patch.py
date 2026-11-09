# A stand-in for spaces-flat-patch.py: writes what the real one writes, in the shape trimLayout knows.
# FAKE_PATCH_FAIL set: stops like the real one does when Herdr changed its text.
import json, os, shutil, sys
home = sys.argv[1]
if os.environ.get("FAKE_PATCH_FAIL"):
    sys.exit("spaces-flat: Herdr changed the code for 'imports'; patch it by hand.")
open(f"{home}/mods/spaces-flat/styles.js", "w").write("// styles\n")
shutil.copy(f"{home}/mods/space-groups/groups.js", f"{home}/mods/agent-queue/groups.js")
layout = {"root": {"id": "root", "type": "row", "children": [
    {"id": "sidebar", "type": "column", "children": [{"id": "spaces", "type": "block", "content": {"mod": "spaces-flat"}},
                                                      {"id": "queue", "type": "block", "content": {"mod": "agent-queue"}}]},
    {"id": "work", "type": "column", "children": [
        {"id": "viewbar", "type": "block", "content": {"mod": "viewbar", "props": {"role": "bar"}}},
        {"id": "body", "type": "row", "children": [
            {"id": "main-stack", "type": "stack", "active": "main", "children": [
                {"id": "main", "type": "block", "content": {"tab": "active"}},
                {"id": "plan", "type": "block", "content": {"mod": "plan-review"}}]},
            {"id": "side", "type": "column", "children": [{"id": "side-stack", "type": "stack", "children": [
                {"id": "side-view", "type": "block", "content": {"mod": "viewbar", "props": {"role": "side"}}},
                {"id": "side-prs", "type": "block", "content": {"mod": "prs"}}]}]}]},
        {"id": "status", "type": "row", "size": {"px": 28}, "children": [
            {"id": "usage", "type": "block", "content": {"mod": "agent-usage", "props": {"role": "bar"}}},
            {"id": "keys", "type": "block", "content": {"mod": "viewbar", "props": {"role": "keys-button"}}}]}]}]}}
json.dump(layout, open(f"{home}/layouts/main-flat.json", "w"), indent=2)
print("patched")
