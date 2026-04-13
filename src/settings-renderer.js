"use strict";

// ── Settings panel renderer ──
//
// Strict unidirectional flow (plan §4.2):
//
//   1. UI clicks → settingsAPI.update(key, value) → main → controller
//   2. Controller commits → broadcasts settings-changed
//   3. settingsAPI.onChanged fires → renderUI() rebuilds the affected row(s)
//
// We never optimistically toggle a switch in the click handler. The visual
// state always reflects what the store says — period. Failures show a toast
// and the switch stays in its previous position because the store was never
// committed.

// ── i18n (mirror src/i18n.js — bubbles can't require electron modules) ──
const STRINGS = {
  en: {
    settingsTitle: "Settings",
    settingsSubtitle: "Configure how Clawd behaves on your desktop.",
    sidebarGeneral: "General",
    sidebarAgents: "Agents",
    sidebarTheme: "Theme",
    sidebarAnimMap: "Animation Map",
    sidebarShortcuts: "Shortcuts",
    sidebarAbout: "About",
    sectionAppearance: "Appearance",
    sectionAlerts: "Alerts",
    sectionStartup: "Startup",
    sectionBubbles: "Bubbles",
    rowLanguage: "Language",
    rowLanguageDesc: "Interface language for menus and bubbles.",
    rowSound: "Sound effects",
    rowSoundDesc: "Play a chime when Clawd finishes a task or asks for input.",
    rowOpenAtLogin: "Open at login",
    rowOpenAtLoginDesc: "Start Clawd automatically when you log in.",
    rowStartWithClaude: "Start with Claude Code",
    rowStartWithClaudeDesc: "Auto-launch Clawd whenever a Claude Code session starts.",
    rowBubbleFollow: "Bubbles follow Clawd",
    rowBubbleFollowDesc: "Place permission and update bubbles next to the pet instead of the screen corner.",
    rowHideBubbles: "Hide all bubbles",
    rowHideBubblesDesc: "Suppress permission, notification, and update bubbles entirely.",
    rowShowSessionId: "Show session ID",
    rowShowSessionIdDesc: "Append the short session ID to bubble headers and the Sessions menu.",
    placeholderTitle: "Coming soon",
    placeholderDesc: "This panel will land in a future Clawd release.",
    toastSaveFailed: "Couldn't save: ",
    langEnglish: "English",
    langChinese: "中文",
    langKorean: "한국어",
    agentsTitle: "Agents",
    agentsSubtitle: "Enable or disable individual AI coding agents. Disabled agents ignore all hook events.",
    aboutTitle: "About",
    aboutSubtitle: "Clawd on Desk — a desktop pet that reacts to your AI coding sessions.",
    aboutVersion: "Version",
    aboutRepo: "Repository",
    aboutLicense: "License",
  },
  zh: {
    settingsTitle: "设置",
    settingsSubtitle: "配置 Clawd 在桌面上的行为。",
    sidebarGeneral: "通用",
    sidebarAgents: "Agent 管理",
    sidebarTheme: "主题",
    sidebarAnimMap: "动画映射",
    sidebarShortcuts: "快捷键",
    sidebarAbout: "关于",
    sectionAppearance: "外观",
    sectionAlerts: "提示",
    sectionStartup: "启动",
    sectionBubbles: "气泡",
    rowLanguage: "语言",
    rowLanguageDesc: "菜单和气泡的界面语言。",
    rowSound: "音效",
    rowSoundDesc: "Clawd 完成任务或需要输入时播放提示音。",
    rowOpenAtLogin: "开机自启",
    rowOpenAtLoginDesc: "登录系统时自动启动 Clawd。",
    rowStartWithClaude: "随 Claude Code 启动",
    rowStartWithClaudeDesc: "Claude Code 会话开始时自动拉起 Clawd。",
    rowBubbleFollow: "气泡跟随 Clawd",
    rowBubbleFollowDesc: "把权限气泡和更新气泡放在桌宠旁边，而不是屏幕角落。",
    rowHideBubbles: "隐藏所有气泡",
    rowHideBubblesDesc: "完全屏蔽权限、通知和更新气泡。",
    rowShowSessionId: "显示会话 ID",
    rowShowSessionIdDesc: "在气泡标题和会话菜单后追加短会话 ID。",
    placeholderTitle: "即将推出",
    placeholderDesc: "此面板将在 Clawd 后续版本中加入。",
    toastSaveFailed: "保存失败：",
    langEnglish: "English",
    langChinese: "中文",
    langKorean: "한국어",
    agentsTitle: "Agent 管理",
    agentsSubtitle: "启用/禁用各个 AI 编码代理。禁用的代理会忽略所有 hook 事件。",
    aboutTitle: "关于",
    aboutSubtitle: "Clawd on Desk — 响应你 AI 编程会话的桌面宠物。",
    aboutVersion: "版本",
    aboutRepo: "代码仓库",
    aboutLicense: "许可证",
  },
  ko: {
    settingsTitle: "설정",
    settingsSubtitle: "Clawd의 동작 방식을 설정합니다.",
    sidebarGeneral: "일반",
    sidebarAgents: "에이전트",
    sidebarTheme: "테마",
    sidebarAnimMap: "애니메이션 매핑",
    sidebarShortcuts: "단축키",
    sidebarAbout: "정보",
    sectionAppearance: "외관",
    sectionAlerts: "알림",
    sectionStartup: "시작",
    sectionBubbles: "말풍선",
    rowLanguage: "언어",
    rowLanguageDesc: "메뉴와 말풍선의 UI 언어입니다.",
    rowSound: "효과음",
    rowSoundDesc: "작업 완료/입력 요청 시 소리 재생.",
    rowOpenAtLogin: "로그인 시 시작",
    rowOpenAtLoginDesc: "윈도우 로그인 시 Clawd 자동 실행.",
    rowStartWithClaude: "Claude Code와 함께 시작",
    rowStartWithClaudeDesc: "Claude Code 세션 시작 시 Clawd 자동 실행.",
    rowBubbleFollow: "말풍선이 Clawd 따라가기",
    rowBubbleFollowDesc: "권한/업데이트 말풍선을 Clawd 옆에 배치.",
    rowHideBubbles: "말풍선 숨기기",
    rowHideBubblesDesc: "권한/알림/업데이트 말풍선 전부 차단.",
    rowShowSessionId: "세션 ID 표시",
    rowShowSessionIdDesc: "말풍선 헤더와 세션 메뉴에 짧은 세션 ID 표시.",
    placeholderTitle: "준비중",
    placeholderDesc: "이 패널은 향후 Clawd 업데이트에서 추가됩니다.",
    toastSaveFailed: "저장 실패: ",
    langEnglish: "English",
    langChinese: "中文",
    langKorean: "한국어",
    agentsTitle: "에이전트",
    agentsSubtitle: "개별 AI 코딩 에이전트를 켜고 끌 수 있습니다. 꺼진 에이전트는 hook 이벤트를 무시합니다.",
    aboutTitle: "정보",
    aboutSubtitle: "Clawd on Desk — AI 코딩 세션에 반응하는 데스크탑 펫.",
    aboutVersion: "버전",
    aboutRepo: "저장소",
    aboutLicense: "라이선스",
  },
};

