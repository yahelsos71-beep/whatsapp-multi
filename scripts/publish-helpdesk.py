# מעלה גרסה של המוקד: מספר גרסה +1 ו-hash לכל קובץ שמתעדכן אוטומטית
import json, hashlib, os, sys
root = sys.argv[1] if len(sys.argv) > 1 else 'helpdesk'
files = ['server.js', 'reset-password.js', 'reset-password.bat', 'README-HE.txt'] + sorted('lib/' + f for f in os.listdir(os.path.join(root, 'lib')) if f.endswith('.js')) \
      + sorted('public/' + f for f in os.listdir(os.path.join(root, 'public')))
vf = os.path.join(root, 'version.json')
v = json.load(open(vf))
if '--same' not in sys.argv: v['version'] = int(v.get('version', 0)) + 1
notes = [a for a in sys.argv[2:] if not a.startswith('--')]
cl_path = os.path.join(root, 'public', 'changelog.json')
cl = json.load(open(cl_path, encoding='utf8')) if os.path.exists(cl_path) else []
if notes and '--same' not in sys.argv and not any(e['v'] == v['version'] for e in cl):
    cl.insert(0, {'v': v['version'], 'items': [x.strip() for x in notes[0].split(' | ') if x.strip()]})
    json.dump(cl[:60], open(cl_path, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
v['files'] = {f: hashlib.sha256(open(os.path.join(root, f), 'rb').read()).hexdigest() for f in files}
if notes: v['notes'] = notes[0]
json.dump(v, open(vf, 'w'), ensure_ascii=False, indent=2)
print(v['version'], len(files), 'files')
