<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd">
</p>
<h1 align="center">Clawd on Desk (한국어 포크)</h1>
<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">中文</a>
</p>

AI 코딩 에이전트 세션에 실시간으로 반응하는 데스크탑 펫. Clawd는 화면 위에 살면서 — 프롬프트 보내면 생각하고, 도구 실행하면 타이핑, 서브에이전트 여러 개면 저글링, 권한 승인 필요하면 버블 띄우고, 작업 완료하면 축하하고, 자리 비우면 잠듭니다. 두 가지 기본 테마 제공: **Clawd** (픽셀 게)와 **Calico** (삼색 고양이), 커스텀 테마도 지원.

> Windows 11, macOS, Ubuntu/Linux 지원. Node.js 필요. **Claude Code**, **Codex CLI**, **Copilot CLI**, **Gemini CLI**, **Cursor Agent**, **Kiro CLI**, **opencode**, **VS Code Agent** 지원.

## 이 포크의 추가 기능

원작자 [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)에 다음 기능들을 추가한 한국어 포크입니다.

### 🇰🇷 한국어 지원
- 메뉴/설정 패널 전부 한국어 번역
- `Language` 메뉴에 "한국어" 옵션 추가 (기존 English/中文 옆)

### 💬 말풍선 (Speech Bubbles)
- Clawd 머리 위에 말풍선 창 (투명, 다크모드 대응, 꼬리 달린 디자인)
- 20초마다 40% 확률로 랜덤 대사 (해킹 농담, 코딩 팁 포함)
- Claude Code 상태 변경 시 자동 말풍선 (thinking, working, error, attention 등)
- 우클릭 메뉴 → 💬 Say hi! 로 즉시 테스트

### ⏲ 포모도로 타이머
- 25분 / 15분 / 50분 선택
- 시작 시 typing 애니메이션, 5분·1분 남았을 때 경고, 완료 시 happy + 완료 사운드
- 우클릭 메뉴 → ⏲ 포모도로

### 🌍 중력 / 🚶 걷기 / 🎯 커서 따라가기
- **중력 모드**: 집어서 놓으면 바닥까지 자유낙하 (끌 수 있음, 기본값 off)
- **자유롭게 걷기**: Clawd가 스스로 좌우로 돌아다님. IDLE 상태일 때만 동작, crab-walking 애니 사용, 방향에 따라 스프라이트 좌우 반전
- **커서 따라가기**: Clawd가 마우스 커서를 쫓아다님

### 😵 흔들기 감지
- 드래그 중 빠르게 좌우로 흔들면 dizzy 애니메이션 + "어지러워!" 말풍선
- 놓아도 2.5초간 어지러움 유지 (공중에 있으면 해제 시 낙하)

### 🎭 동작 메뉴
우클릭 → 동작 서브메뉴에서 즉시 애니메이션 재생
- idle / thinking / typing / building / juggling / conducting / happy / error / notification / sweeping / carrying / sleeping
- **clawd-tank 추가 애니**: walking / dizzy / disconnected / going-away / beacon / confused / overheated / pushing / wizard

### ⚙ Settings 패널 확장
- 🤖 **Agents** 탭: 에이전트별 on/off 토글 (실제 작동)
- 🎨 **Theme** 탭: 설치된 테마 목록에서 전환 + 테마 폴더 열기
- 🎬 **Animation Map** 탭: 상태별 SVG 오버라이드
- ⌨ **Shortcuts** 탭: 전역 단축키 목록
- ℹ **About** 탭: 버전/저장소/라이선스

### 🔄 Restart 메뉴
- 트레이/컨텍스트 메뉴에 앱 재시작 버튼

### 💻 VS Code Agent 추가
- 새 에이전트 config `vscode-agent.js` (프로세스 감지)

### ⚡ WSL 지원
- WSL에서 `claude`/`codex` 실행 시 Windows Clawd가 반응
- `auto-start.js`가 WSL 감지 후 `cmd.exe`로 Windows npm start 실행
- Codex WSL ↔ Windows 세션 폴더 심링크로 통합

## 설치

```bash
git clone https://github.com/serize06/clawd-on-desk-kr.git
cd clawd-on-desk-kr
npm install
npm start
```

첫 실행 시 `~/.claude/settings.json`, `~/.cursor/hooks.json` 등에 훅 자동 등록됩니다.

## WSL에서 Claude Code 사용 시 추가 설정

WSL2 mirrored 네트워킹 필요:
```ini
# C:\Users\<you>\.wslconfig
[wsl2]
networkingMode=mirrored
```

WSL `~/.claude/settings.json`에도 Windows 훅 경로 등록:
```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node /mnt/c/Users/<you>/clawd-on-desk/hooks/auto-start.js" }] },
      { "matcher": "", "hooks": [{ "type": "command", "command": "node /mnt/c/Users/<you>/clawd-on-desk/hooks/clawd-hook.js SessionStart" }] }
    ],
    "PermissionRequest": [{ "matcher": "", "hooks": [{ "type": "http", "url": "http://127.0.0.1:23333/permission", "timeout": 600 }] }]
  }
}
```

(SessionEnd, PreToolUse, PostToolUse 등 다른 훅도 동일 패턴)

## 라이선스

MIT — 원작자 [rullerzhou-afk](https://github.com/rullerzhou-afk) + 이 포크의 수정 사항.

## 크레딧

- 원작: [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) (MIT)
- 추가 SVG 애니메이션: [marciogranzotto/clawd-tank](https://github.com/marciogranzotto/clawd-tank) (MIT)