let snapshot = null;
let activeTab = "general";

function t(key) {
  const lang = (snapshot && snapshot.lang) || "en";
  const dict = STRINGS[lang] || STRINGS.en;
  return dict[key] || key;
}

// ── Toast ──
const toastStack = document.getElementById("toastStack");
function showToast(message, { error = false, ttl = 3500 } = {}) {
  const node = document.createElement("div");
  node.className = "toast" + (error ? " error" : "");
  node.textContent = message;
  toastStack.appendChild(node);
  // Force reflow then add visible class so the transition runs.
  // eslint-disable-next-line no-unused-expressions
  node.offsetHeight;
  node.classList.add("visible");
  setTimeout(() => {
    node.classList.remove("visible");
    setTimeout(() => node.remove(), 240);
  }, ttl);
}

// ── Sidebar ──
const SIDEBAR_TABS = [
  { id: "general", icon: "\u2699", labelKey: "sidebarGeneral", available: true },
  { id: "agents", icon: "\u26A1", labelKey: "sidebarAgents", available: true },
  { id: "theme", icon: "\u{1F3A8}", labelKey: "sidebarTheme", available: true },
  { id: "animMap", icon: "\u{1F3AC}", labelKey: "sidebarAnimMap", available: true },
  { id: "shortcuts", icon: "\u2328", labelKey: "sidebarShortcuts", available: true },
  { id: "about", icon: "\u2139", labelKey: "sidebarAbout", available: true },
];

