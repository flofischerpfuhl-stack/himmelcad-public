"""Pull one image manifest of ghcr.io/taucad/opencascade.js by digest without Docker and unpack it into a root filesystem (OCI whiteouts applied). Every blob is verified against its SHA-256 digest.

usage: pull-image.py <manifest digest> <work dir>
"""
import json, urllib.request, sys, os, hashlib, tarfile, shutil
repo = "taucad/opencascade.js"
digest = sys.argv[1]
base = sys.argv[2]
blobs = base + "/blobs"; root = base + "/rootfs"
marker = base + "/pulled-digest"
if os.path.exists(marker) and open(marker).read().strip() == digest:
    print("image already unpacked:", digest); sys.exit(0)
if os.path.exists(root):
    shutil.rmtree(root)
os.makedirs(blobs, exist_ok=True); os.makedirs(root, exist_ok=True)
def tok():
    return json.load(urllib.request.urlopen(f"https://ghcr.io/token?scope=repository:{repo}:pull"))["token"]
def get(url, accept="*/*"):
    r = urllib.request.Request(url, headers={"Authorization": "Bearer " + tok(), "Accept": accept})
    return urllib.request.urlopen(r)
raw_manifest = get(f"https://ghcr.io/v2/{repo}/manifests/{digest}", "application/vnd.oci.image.manifest.v1+json").read()
assert "sha256:" + hashlib.sha256(raw_manifest).hexdigest() == digest, "manifest digest mismatch"
m = json.loads(raw_manifest)
open(base + "/manifest.json", "w").write(json.dumps(m, indent=1))
cfg = get(f"https://ghcr.io/v2/{repo}/blobs/{m['config']['digest']}").read()
assert "sha256:" + hashlib.sha256(cfg).hexdigest() == m["config"]["digest"], "config digest mismatch"
open(base + "/config.json", "wb").write(cfg)
for l in m["layers"]:
    d = l["digest"]; p = blobs + "/" + d.split(":")[1]
    if os.path.exists(p) and os.path.getsize(p) == l["size"]:
        continue
    print("download", d, l["size"], l["mediaType"], flush=True)
    h = hashlib.sha256()
    with get(f"https://ghcr.io/v2/{repo}/blobs/{d}") as r, open(p + ".part", "wb") as f:
        while True:
            c = r.read(1 << 20)
            if not c: break
            h.update(c); f.write(c)
    assert "sha256:" + h.hexdigest() == d, "digest mismatch " + d
    os.rename(p + ".part", p)
print("all blobs ok", flush=True)
for l in m["layers"]:
    p = blobs + "/" + l["digest"].split(":")[1]
    print("extract", l["digest"], flush=True)
    with tarfile.open(p, "r:*") as t:
        members = []
        for ti in t:
            name = ti.name.lstrip("./") if ti.name not in (".", "./") else ""
            bn = os.path.basename(name); dn = os.path.dirname(name)
            if bn == ".wh..wh..opq":
                tgt = os.path.join(root, dn)
                if os.path.isdir(tgt):
                    for e in os.listdir(tgt):
                        ep = os.path.join(tgt, e)
                        if os.path.isdir(ep) and not os.path.islink(ep): shutil.rmtree(ep)
                        else: os.remove(ep)
                continue
            if bn.startswith(".wh."):
                tgt = os.path.join(root, dn, bn[4:])
                if os.path.islink(tgt) or os.path.isfile(tgt): os.remove(tgt)
                elif os.path.isdir(tgt): shutil.rmtree(tgt)
                continue
            # replace existing non-dir entries
            tgt = os.path.join(root, name)
            if (os.path.islink(tgt) or os.path.isfile(tgt)) and not ti.isdir():
                os.remove(tgt)
            elif os.path.isdir(tgt) and not os.path.islink(tgt) and not ti.isdir():
                shutil.rmtree(tgt)
            t.extract(ti, root, set_attrs=True, numeric_owner=True)
open(marker, "w").write(digest)
print("done", flush=True)