"""
AssetGuard UE 연동 기술 검증 스크립트 (스파이크)

언리얼 에디터 안에서 실행해서, .uasset DataTable 병합에 필요한 세 가지가 되는지 확인합니다.
  1) JSON 왕복   : DataTable -> JSON -> 같은 DataTable 로 다시 채웠을 때 값이 하나도 안 바뀌는가
  2) 과거 버전   : Git 에서 꺼낸 예전 .uasset 을 임시 폴더에 넣고 에디터로 불러올 수 있는가
  3) Git LFS     : .uasset 이 LFS 로 관리되는지, 포인터를 실제 파일로 풀 수 있는가

원본 에셋은 절대 수정하지 않습니다. 모든 실험은 복제본과 /Game/__AssetGuard_Spike 임시 폴더에서 하고,
끝나면 임시 폴더를 지웁니다(--keep 을 주면 남김). 결과는 출력 로그와
<프로젝트>/Saved/AssetGuard/spike_report.json 에 남깁니다.

실행 방법 (둘 중 하나)
  - 에디터: 출력 로그(Output Log) 아래 입력칸을 'Python' 으로 바꾸고
        py "D:/assetguard/ue/spike_datatable.py"
        py "D:/assetguard/ue/spike_datatable.py" /Game/Data/DT_Monsters --rev=HEAD~1
  - 화면 없이(커맨드릿):
        UnrealEditor-Cmd.exe "D:/MyGame/MyGame.uproject" -run=pythonscript -script="D:/assetguard/ue/spike_datatable.py /Game/Data/DT_Monsters"

인수
  /Game/... 경로 여러 개 : 검사할 DataTable (없으면 /Game 아래 DataTable 을 최대 5개 자동 선택)
  --rev=<git 리비전>     : 2번 검사에서 꺼낼 버전 (기본 HEAD)
  --keep                 : 임시 폴더를 지우지 않고 남김 (직접 열어보고 싶을 때)

필요한 플러그인: Python Editor Script Plugin, Editor Scripting Utilities
"""

import json
import os
import shlex
import subprocess
import sys
import time
import traceback

import unreal

TEMP_ROOT = "/Game/__AssetGuard_Spike"
AUTO_LIMIT = 5

EAL = unreal.EditorAssetLibrary
DTL = unreal.DataTableFunctionLibrary


# ---------------------------------------------------------------- helpers

def log(msg):
    unreal.log("[AssetGuard] " + msg)


def warn(msg):
    unreal.log_warning("[AssetGuard] " + msg)


def parse_args():
    # `py file a b` fills sys.argv; the commandlet passes everything as one string.
    raw = sys.argv[1:]
    if len(raw) == 1 and " " in raw[0]:
        raw = shlex.split(raw[0])
    targets, rev, keep = [], "HEAD", False
    for a in raw:
        if a.startswith("--rev="):
            rev = a.split("=", 1)[1]
        elif a == "--keep":
            keep = True
        elif a.startswith("/Game/"):
            targets.append(a.split(".")[0])  # accept "/Game/X/DT.DT" object paths too
    return targets, rev, keep


def asset_class_name(asset_data):
    path = getattr(asset_data, "asset_class_path", None)  # UE 5.1+
    if path is not None:
        return str(path.asset_name)
    return str(asset_data.asset_class)  # older engines


def find_datatables(limit):
    found = []
    for path in EAL.list_assets("/Game", recursive=True, include_folder=False):
        pkg = path.split(".")[0]
        if pkg.startswith(TEMP_ROOT):
            continue
        data = EAL.find_asset_data(pkg)
        if data and asset_class_name(data) == "DataTable":
            found.append(pkg)
            if len(found) >= limit:
                break
    return found


def content_file(package_path):
    """/Game/Data/DT_X -> <abs>/Content/Data/DT_X.uasset"""
    rel = package_path[len("/Game/"):]
    content_dir = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_content_dir())
    return os.path.normpath(os.path.join(content_dir, rel + ".uasset"))


def run(cmd, cwd, stdin=None):
    flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
    try:
        p = subprocess.run(cmd, cwd=cwd, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)
    except OSError as e:  # git not installed / not on PATH
        return 127, b"", str(e)
    return p.returncode, p.stdout, p.stderr.decode("utf-8", "replace").strip()


def export_json(table):
    s = DTL.export_data_table_to_json_string(table)
    return s, json.loads(s) if s else []


