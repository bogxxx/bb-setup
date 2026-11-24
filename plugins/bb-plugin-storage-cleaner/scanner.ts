// The disk scanner the server runs with python3. Python, because its ctypes
// reaches getattrlistbulk(2): one syscall lists a directory with each file's
// allocated, private (unshared with APFS clones) and clone-count sizes, which
// Node can't read. Workers split the tree across the CPUs.
//
// Usage: python3 scan.py <root> <out.json>. Every node carries
//   s  share of real disk use: clone-shared blocks split across the clones,
//      hard links split across their links, so the volume sums right;
//   u  bytes only this item holds, freed for sure when it is deleted;
//   a  allocated bytes as du and Finder count them.
export const SCANNER_PY = String.raw`
import ctypes, heapq, json, os, queue, stat, struct, sys, time
from multiprocessing import Pool

KEEP = 1024 * 1024
MAX_KIDS = 300
BUDGET = 30000
TOP_FILES = 400
BIG_FILE = 50 * 1024 * 1024
VREG, VDIR, VLNK = 1, 2, 5

if sys.platform == "darwin":
    libc = ctypes.CDLL(None, use_errno=True)

    class AttrList(ctypes.Structure):
        _fields_ = [("bitmapcount", ctypes.c_ushort), ("reserved", ctypes.c_uint16),
                    ("commonattr", ctypes.c_uint32), ("volattr", ctypes.c_uint32),
                    ("dirattr", ctypes.c_uint32), ("fileattr", ctypes.c_uint32),
                    ("forkattr", ctypes.c_uint32)]

    libc.getattrlistbulk.argtypes = [ctypes.c_int, ctypes.POINTER(AttrList), ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint64]
    libc.getattrlistbulk.restype = ctypes.c_int
    # common: returned attrs, name, devid, objtype, modtime, error; dir: mount status;
    # file: link count, alloc size; extended common: private size, clone refcount
    ATTRS = AttrList(5, 0, 0x80000000 | 0x1 | 0x2 | 0x8 | 0x400 | 0x20000000, 0, 0x8, 0x1 | 0x4, 0x8 | 0x1000)
    BUFSZ = 256 * 1024
    BUF = ctypes.create_string_buffer(BUFSZ)
    U32, I32, Q, RET, TS = (struct.Struct(f).unpack_from for f in ("=I", "=i", "=q", "=IIIII", "=qq"))

    def listdir(path):
        """Yield (name, type, dev, mtime, nlink, alloc, private, refs, mounted)."""
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            while True:
                n = libc.getattrlistbulk(fd, ctypes.byref(ATTRS), BUF, BUFSZ, 0x1 | 0x20)
                if n < 0:
                    e = ctypes.get_errno()
                    raise OSError(e, os.strerror(e), path)
                if n == 0:
                    return
                mv = BUF.raw
                off = 0
                for _ in range(n):
                    length = U32(mv, off)[0]
                    p = off + 4
                    cmn, vol, dr, fl, fk = RET(mv, p); p += 20
                    err = 0
                    if cmn & 0x20000000:
                        err = U32(mv, p)[0]; p += 4
                    name = None
                    if cmn & 0x1:
                        noff, nlen = I32(mv, p)[0], U32(mv, p + 4)[0]
                        name = mv[p + noff:p + noff + nlen - 1].decode("utf-8", "surrogateescape")
                        p += 8
                    dev = typ = mtime = mounted = 0
                    if cmn & 0x2:
                        dev = I32(mv, p)[0]; p += 4
                    if cmn & 0x8:
                        typ = U32(mv, p)[0]; p += 4
                    if cmn & 0x400:
                        mtime = TS(mv, p)[0]; p += 16
                    if dr & 0x8:
                        mounted = U32(mv, p)[0] & 1; p += 4
                    nlink, alloc = 1, 0
                    if fl & 0x1:
                        nlink = U32(mv, p)[0]; p += 4
                    if fl & 0x4:
                        alloc = Q(mv, p)[0]; p += 8
                    priv, refs = alloc, 1
                    if fk & 0x8:
                        priv = Q(mv, p)[0]; p += 8
                    if fk & 0x1000:
                        refs = U32(mv, p)[0] or 1; p += 4
                    off += length
                    if err == 0 and name is not None:
                        yield name, typ, dev, mtime, nlink, alloc, priv, refs, mounted
        finally:
            os.close(fd)
else:
    def listdir(path):
        with os.scandir(path) as it:
            for e in it:
                try:
                    st = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                typ = VDIR if stat.S_ISDIR(st.st_mode) else VLNK if stat.S_ISLNK(st.st_mode) else VREG
                alloc = st.st_blocks * 512
                yield e.name, typ, st.st_dev, int(st.st_mtime), st.st_nlink, alloc, alloc, 1, 0

def ext_of(name):
    i = name.rfind(".")
    return "" if i <= 0 or len(name) - i > 12 else name[i + 1:].lower()

def new_node(name):
    return {"n": name, "s": 0, "u": 0, "a": 0, "f": 0, "m": 0, "k": []}

def task(path):
    st = {"left": BUDGET, "pending": [], "exts": {}, "top": []}
    return path, walk(path, os.path.basename(path), st), st

def walk(path, name, st):
    node = new_node(name)
    try:
        rows = list(listdir(path))
    except OSError:
        node["x"] = 1
        return node
    kids = []
    fs = fu = fa = ff = m = 0
    exts, top = st["exts"], st["top"]
    for nm, typ, dev, mtime, nlink, alloc, priv, refs, mounted in rows:
        st["left"] -= 1
        if typ == VDIR:
            if mounted or dev != DEV:
                continue
            cpath = path.rstrip("/") + "/" + nm
            if st["left"] <= 0:
                child = new_node(nm)
                child["p"] = cpath
                st["pending"].append(cpath)
                kids.append(child)
                continue
            child = walk(cpath, nm, st)
            if child["s"] >= KEEP or child["a"] >= KEEP or "h" in child or "p" in child or "x" in child:
                kids.append(child)
            else:
                fs += child["s"]; fu += child["u"]; fa += child["a"]; ff += child["f"]
                m = max(m, child["m"])
            continue
        links = nlink if (nlink > 1 and typ == VREG) else 1
        a = alloc // links
        u = 0 if links > 1 else priv  # another link keeps the data
        s = u + (a - u) // (refs if refs > 1 else 2) if u < a else a
        m = max(m, mtime)
        x = ext_of(nm) if typ == VREG else ("@link" if typ == VLNK else "@other")
        rec = exts.get(x)
        if rec is None:
            exts[x] = [s, 1]
        else:
            rec[0] += s; rec[1] += 1
        if a >= BIG_FILE:
            item = (a, s, u, path.rstrip("/") + "/" + nm, mtime)
            if len(top) < TOP_FILES:
                heapq.heappush(top, item)
            elif item > top[0]:
                heapq.heapreplace(top, item)
        if a >= KEEP:
            kids.append({"n": nm, "s": s, "u": u, "a": a, "f": 1, "m": mtime, "t": 1})
        else:
            fs += s; fu += u; fa += a; ff += 1
    kids.sort(key=lambda c: -c["a"])
    if len(kids) > MAX_KIDS:
        keep = kids[:MAX_KIDS]
        for c in kids[MAX_KIDS:]:
            if "p" in c or "h" in c:
                keep.append(c)
            else:
                fs += c["s"]; fu += c["u"]; fa += c["a"]; ff += c["f"]
                m = max(m, c["m"])
        kids = keep
    node["s"], node["u"], node["a"], node["f"] = fs, fu, fa, ff
    for c in kids:
        node["s"] += c["s"]; node["u"] += c["u"]; node["a"] += c["a"]; node["f"] += c["f"]
        m = max(m, c["m"])
        if "p" in c or "h" in c:
            node["h"] = 1
    node["m"] = m
    if ff:
        node["o"] = [fs, fu, fa, ff]
    node["k"] = kids
    return node

def finalize(node):
    if "t" in node:
        return
    s = u = a = f = 0
    m = node.get("m", 0)
    for c in node["k"]:
        finalize(c)
        s += c["s"]; u += c["u"]; a += c["a"]; f += c["f"]
        m = max(m, c["m"])
    if "o" in node:
        o = node["o"]; s += o[0]; u += o[1]; a += o[2]; f += o[3]
    node.update(s=s, u=u, a=a, f=f, m=m)
    node.pop("h", None); node.pop("p", None)
    node["k"].sort(key=lambda c: -c["s"])

def init(dev):
    global DEV
    sys.setrecursionlimit(20000)
    DEV = dev

def main(root, out):
    dev = os.lstat(root).st_dev
    init(dev)
    done = queue.Queue()
    placeholders = {}
    exts, top = {}, []
    tree = None
    with Pool(os.cpu_count(), initializer=init, initargs=(dev,)) as pool:
        def submit(p):
            pool.apply_async(task, (p,), callback=done.put, error_callback=done.put)
        submit(root)
        outstanding = 1
        while outstanding:
            res = done.get()
            outstanding -= 1
            if isinstance(res, BaseException):
                raise res
            path, node, st = res
            if path == root:
                tree = node
            else:
                ph = placeholders.pop(path)
                ph.clear(); ph.update(node)
            stack = [node]
            while stack:
                for c in stack.pop()["k"]:
                    if "p" in c:
                        placeholders[c["p"]] = c
                    elif "h" in c:
                        stack.append(c)
            for k, (b, cnt) in st["exts"].items():
                r = exts.setdefault(k, [0, 0]); r[0] += b; r[1] += cnt
            top.extend(st["top"])
            for p in st["pending"]:
                submit(p); outstanding += 1
    finalize(tree)
    tree["n"] = ""
    with open(out, "w") as fh:
        json.dump({"root": root, "scannedAt": int(time.time()), "tree": tree, "exts": exts,
                   "topFiles": sorted(set(top), reverse=True)[:TOP_FILES]}, fh, separators=(",", ":"))

if __name__ == "__main__":
    sys.setrecursionlimit(20000)
    main(sys.argv[1], sys.argv[2])
`;
