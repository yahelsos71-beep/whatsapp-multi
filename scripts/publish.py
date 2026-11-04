# מעלה גרסה: מעלה מספר גרסה ומחשב hash לכל קובץ
import json, hashlib, sys, os
os.chdir(sys.argv[1])
files = ["app-main.js", "index.html", "renderer.js", "inject.js"]
v = json.load(open("version.json"))
v["version"] = int(v.get("version", 0)) + (1 if len(sys.argv) < 3 or sys.argv[2] != "--same" else 0)
v["files"] = {f: hashlib.sha256(open(f, "rb").read()).hexdigest() for f in files}
if len(sys.argv) > 3: v["notes"] = sys.argv[3]
json.dump(v, open("version.json", "w"), ensure_ascii=False, indent=2)
print(v["version"])
