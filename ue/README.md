# UE 연동 기술 검증 (스파이크)

`.uasset` DataTable 병합을 만들기 전에, 가장 위험한 세 가지가 실제 엔진에서 되는지 확인하는 스크립트입니다.
사업계획서 1분기 "재현" 단계와 "[에디터에서 임시 버전 에셋을 불러오는 방식 기술 검증 필요]" 항목에 해당합니다.

| # | 검사 | 실패하면 |
|---|---|---|
| 1 | **JSON 왕복**: DataTable → JSON → 같은 DataTable로 다시 채웠을 때 값이 하나도 안 바뀌는가 | JSON 대신 C++로 속성을 직접 읽고 써야 함 |
| 2 | **과거 버전 불러오기**: Git에서 꺼낸 예전 `.uasset`을 임시 폴더에 넣고 에디터로 열 수 있는가 | 엔진 Diff처럼 C++로 diff 전용 로드(`LOAD_ForDiff`)를 해야 함 |
| 3 | **Git LFS**: `.uasset`이 LFS로 관리되는지, 포인터를 실제 파일로 풀 수 있는가 | `git lfs` 설치 / 설정 확인 |

**원본 에셋은 수정하지 않습니다.**
- 1번은 복제본으로, 2번은 `/Game/__AssetGuard_Spike` 임시 폴더에서 실험합니다.
- 끝나면 임시 폴더를 지웁니다.
- 마지막에 원본을 다시 읽어서 안 바뀌었는지도 확인합니다.

## 준비

1. **실험용 프로젝트를 쓰세요.** 팀 프로젝트를 복사하거나 빈 프로젝트를 만들어 Git 저장소로 두면 됩니다.
2. 플러그인 켜기: **Python Editor Script Plugin**, **Editor Scripting Utilities** (편집 → 플러그인)
3. DataTable을 몇 개 준비합니다. 다음 경우를 섞어 두면 좋습니다.
   - C++ 구조체 기반 테이블 1개, **블루프린트 구조체** 기반 테이블 1개
   - 값 종류: 숫자, bool, enum, FName, 에셋 참조(메시·텍스처), 배열, 중첩 구조체
4. 2번 검사를 하려면 그 DataTable이 **최소 한 번 커밋**돼 있어야 합니다.

## 실행

에디터에서 출력 로그(Output Log) 아래 입력칸을 `Cmd`에서 `Python`으로 바꾸고 입력합니다.

```
py "D:/assetguard/ue/spike_datatable.py"
```

인수로 검사할 테이블과 Git 버전을 줄 수도 있습니다.

```
py "D:/assetguard/ue/spike_datatable.py" /Game/Data/DT_Monsters /Game/Data/DT_Vehicles --rev=HEAD~1
```

- 경로를 안 주면 `/Game` 아래 DataTable을 최대 5개 자동으로 고릅니다.
- `--rev`의 기본값은 `HEAD`입니다. 작업 파일이 HEAD와 같으면 불러온 과거 버전이 원본과 **완전히 같은지**까지 비교합니다.
- `--keep`을 주면 임시 폴더를 지우지 않아서 콘텐츠 브라우저에서 직접 열어볼 수 있습니다.

화면 없이 실행할 수도 있습니다. 커맨드릿 방식이라, 나중에 `assetguard.ps1`이 이 방식으로 연동합니다.

```
UnrealEditor-Cmd.exe "D:/MyGame/MyGame.uproject" -run=pythonscript -script="D:/assetguard/ue/spike_datatable.py /Game/Data/DT_Monsters"
```

## 결과 보기

출력 로그에 테이블마다 이렇게 나옵니다.

```
[AssetGuard] /Game/Data/DT_Monsters
[AssetGuard]   행 구조체: S_Monster (블루프린트 구조체(UserDefinedStruct)), 행 12개, 값 종류: bool, 구조체/맵, 배열, 숫자, 에셋 경로, 문자열/이름/enum
[AssetGuard]   1) JSON 왕복 : 통과 - 같음
[AssetGuard]   2) 과거 버전 : 통과 - 작업 파일과 같은 버전이고 내용도 같음 (HEAD, 불러오기 0.05s)
[AssetGuard]   3) Git LFS   : LFS 관리, 포인터 풀기 성공
[AssetGuard]   원본 변경 없음: 통과
```

