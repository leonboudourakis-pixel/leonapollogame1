#!/usr/bin/env python3
# Builds public/index.html: one self-contained file (works from the server and when opened directly).
# Needs Node:  npm install   then   python3 src/build.py   (uses esbuild and peerjs from node_modules)
import os, re, shutil, subprocess, tempfile
here = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(here, 'game.js')).read()
src = src.replace("from 'three';", "from './vendor/three.module.js';").replace("'three/addons/", "'./vendor/jsm/")
entry = os.path.join(here, '_entry.js'); open(entry, 'w').write(src)
out = os.path.join(tempfile.gettempdir(), 'tidebreak_bundle.js')
eb = os.path.join(here, '..', 'node_modules', '.bin', 'esbuild')
subprocess.run([eb if os.path.exists(eb) else shutil.which('esbuild') or 'esbuild', entry, '--bundle', '--format=iife', '--minify', '--target=safari15,chrome100', '--outfile=' + out], check=True)
os.remove(entry)
bundle = open(out).read().replace('</script', '<\\/script')
html = open(os.path.join(here, 'index.html')).read()
html = re.sub(r'<script type="importmap">.*?</script>\s*<script type="module" src="./game.js"></script>', lambda m: '<script>\n' + bundle + '\n</script>', html, flags=re.S)
os.makedirs(os.path.join(here, '..', 'public'), exist_ok=True)
open(os.path.join(here, '..', 'public', 'index.html'), 'w').write(html)
print('wrote public/index.html', len(html) // 1024, 'KB')
