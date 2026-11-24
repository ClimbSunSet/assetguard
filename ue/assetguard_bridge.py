"""
AssetGuard <-> Unreal 다리. assetguard.ps1 이 커맨드릿으로 실행합니다 (사람이 직접 실행할 일은 없음).

  export <manifest.json> <out.json>
      Git 에서 꺼낸 세 버전(.uasset 파일)을 임시 폴더로 불러와 DataTable JSON 으로 내보냄.
      manifest: {"run": "ab12cd34", "items": [{"id": "0", "pkg": "/Game/Data/DT_X",
                 "stages": {"base": "C:/.../base.uasset" | null, "ours": "...", "theirs": "..."}}]}
      out:      {"items": [{"id": "0", "ok": true, "row_struct": "...", "base": "<json>"|null, "ours": "...", "theirs": "..."}
                           | {"id": "0", "ok": false, "error": "..."}]}

  import <manifest.json> <out.json>
      병합 결과 JSON 을 작업 폴더의 실제 에셋에 채우고 저장한 뒤, 다시 읽어서 그대로 들어갔는지 확인.
      manifest: {"items": [{"id": "0", "pkg": "/Game/Data/DT_X", "json_file": "C:/.../merged.json"}]}
      out:      {"items": [{"id": "0", "ok": true, "rows": 12} | {"id": "0", "ok": false, "error": "..."}]}

검증 결과(ue/README.md)에서 확인한 방법을 그대로 씁니다: 같은 파일 이름으로 다른 폴더에 복사,
파일 단위 레지스트리 스캔, 못 찾으면 오브젝트 경로로 직접 로드, 끝나면 GC 후 임시 폴더를 디스크에서도 삭제.
"""

import json
import os
import shlex
import shutil
import sys
import traceback

import unreal

EAL = unreal.EditorAssetLibrary
DTL = unreal.DataTableFunctionLibrary
TEMP_ROOT = "/Game/__AssetGuard"
UASSET_MAGIC = b"\xc1\x83\x2a\x9e"


def log(msg):
    unreal.log("[AssetGuard] " + msg)


def content_file(package_path):
    rel = package_path[len("/Game/"):]
    content_dir = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_content_dir())
    return os.path.normpath(os.path.join(content_dir, rel + ".uasset"))


def load_copy(src_file, temp_pkg):
    """Copy a .uasset into the project under temp_pkg and load it. Returns the object or raises."""
    with open(src_file, "rb") as f:
        data = f.read()
    if not data.startswith(UASSET_MAGIC):
        raise RuntimeError(".uasset 형식이 아니에요 (LFS 포인터를 못 풀었을 수 있어요)")
    dst = content_file(temp_pkg)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "wb") as f:
        f.write(data)
    registry = unreal.AssetRegistryHelpers.get_asset_registry()
    try:
        registry.scan_files_synchronous([dst], True)
    except Exception:
        registry.scan_paths_synchronous([temp_pkg.rsplit("/", 1)[0]], True)
    obj = EAL.load_asset(temp_pkg) if EAL.does_asset_exist(temp_pkg) else None
    if obj is None:
        obj = unreal.load_asset("%s.%s" % (temp_pkg, temp_pkg.rsplit("/", 1)[1]))
    if obj is None:
        raise RuntimeError("언리얼에서 불러오지 못했어요")
    return obj


def struct_name(table):
    try:
        st = table.get_editor_property("row_struct")
        return st.get_name() if st else None
    except Exception:
        return None


def require_datatable(obj):
    if not isinstance(obj, unreal.DataTable):
        raise RuntimeError("DataTable 이 아니에요 (%s). 지금은 DataTable 만 병합할 수 있어요" % obj.get_class().get_name())


def cleanup(run_root):
    try:
        EAL.delete_directory(run_root)
    except Exception:
        pass
    try:
        unreal.SystemLibrary.collect_garbage()
    except Exception:
        pass
    folder = os.path.dirname(content_file(run_root + "/x"))
    if os.path.basename(os.path.dirname(folder)) == TEMP_ROOT.rsplit("/", 1)[1]:  # only our own folder
        shutil.rmtree(folder, ignore_errors=True)
        parent = os.path.dirname(folder)
        try:
            if not os.listdir(parent):
                os.rmdir(parent)
        except OSError:
            pass


def do_export(manifest):
    run_root = "%s/%s" % (TEMP_ROOT, manifest.get("run", "run"))
    results = []
    try:
        for item in manifest["items"]:
            name = item["pkg"].rsplit("/", 1)[1]
            try:
                out = {"id": item["id"], "ok": True}
                for stage in ("base", "ours", "theirs"):
                    src = item["stages"].get(stage)
                    if not src:
                        out[stage] = None
                        continue
                    obj = load_copy(src, "%s/%s/%s/%s" % (run_root, item["id"], stage, name))
                    require_datatable(obj)
                    out[stage] = DTL.export_data_table_to_json_string(obj)
                    out["row_struct"] = struct_name(obj)
                results.append(out)
            except Exception as e:
                results.append({"id": item["id"], "ok": False, "error": str(e), "trace": traceback.format_exc()})
    finally:
        cleanup(run_root)
    return results


def same_value(a, b):
    """JSON equality where 2 == 2.0 (Unreal may print a float without its fraction)."""
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same_value(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same_value(x, y) for x, y in zip(a, b))
    return a == b


def do_import(manifest):
    results = []
    for item in manifest["items"]:
        try:
            with open(item["json_file"], encoding="utf-8") as f:
                merged_text = f.read()
            merged = json.loads(merged_text)
            table = EAL.load_asset(item["pkg"])
            if table is None:
                raise RuntimeError("작업 폴더의 에셋을 불러오지 못했어요: " + item["pkg"])
            require_datatable(table)
            if not DTL.fill_data_table_from_json_string(table, merged_text):
                raise RuntimeError("언리얼이 병합 결과 JSON 을 받아들이지 않았어요 (출력 로그 확인)")
            if not EAL.save_asset(item["pkg"], only_if_is_dirty=False):
                raise RuntimeError("저장에 실패했어요 (파일이 읽기 전용이거나 에디터가 열려 있을 수 있어요)")
            after = json.loads(DTL.export_data_table_to_json_string(table))
            if not same_value(after, merged):
                raise RuntimeError("저장 후 다시 읽은 내용이 병합 결과와 달라요. 저장된 파일을 확인하세요")
            results.append({"id": item["id"], "ok": True, "rows": len(after)})
        except Exception as e:
            results.append({"id": item["id"], "ok": False, "error": str(e), "trace": traceback.format_exc()})
    return results


def main():
    # assetguard.ps1 passes the arguments through environment variables, because a path with
    # a space cannot be quoted inside -script="..." on the commandlet command line.
    env = [os.environ.get(k) for k in ("ASSETGUARD_MODE", "ASSETGUARD_MANIFEST", "ASSETGUARD_OUT")]
    if all(env):
        args = env
    else:
        args = sys.argv[1:]
        if len(args) == 1 and " " in args[0]:
            args = shlex.split(args[0], posix=False)
        args = [a.strip('"') for a in args]
    if len(args) != 3 or args[0] not in ("export", "import"):
        raise SystemExit("사용법: assetguard_bridge.py export|import <manifest.json> <out.json>")
    mode, manifest_path, out_path = args
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)
    results = do_export(manifest) if mode == "export" else do_import(manifest)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"items": results}, f, ensure_ascii=False)
    log("%s 완료: %d개 중 %d개 성공" % (mode, len(results), sum(1 for r in results if r["ok"])))


main()