def first_difference(a, b, path="$"):
    """Return a human-readable path to the first difference, or None."""
    if type(a) != type(b):
        return "%s: 형식이 다름 (%s vs %s)" % (path, type(a).__name__, type(b).__name__)
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                return "%s.%s: 한쪽에만 있음" % (path, k)
            d = first_difference(a[k], b[k], path + "." + k)
            if d:
                return d
        return None
    if isinstance(a, list):
        if len(a) != len(b):
            return "%s: 개수 다름 (%d vs %d)" % (path, len(a), len(b))
        for i, (x, y) in enumerate(zip(a, b)):
            name = x.get("Name") if isinstance(x, dict) else None
            d = first_difference(x, y, "%s[%s]" % (path, name if name is not None else i))
            if d:
                return d
        return None
    if a != b:
        return "%s: %r -> %r" % (path, a, b)
    return None


def row_struct_info(table):
    try:
        st = table.get_editor_property("row_struct")
    except Exception:
        return {"name": None, "kind": "알 수 없음"}
    if st is None:
        return {"name": None, "kind": "없음"}
    kind = "블루프린트 구조체(UserDefinedStruct)" if isinstance(st, unreal.UserDefinedStruct) else "C++ 구조체"
    return {"name": st.get_name(), "kind": kind}


def value_kinds(rows):
    """Which JSON value kinds appear, to show what the round trip actually covered."""
    kinds = set()

    def walk(v):
        if isinstance(v, dict):
            kinds.add("구조체/맵")
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            kinds.add("배열")
            for x in v:
                walk(x)
        elif isinstance(v, bool):
            kinds.add("bool")
        elif isinstance(v, (int, float)):
            kinds.add("숫자")
        elif isinstance(v, str):
            kinds.add("에셋 경로" if v.startswith("/") and "." in v else "문자열/이름/enum")
        elif v is None:
            kinds.add("null")

    for r in rows:
        for k, v in r.items():
            if k != "Name":
                walk(v)
    return sorted(kinds)


# ---------------------------------------------------------------- checks

def check_roundtrip(pkg, table, original_rows):
    """Duplicate the table, refill the copy from its own JSON, and compare."""
    name = pkg.rsplit("/", 1)[1]
    dup_path = "%s/roundtrip/%s" % (TEMP_ROOT, name)
    if EAL.does_asset_exist(dup_path):
        EAL.delete_asset(dup_path)
    dup = EAL.duplicate_asset(pkg, dup_path)
    if dup is None:
        return {"ok": False, "detail": "복제 실패"}
    s, _ = export_json(table)
    filled = DTL.fill_data_table_from_json_string(dup, s)
    if not filled:
        return {"ok": False, "detail": "fill_data_table_from_json_string 이 False 를 반환"}
    EAL.save_asset(dup_path, only_if_is_dirty=False)
    _, after = export_json(dup)
    diff = first_difference(original_rows, after)
    return {"ok": diff is None, "detail": diff or "같음"}


def check_revision(pkg, original_rows, rev, git_root):
    """Pull <rev>:<file> out of git, drop it under the temp folder, load it."""
    src = content_file(pkg)
    rel = os.path.relpath(src, git_root).replace("\\", "/")
    out = {"rev": rev, "file": rel, "lfs_attr": None, "lfs_pointer": False}

    code, attr, _ = run(["git", "check-attr", "filter", "--", rel], git_root)
    if code == 0:
        out["lfs_attr"] = attr.decode("utf-8", "replace").strip().endswith(": lfs")

    code, blob, err = run(["git", "show", "%s:%s" % (rev, rel)], git_root)
    if code != 0:
        out.update(ok=False, detail="git show 실패: " + err)
        return out
    if blob.startswith(b"version https://git-lfs.github.com/spec/"):
        out["lfs_pointer"] = True
        code, real, err = run(["git", "lfs", "smudge", "--", rel], git_root, stdin=blob)
        if code != 0:
            out.update(ok=False, detail="LFS 포인터를 풀지 못함 (git lfs 설치 확인): " + err)
            return out
        blob = real
    if not blob.startswith(b"\xc1\x83\x2a\x9e"):  # .uasset magic (PACKAGE_FILE_TAG, little-endian)
        out.update(ok=False, detail="꺼낸 파일이 .uasset 형식이 아님 (처음 4바이트: %s)" % blob[:4].hex())
        return out

    # Same file name, different folder: the object inside keeps its original name,
    # so "/Game/__AssetGuard_Spike/rev/DT_X" resolves to the object "DT_X".
    name = pkg.rsplit("/", 1)[1]
    temp_pkg = "%s/rev/%s" % (TEMP_ROOT, name)
    temp_file = content_file(temp_pkg)
    os.makedirs(os.path.dirname(temp_file), exist_ok=True)
    with open(temp_file, "wb") as f:
        f.write(blob)
    unreal.AssetRegistryHelpers.get_asset_registry().scan_paths_synchronous([TEMP_ROOT + "/rev"], True)

    t0 = time.time()
    loaded = EAL.load_asset(temp_pkg)
    out["load_seconds"] = round(time.time() - t0, 2)
    if loaded is None:
        out.update(ok=False, detail="load_asset 이 None (출력 로그의 LogLinker/LogUObjectGlobals 경고 확인)")
        return out
    if not isinstance(loaded, unreal.DataTable):
        out.update(ok=False, detail="불러온 객체가 DataTable 이 아님: " + loaded.get_class().get_name())
        return out
    _, rev_rows = export_json(loaded)
    out["rows"] = len(rev_rows)

    # If the working file equals <rev>, the loaded copy must match the original exactly.
    code, _, _ = run(["git", "diff", "--quiet", rev, "--", rel], git_root)
    if code == 0:
        diff = first_difference(original_rows, rev_rows)
        out.update(ok=diff is None, detail=diff or "작업 파일과 같은 버전이고 내용도 같음")
    else:
        out.update(ok=True, detail="작업 파일과 다른 버전을 불러옴 (행 %d개). 내용 비교는 생략" % len(rev_rows))
    return out


