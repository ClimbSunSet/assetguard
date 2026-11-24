# AssetGuard MVP

Git 머지 충돌이 난 **DataTable을 칸 단위로 합치고, 칸마다 출처(원본·나·상대)를 보여주는** 로컬 도구입니다.
사업계획서 1분기 일정에 있는 "3-way 비교·자동 병합 프로토타입"과 "출처 표시 화면·진짜 충돌 선택 화면"을 구현했습니다.

- **별도 서버 없음**: Windows 기본 PowerShell과 Git만 씁니다. 설치할 것이 없습니다.
- **에셋이 밖으로 나가지 않음**: 병합 화면은 `http://localhost`에서만 열리고, 모든 처리는 이 PC에서 끝납니다.
- **규칙 기반**: AI를 쓰지 않습니다. 같은 입력이면 항상 같은 결과가 나옵니다.

## 5분 데모

```powershell
# 1) 실제 머지 충돌이 난 데모 저장소 만들기 (%TEMP%\assetguard-demo)
powershell -ExecutionPolicy Bypass -File demo\make-demo-repo.ps1

# 2) 병합 화면 열기
powershell -ExecutionPolicy Bypass -File assetguard.ps1 -Repo $env:TEMP\assetguard-demo
```

데모 시나리오는 "기획자가 몬스터를 추가하는 사이에 개발자가 밸런스를 조정"한 상황입니다.

| 파일 | 결과 |
|---|---|
| `DT_Monsters.json` | 12칸 자동 병합, 직접 고를 곳 1곳 (오크 HP: 내 값 280 vs 상대 값 300) |
| `DT_Vehicles.csv` | 전부 자동 병합 (양쪽이 각자 추가한 행 + 서로 다른 칸 수정) |

Git만 썼다면 두 파일 모두 "한쪽 버전 전체 고르기"를 해야 하는 상황입니다.

## 실제 프로젝트에서 쓰기

```powershell
# 한 번만: `git assetguard` 명령 등록 (Git 전역 설정에 별칭 1줄 추가)
powershell -ExecutionPolicy Bypass -File install.ps1
```

이후 머지 충돌이 나면 저장소 안에서 아래처럼 실행합니다.

```
git merge feature/xxx      # 충돌 발생
git assetguard             # 병합 화면이 브라우저로 열림 → 고르고 '저장하고 git add'
git commit                 # 머지 마무리
```

옵션: `-Repo <경로>`, `-Port <번호>` (기본 47813), `-NoBrowser`

## 병합 규칙

행은 `Name`으로 맞추고, 칸은 열 이름으로 맞춥니다.

| 원본 | 내 버전 | 상대 버전 | 처리 |
|---|---|---|---|
| 10 | 12 | 10 | 내 변경 채택 (자동) |
| 10 | 10 | 15 | 상대 변경 채택 (자동) |
| 10 | 20 | 20 | 양쪽이 같게 바꿈 → 채택 (자동) |
| 없음 | 없음 | 추가 | 상대가 추가한 행 채택 (자동) |
| 있음 | 삭제 | 그대로 | 삭제 (자동) |
| 있음 | 삭제 | 수정 | **행 충돌**: 삭제할지 수정본을 남길지 사람이 선택 |
| 10 | 12 | 15 | **진짜 충돌**: 원본·내 값·상대 값을 나란히 보고 선택 (직접 입력도 가능) |

- 구조체·배열 값은 내용으로 비교합니다 (키 순서 무관).
- 한쪽이 새 열을 추가하면 열과 값을 그대로 가져옵니다.
- 미해결 충돌이 하나라도 있으면 저장 버튼이 잠깁니다 (조용히 틀리게 합치지 않음).
- 파일의 줄바꿈(CRLF/LF), UTF-8 BOM, CSV 따옴표 스타일은 원래 파일을 따릅니다.

## 파일럿 측정 기록

저장할 때마다 `.git/assetguard-log.jsonl`에 한 줄씩 남깁니다. `.git` 폴더 안이라 커밋되지 않습니다.
사업계획서 1분기 지표(충돌 1건 처리 시간, 자동 병합 비율)를 이 기록으로 잴 수 있습니다.

```json
{"time":"2026-11-24T18:36:22","file":"Content/Data/DT_Monsters.json","ours":"main","theirs":"feature/new-monsters",
 "metrics":{"seconds":42,"autoCells":12,"addedRows":2,"deletedRows":1,"conflicts":1,"picked":{"ours":0,"theirs":1,"base":0,"custom":0}}}
```

## 지원 범위와 다음 단계

| 상태 | 내용 |
|---|---|
| 지원 | DataTable **JSON** (언리얼 "JSON으로 익스포트" 형식: `[{"Name": ..., ...}]`) |
| 지원 | DataTable **CSV** (첫 열이 행 이름, 헤더 첫 칸 `---`) |
| 미지원 | **`.uasset` 직접 병합.** 충돌 목록에는 "건너뜀"으로 표시됩니다 |

`.uasset`을 다루려면 언리얼 에디터와 연결해야 합니다. 계획은 이렇습니다.
Git의 세 버전 `.uasset`을 임시 에셋으로 불러와 에디터 Python의 `DataTableFunctionLibrary`로 JSON을 뽑고,
이 도구의 병합 엔진(`web/merge.js`)으로 합친 뒤, 결과 JSON을 다시 DataTable에 채워 저장합니다.
사업계획서에 "[기술 검증 필요]"로 적힌 "임시 버전 에셋 불러오기" 단계가 여기에 해당하고, 아직 검증하지 않았습니다.

## 구조

```
assetguard.ps1          Git에서 세 버전 꺼내기, 로컬 화면 띄우기, 결과 저장 + git add
assetguard.cmd          cmd/탐색기에서 실행하는 래퍼
install.ps1             `git assetguard` 별칭 등록
web/merge.js            3-way 병합 엔진 (UI·Git과 분리된 순수 함수)
web/formats.js          DataTable JSON/CSV 읽기·쓰기 (원래 스타일 유지)
web/index.html, app.js  병합 화면: 출처 색 표시, 확인할 곳만 모아 보기, 충돌 선택
tests/merge.test.html   병합 엔진·포맷 테스트 20개
demo/make-demo-repo.ps1 충돌 재현용 데모 저장소 생성
```

## 테스트

```powershell
powershell -ExecutionPolicy Bypass -File assetguard.ps1 -ServeOnly
```

브라우저에서 `http://localhost:47813/tests/merge.test.html`을 열면 테스트가 실행됩니다.
같은 서버의 `http://localhost:47813/`에서는 내장 데모 데이터로 병합 화면을 볼 수 있습니다.
