# מעלה גרסה של המוקד: מספר גרסה +1 ו-hash לכל קובץ שמתעדכן אוטומטית
import json, hashlib, os, sys
root = sys.argv[1] if len(sys.argv) > 1 else 'helpdesk'
files = ['server.js'] + sorted('lib/' + f for f in os.listdir(os.path.join(root, 'lib')) if f.endswith('.js')) \
      + sorted('public/' + f for f in os.listdir(os.path.join(root, 'public')))
vf = os.path.join(root, 'version.json')
v = json.load(open(vf))
if '--same' not in sys.argv: v['version'] = int(v.get('version', 0)) + 1
v['files'] = {f: hashlib.sha256(open(os.path.join(root, f), 'rb').read()).hexdigest() for f in files}
notes = [a for a in sys.argv[2:] if not a.startswith('--')]
if notes: v['notes'] = notes[0]
json.dump(v, open(vf, 'w'), ensure_ascii=False, indent=2)
print(v['version'], len(files), 'files')