# ---------------------------------------------------------------- main

def main():
    targets, rev, keep = parse_args()
    project_dir = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir())
    code, top, err = run(["git", "rev-parse", "--show-toplevel"], project_dir)
    git_root = os.path.normpath(top.decode().strip()) if code == 0 else None
    lfs_ok = run(["git", "lfs", "version"], project_dir)[0] == 0 if git_root else False

    if not targets:
        targets = find_datatables(AUTO_LIMIT)
        log("검사할 DataTable 을 자동으로 골랐어요: %s" % (", ".join(targets) or "(없음)"))
    if not targets:
        warn("/Game 아래에 DataTable 이 없어요. 경로를 인수로 주세요.")
        return

    report = {
        "engine": unreal.SystemLibrary.get_engine_version(),
        "project": project_dir,
        "git_root": git_root,
        "git_lfs_installed": lfs_ok,
        "rev": rev,
        "tables": [],
    }
    if not git_root:
        warn("프로젝트가 Git 저장소가 아니라서 2번(과거 버전) 검사는 건너뛰어요: " + err)

    for pkg in targets:
        entry = {"asset": pkg}
        report["tables"].append(entry)
        try:
            table = EAL.load_asset(pkg)
            if not isinstance(table, unreal.DataTable):
                entry["error"] = "DataTable 이 아님"
                continue
            _, rows = export_json(table)
            entry["row_struct"] = row_struct_info(table)
            entry["rows"] = len(rows)
            entry["value_kinds"] = value_kinds(rows)
            entry["roundtrip"] = check_roundtrip(pkg, table, rows)
            if git_root:
                entry["revision"] = check_revision(pkg, rows, rev, git_root)
            # The original must be untouched after all of the above.
            _, again = export_json(table)
            entry["original_untouched"] = first_difference(rows, again) is None
        except Exception as e:  # keep going with the next table
            entry["error"] = "%s: %s" % (type(e).__name__, e)
            entry["traceback"] = traceback.format_exc()

    if not keep:
        try:
            EAL.delete_directory(TEMP_ROOT)
        except Exception as e:
            warn("임시 폴더 삭제 실패, 직접 지워주세요 (%s): %s" % (TEMP_ROOT, e))

    saved = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_saved_dir())
    out_path = os.path.join(saved, "AssetGuard", "spike_report.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print_summary(report, out_path)


def mark(ok):
    return "통과" if ok else "실패"


def print_summary(report, out_path):
    log("=" * 60)
    log("엔진 %s | Git: %s | git-lfs 설치: %s" % (report["engine"], report["git_root"] or "없음", report["git_lfs_installed"]))
    for t in report["tables"]:
        log("-" * 60)
        log(t["asset"])
        if "error" in t:
            log("  오류: " + t["error"])
            continue
        rs = t.get("row_struct", {})
        log("  행 구조체: %s (%s), 행 %d개, 값 종류: %s" % (rs.get("name"), rs.get("kind"), t["rows"], ", ".join(t["value_kinds"]) or "-"))
        rt = t["roundtrip"]
        log("  1) JSON 왕복 : %s - %s" % (mark(rt["ok"]), rt["detail"]))
        rv = t.get("revision")
        if rv:
            lfs = "LFS 관리" if rv.get("lfs_attr") else "LFS 아님"
            if rv.get("lfs_pointer"):
                lfs += ", 포인터 풀기 성공"
            log("  2) 과거 버전 : %s - %s (%s, 불러오기 %ss)" % (mark(rv.get("ok")), rv.get("detail"), rv["rev"], rv.get("load_seconds", "-")))
            log("  3) Git LFS   : %s" % lfs)
        log("  원본 변경 없음: %s" % mark(t.get("original_untouched")))
    log("=" * 60)
    log("전체 결과: " + out_path)


main()