- 전체 결과는 `<프로젝트>/Saved/AssetGuard/spike_report.json`에 저장됩니다. 이 파일을 공유하면 다음 단계를 정할 수 있습니다.
- 실패하면 `detail`에 **처음으로 달라진 위치**가 나옵니다 (예: `$[Goblin].Tags: 개수 다름`).
- **2번 검사 중에 출력 로그에 뜨는 경고도 같이 봐 주세요.** 특히 `LogLinker`, `LogUObjectGlobals`, "package name mismatch" 같은 경고입니다. 경고 없이 열리는지가 이 검사의 핵심입니다.

## 실제 엔진 실행 결과 (UE 5.8.4, 2026-11-24)

`make-spike-project.ps1`로 만든 검증용 프로젝트에서 실행했습니다. 커밋은 2개이고, `.uasset`은 Git LFS로 관리합니다.

| 테이블 | 1) JSON 왕복 | 2) 과거 버전 (HEAD) | 2) 과거 버전 (HEAD~1) | 3) LFS |
|---|---|---|---|---|
| `DT_Tags` (엔진 C++ 구조체, FName + 한글 문자열) | 통과 | 통과 (내용 완전히 같음) | 통과 (v1의 행 2개) | 포인터 풀기 성공 |
| `DT_BPStruct` (블루프린트 구조체) | 통과 | 통과 (내용 완전히 같음) | 통과 (v1의 행 2개) | 포인터 풀기 성공 |

- 원본 에셋은 바뀌지 않았고, 임시 폴더도 디스크에서 삭제됐습니다.
- 과거 버전을 불러올 때 `LogLinker` 경고나 "package name mismatch" 경고는 나오지 않았습니다.

실행하면서 발견해서 고친 것이 두 가지 있습니다.

1. **에셋 레지스트리가 새로 넣은 파일을 가끔 못 봄.**
   - 처음에는 폴더 단위로 다시 스캔했는데, 파일 2개 중 1개를 무작위로 놓쳤습니다(실행할 때마다 다른 쪽).
   - 지금은 그 파일 하나를 직접 스캔합니다. 그래도 못 찾으면 레지스트리를 거치지 않고 오브젝트 경로로 직접 불러옵니다.
2. **`delete_directory`가 직접 복사한 파일을 디스크에 남김.** UE가 경고만 남기고 오류를 내지 않아서 놓쳤습니다. 지금은 가비지 컬렉션을 한 뒤 남은 파일을 직접 지우고, 결과를 보고서에 남깁니다.

### 검증용 프로젝트 다시 만들기

```powershell
powershell -ExecutionPolicy Bypass -File ue\make-spike-project.ps1 -Engine E:\UE_5.8 -Path D:\AssetGuardSpike
```

- 새 폴더에 프로젝트를 만듭니다(팀 프로젝트는 건드리지 않음).
- 테스트 DataTable을 v1, v2 두 번 커밋한 뒤 검증 스크립트를 `HEAD`, `HEAD~1`로 한 번씩 실행합니다.
- 프로젝트는 그대로 두고 검증만 다시 돌리려면 `-SkipCreate`를 붙이세요.

## 이 스크립트가 확인하지 못하는 것

- JSON에 아예 나오지 않는 속성(Transient 등)은 1번 비교 대상이 아닙니다.
- 2번은 "열린다"까지만 확인합니다. 임시 폴더의 복사본이 원본을 참조하는 다른 에셋에 영향을 주는지는 `--keep`으로 남겨서 직접 확인해야 합니다.
- 실제 엔진은 **UE 5.8.4에서만** 실행해 봤습니다. 다른 버전에서 API 이름이 다르면 오류 메시지를 그대로 공유해 주세요.
- 검증용 테이블은 단순합니다(FName, 문자열, bool). **enum, 에셋 참조, 배열, 중첩 구조체**가 들어간 실제 팀 데이터로도 한 번 돌려봐야 합니다.
