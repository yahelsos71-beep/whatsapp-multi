# מעלה גרסה: מעלה מספר גרסה ומחשב hash לכל קובץ
import json, hashlib, sys, os
os.chdir(sys.argv[1])
files = ["app-main.js", "index.html", "renderer.js", "inject.js", "changelog.json"]
v = json.load(open("version.json"))
v["version"] = int(v.get("version", 0)) + (1 if len(sys.argv) < 3 or sys.argv[2] != "--same" else 0)
if len(sys.argv) > 3 and (len(sys.argv) < 3 or sys.argv[2] != "--same"):
    cl = json.load(open("changelog.json", encoding="utf8")) if os.path.exists("changelog.json") else []
    if not any(e["v"] == v["version"] for e in cl):
        cl.insert(0, {"v": v["version"], "items": [x.strip() for x in sys.argv[3].split(" | ") if x.strip()]})
        json.dump(cl[:60], open("changelog.json", "w", encoding="utf8"), ensure_ascii=False, indent=1)
v["files"] = {f: hashlib.sha256(open(f, "rb").read()).hexdigest() for f in files}
if len(sys.argv) > 3: v["notes"] = sys.argv[3]
json.dump(v, open("version.json", "w"), ensure_ascii=False, indent=2)
print(v["version"])