const AGENT_LIST = [
  { id: "claude-code", name: "Claude Code" },
  { id: "codex", name: "Codex CLI" },
  { id: "copilot-cli", name: "Copilot CLI" },
  { id: "cursor-agent", name: "Cursor Agent" },
  { id: "gemini-cli", name: "Gemini CLI" },
  { id: "opencode", name: "OpenCode" },
  { id: "vscode-agent", name: "VS Code Agent" },
  { id: "kiro-cli", name: "Kiro CLI" },
  { id: "codebuddy", name: "CodeBuddy" },
];

function renderSidebar() {
  const sidebar = document.getElementById("sidebar");
  sidebar.innerHTML = "";
  for (const tab of SIDEBAR_TABS) {
    const item = document.createElement("div");
    item.className = "sidebar-item";
    if (!tab.available) item.classList.add("disabled");
    if (tab.id === activeTab) item.classList.add("active");
    item.innerHTML =
      `<span class="sidebar-item-icon">${tab.icon}</span>` +
      `<span class="sidebar-item-label">${escapeHtml(t(tab.labelKey))}</span>` +
      (tab.available ? "" : `<span class="sidebar-item-soon">soon</span>`);
    if (tab.available) {
      item.addEventListener("click", () => {
        activeTab = tab.id;
        renderSidebar();
        renderContent();
      });
    }
    sidebar.appendChild(item);
  }
}

// ── Content ──
function renderContent() {
  const content = document.getElementById("content");
  content.innerHTML = "";
  if (activeTab === "general") {
    renderGeneralTab(content);
  } else if (activeTab === "agents") {
    renderAgentsTab(content);
  } else if (activeTab === "theme") {
    renderThemeTab(content);
  } else if (activeTab === "animMap") {
    renderAnimMapTab(content);
  } else if (activeTab === "shortcuts") {
    renderShortcutsTab(content);
  } else if (activeTab === "about") {
    renderAboutTab(content);
  } else {
    renderPlaceholder(content);
  }
}

function renderAnimMapTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("sidebarAnimMap");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = "각 상태에서 어떤 SVG가 재생되는지 확인하고 커스텀 오버라이드를 설정합니다.";
  parent.appendChild(subtitle);

  const states = [
    ["idle", "기본 (idle)"],
    ["thinking", "생각 (thinking)"],
    ["working", "작업 (working)"],
    ["juggling", "저글링 (juggling)"],
    ["sweeping", "청소 (sweeping)"],
    ["carrying", "운반 (carrying)"],
    ["error", "에러 (error)"],
    ["attention", "완료 (attention)"],
    ["notification", "알림 (notification)"],
    ["sleeping", "수면 (sleeping)"],
  ];
  const rows = states.map(([key, label]) => {
    const override = (snapshot && snapshot.themeOverrides && snapshot.themeOverrides[key]) || null;
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-main">` +
        `<div class="row-label">${escapeHtml(label)}</div>` +
        `<div class="row-desc">${escapeHtml(override || "(기본)")}</div>` +
      `</div>` +
      `<input type="text" class="row-input" placeholder="예: clawd-happy.svg" value="${escapeHtml(override || "")}" style="width:220px;padding:4px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);color:inherit;">`;
    const input = row.querySelector("input");
    input.addEventListener("change", () => {
      const newOverrides = { ...(snapshot.themeOverrides || {}) };
      if (input.value.trim()) {
        newOverrides[key] = input.value.trim();
      } else {
        delete newOverrides[key];
      }
      window.settingsAPI.update("themeOverrides", newOverrides).then(res => {
        if (res && res.status === "error") {
          showToast(t("toastSaveFailed") + (res.message || "themeOverrides"), { error: true });
        }
      });
    });
    return row;
  });
  parent.appendChild(buildSection(t("sidebarAnimMap"), rows));
}

function renderShortcutsTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("sidebarShortcuts");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = "Clawd의 전역 키보드 단축키입니다.";
  parent.appendChild(subtitle);

  const isMac = navigator.platform.includes("Mac");
  const shortcuts = [
    { label: "Clawd 숨기기/보이기", keys: isMac ? "⌘⇧⌥C" : "Ctrl+Shift+Alt+C" },
    { label: "권한 Allow (버블 표시 중)", keys: "Ctrl+Shift+Y" },
    { label: "권한 Deny (버블 표시 중)", keys: "Ctrl+Shift+N" },
  ];
  const rows = shortcuts.map(s => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-main">` +
        `<div class="row-label">${escapeHtml(s.label)}</div>` +
      `</div>` +
      `<kbd style="padding:4px 10px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);border-radius:6px;font-family:monospace;font-size:12px;">${escapeHtml(s.keys)}</kbd>`;
    return row;
  });
  parent.appendChild(buildSection(t("sidebarShortcuts"), rows));
}

function renderThemeTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("sidebarTheme");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("themeSubtitle") || "테마를 선택하거나 사용자 테마 폴더에 새 테마를 추가하세요.";
  parent.appendChild(subtitle);

  const listWrap = document.createElement("div");
  listWrap.className = "section-rows";
  parent.appendChild(buildSection(t("sidebarTheme"), [listWrap]));

  const openBtn = document.createElement("button");
  openBtn.className = "row";
  openBtn.style.cursor = "pointer";
  openBtn.textContent = t("openThemeDirBtn") || "📁 테마 폴더 열기";
  openBtn.addEventListener("click", () => window.settingsAPI.openThemeDir());
  parent.appendChild(openBtn);

  listWrap.textContent = "Loading…";
  window.settingsAPI.listThemes().then(themes => {
    listWrap.innerHTML = "";
    const currentId = (snapshot && snapshot.theme) || "clawd";
    for (const theme of themes) {
      const row = document.createElement("div");
      row.className = "row";
      const isActive = theme.id === currentId;
      row.innerHTML =
        `<div class="row-main">` +
          `<div class="row-label">${escapeHtml(theme.name)}${theme.builtin ? "" : " ✦"}</div>` +
          `<div class="row-desc">${escapeHtml(theme.id)}</div>` +
        `</div>` +
        `<button class="segmented-btn"${isActive ? " disabled" : ""}>${isActive ? "✓ Active" : "Select"}</button>`;
      const btn = row.querySelector("button");
      if (!isActive) {
        btn.addEventListener("click", () => {
          window.settingsAPI.update("theme", theme.id).then(res => {
            if (res && res.status === "error") {
              showToast(t("toastSaveFailed") + (res.message || "theme"), { error: true });
            }
          });
        });
      }
      listWrap.appendChild(row);
    }
    if (themes.length === 0) {
      listWrap.textContent = "(no themes found)";
    }
  });
}

function renderAgentsTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("agentsTitle");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("agentsSubtitle");
  parent.appendChild(subtitle);

  const rows = AGENT_LIST.map(agent => {
    const row = document.createElement("div");
    row.className = "row";
    const enabled = !!(snapshot && snapshot.agents && snapshot.agents[agent.id] && snapshot.agents[agent.id].enabled);
    row.innerHTML =
      `<div class="row-text">` +
        `<span class="row-label"></span>` +
        `<span class="row-desc"></span>` +
      `</div>` +
      `<div class="row-control"><div class="switch" role="switch"></div></div>`;
    row.querySelector(".row-label").textContent = agent.name;
    row.querySelector(".row-desc").textContent = agent.id;
    const sw = row.querySelector(".switch");
    if (enabled) sw.classList.add("on");
    sw.addEventListener("click", () => {
      if (sw.classList.contains("pending")) return;
      const cur = !!(snapshot && snapshot.agents && snapshot.agents[agent.id] && snapshot.agents[agent.id].enabled);
      const next = !cur;
      const newAgents = { ...(snapshot.agents || {}) };
      newAgents[agent.id] = { ...(newAgents[agent.id] || {}), enabled: next };
      sw.classList.add("pending");
      window.settingsAPI.update("agents", newAgents).then(res => {
        sw.classList.remove("pending");
        if (!res || res.status !== "ok") {
          showToast(t("toastSaveFailed") + (res && res.message || "agents"), { error: true });
        }
      }).catch(err => {
        sw.classList.remove("pending");
        showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      });
    });
    return row;
  });
  parent.appendChild(buildSection(t("agentsTitle"), rows));
}

function renderAboutTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("aboutTitle");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("aboutSubtitle");
  parent.appendChild(subtitle);

  const infoRows = [
    { k: t("aboutVersion"), v: (snapshot && snapshot._appVersion) || "dev" },
    { k: t("aboutRepo"), v: "github.com/rullerzhou-afk/clawd-on-desk" },
    { k: t("aboutLicense"), v: "MIT" },
  ].map(({ k, v }) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="row-main">` +
        `<div class="row-label">${escapeHtml(k)}</div>` +
      `</div>` +
      `<div class="row-value">${escapeHtml(v)}</div>`;
    return row;
  });
  parent.appendChild(buildSection(t("aboutTitle"), infoRows));
}

function renderPlaceholder(parent) {
  const div = document.createElement("div");
  div.className = "placeholder";
  div.innerHTML =
    `<div class="placeholder-icon">\u{1F6E0}</div>` +
    `<div class="placeholder-title">${escapeHtml(t("placeholderTitle"))}</div>` +
    `<div class="placeholder-desc">${escapeHtml(t("placeholderDesc"))}</div>`;
  parent.appendChild(div);
}

function renderGeneralTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("settingsTitle");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("settingsSubtitle");
  parent.appendChild(subtitle);

  // Section: Appearance
  parent.appendChild(buildSection(t("sectionAppearance"), [
    buildLanguageRow(),
    buildSwitchRow({
      key: "soundMuted",
      labelKey: "rowSound",
      descKey: "rowSoundDesc",
      // soundMuted is inverse: ON-switch means sound enabled.
      invert: true,
    }),
  ]));

  // Section: Startup
  parent.appendChild(buildSection(t("sectionStartup"), [
    buildSwitchRow({
      key: "openAtLogin",
      labelKey: "rowOpenAtLogin",
      descKey: "rowOpenAtLoginDesc",
    }),
    buildSwitchRow({
      key: "autoStartWithClaude",
      labelKey: "rowStartWithClaude",
      descKey: "rowStartWithClaudeDesc",
    }),
  ]));

  // Section: Bubbles
  parent.appendChild(buildSection(t("sectionBubbles"), [
    buildSwitchRow({
      key: "bubbleFollowPet",
      labelKey: "rowBubbleFollow",
      descKey: "rowBubbleFollowDesc",
    }),
    buildSwitchRow({
      key: "hideBubbles",
      labelKey: "rowHideBubbles",
      descKey: "rowHideBubblesDesc",
    }),
    buildSwitchRow({
      key: "showSessionId",
      labelKey: "rowShowSessionId",
      descKey: "rowShowSessionIdDesc",
    }),
  ]));
}

function buildSection(title, rows) {
  const section = document.createElement("section");
  section.className = "section";
  const heading = document.createElement("h2");
  heading.className = "section-title";
  heading.textContent = title;
  section.appendChild(heading);
  const wrap = document.createElement("div");
  wrap.className = "section-rows";
  for (const row of rows) wrap.appendChild(row);
  section.appendChild(wrap);
  return section;
}

function buildSwitchRow({ key, labelKey, descKey, invert = false }) {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML =
    `<div class="row-text">` +
      `<span class="row-label"></span>` +
      `<span class="row-desc"></span>` +
    `</div>` +
    `<div class="row-control"><div class="switch" role="switch"></div></div>`;
  row.querySelector(".row-label").textContent = t(labelKey);
  row.querySelector(".row-desc").textContent = t(descKey);
  const sw = row.querySelector(".switch");
  const rawValue = !!(snapshot && snapshot[key]);
  const visualOn = invert ? !rawValue : rawValue;
  if (visualOn) sw.classList.add("on");
  sw.addEventListener("click", () => {
    if (sw.classList.contains("pending")) return;
    const currentRaw = !!(snapshot && snapshot[key]);
    const currentVisual = invert ? !currentRaw : currentRaw;
    const nextVisual = !currentVisual;
    const nextRaw = invert ? !nextVisual : nextVisual;
    sw.classList.add("pending");
    window.settingsAPI.update(key, nextRaw).then((result) => {
      sw.classList.remove("pending");
      if (!result || result.status !== "ok") {
        const msg = (result && result.message) || "unknown error";
        showToast(t("toastSaveFailed") + msg, { error: true });
      }
      // No optimistic update — re-render once the broadcast lands. If it
      // never lands (action failed), the visual state stays correct because
      // we never touched it.
    }).catch((err) => {
      sw.classList.remove("pending");
      showToast(t("toastSaveFailed") + (err && err.message), { error: true });
    });
  });
  return row;
}

function buildLanguageRow() {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML =
    `<div class="row-text">` +
      `<span class="row-label"></span>` +
      `<span class="row-desc"></span>` +
    `</div>` +
    `<div class="row-control">` +
      `<div class="segmented" role="tablist">` +
        `<button data-lang="en"></button>` +
        `<button data-lang="zh"></button>` +
        `<button data-lang="ko"></button>` +
      `</div>` +
    `</div>`;
  row.querySelector(".row-label").textContent = t("rowLanguage");
  row.querySelector(".row-desc").textContent = t("rowLanguageDesc");
  const buttons = row.querySelectorAll(".segmented button");
  buttons[0].textContent = t("langEnglish");
  buttons[1].textContent = t("langChinese");
  buttons[2].textContent = t("langKorean") || "한국어";
  const current = (snapshot && snapshot.lang) || "en";
  for (const btn of buttons) {
    if (btn.dataset.lang === current) btn.classList.add("active");
    btn.addEventListener("click", () => {
      const next = btn.dataset.lang;
      if (next === ((snapshot && snapshot.lang) || "en")) return;
      window.settingsAPI.update("lang", next).then((result) => {
        if (!result || result.status !== "ok") {
          const msg = (result && result.message) || "unknown error";
          showToast(t("toastSaveFailed") + msg, { error: true });
        }
      });
    });
  }
  return row;
}

// ── Boot ──
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

window.settingsAPI.onChanged((payload) => {
  if (payload && payload.snapshot) {
    snapshot = payload.snapshot;
  } else if (payload && payload.changes && snapshot) {
    snapshot = { ...snapshot, ...payload.changes };
  }
  renderSidebar();
  renderContent();
});

window.settingsAPI.getSnapshot().then((snap) => {
  snapshot = snap || {};
  renderSidebar();
  renderContent();
});
