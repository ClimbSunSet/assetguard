"""
검증용 DataTable 만들기 (make-spike-project.ps1 이 커맨드릿으로 실행).

  v1: 처음 버전   v2: 값 수정 + 행 추가 (두 번째 커밋용)

만드는 것
  /Game/Data/DT_Tags      : 엔진 C++ 구조체(GameplayTagTableRow) 기반 - FName, 문자열(한글 포함)
  /Game/Data/S_Spike      : 블루프린트 구조체(UserDefinedStruct, 기본 멤버 1개)
  /Game/Data/DT_BPStruct  : S_Spike 기반 - 블루프린트 구조체의 GUID 붙은 속성 이름 처리 확인용
"""
import json
import shlex
import sys

import unreal

EAL = unreal.EditorAssetLibrary
DTL = unreal.DataTableFunctionLibrary
TOOLS = unreal.AssetToolsHelpers.get_asset_tools()

args = sys.argv[1:]
if len(args) == 1 and " " in args[0]:
    args = shlex.split(args[0])
version = args[0] if args else "v1"


def log(msg):
    unreal.log("[setup] " + msg)


def get_or_create_table(name, struct):
    path = "/Game/Data/" + name
    if EAL.does_asset_exist(path):
        return EAL.load_asset(path)
    factory = unreal.DataTableFactory()
    factory.set_editor_property("struct", struct)
    return TOOLS.create_asset(name, "/Game/Data", unreal.DataTable, factory)


def fill(table, rows):
    ok = DTL.fill_data_table_from_json_string(table, json.dumps(rows, ensure_ascii=False))
    EAL.save_asset(table.get_path_name().split(".")[0], only_if_is_dirty=False)
    names = DTL.get_data_table_row_names(table)
    log("%s fill=%s rows=%d json=%s" % (table.get_name(), ok, len(names), DTL.export_data_table_to_json_string(table)))


# --- engine C++ struct
tags = get_or_create_table("DT_Tags", unreal.GameplayTagTableRow.static_struct())
tag_rows = [
    {"Name": "Ability.Fire", "Tag": "Ability.Fire", "DevComment": "불 공격"},
    {"Name": "Ability.Ice", "Tag": "Ability.Ice", "DevComment": "얼음 공격"},
]
if version == "v2":
    tag_rows[0]["DevComment"] = "불 공격 (기획 수정)"
    tag_rows.append({"Name": "Ability.Wind", "Tag": "Ability.Wind", "DevComment": "바람 공격"})
fill(tags, tag_rows)

# --- blueprint struct
struct_path = "/Game/Data/S_Spike"
if EAL.does_asset_exist(struct_path):
    bp_struct = EAL.load_asset(struct_path)
else:
    bp_struct = TOOLS.create_asset("S_Spike", "/Game/Data", unreal.UserDefinedStruct, unreal.StructureFactory())
    EAL.save_asset(struct_path, only_if_is_dirty=False)
bp = get_or_create_table("DT_BPStruct", bp_struct)
# Learn the member's exported (friendly) name from an export of a one-row table.
probe = DTL.export_data_table_to_json_string(bp)
log("DT_BPStruct empty export=" + probe)
member = "MemberVar_0"
bp_rows = [{"Name": "Row_A", member: True}, {"Name": "Row_B", member: False}]
if version == "v2":
    bp_rows[1][member] = True
fill(bp, bp_rows)
log("done " + version)
