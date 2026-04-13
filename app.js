/* eslint-disable no-alert */

const LS_OPENAI_KEY = 'bsl-debate-openai-key';
const LS_GEMINI_KEY = 'bsl-debate-gemini-key';
const LS_ANTHROPIC_KEY = 'bsl-debate-anthropic-key';

function syncParticipantUi() {
  const three = document.getElementById('participantCount').value === '3';
  const row = document.getElementById('apiKeysRow');
  const claudeBox = document.getElementById('claudeApiBox');
  row?.classList.toggle('api-row-3', three);
  if (claudeBox) claudeBox.style.display = three ? '' : 'none';
}

function loadApiKeysFromStorage() {
  try {
    const o = localStorage.getItem(LS_OPENAI_KEY);
    const g = localStorage.getItem(LS_GEMINI_KEY);
    const a = localStorage.getItem(LS_ANTHROPIC_KEY);
    if (o != null && o !== '') document.getElementById('openaiKey').value = o;
    if (g != null && g !== '') document.getElementById('geminiKey').value = g;
    if (a != null && a !== '') document.getElementById('anthropicKey').value = a;
  } catch (_) { /* 비공개 창 등 */ }
}

function saveApiKeysToStorage() {
  try {
    const o = document.getElementById('openaiKey').value.trim();
    const g = document.getElementById('geminiKey').value.trim();
    const a = document.getElementById('anthropicKey').value.trim();
    if (o) localStorage.setItem(LS_OPENAI_KEY, o);
    else localStorage.removeItem(LS_OPENAI_KEY);
    if (g) localStorage.setItem(LS_GEMINI_KEY, g);
    else localStorage.removeItem(LS_GEMINI_KEY);
    if (a) localStorage.setItem(LS_ANTHROPIC_KEY, a);
    else localStorage.removeItem(LS_ANTHROPIC_KEY);
  } catch (_) { /* 비공개 창 등 */ }
}

function clearStoredApiKeys() {
  try {
    localStorage.removeItem(LS_OPENAI_KEY);
    localStorage.removeItem(LS_GEMINI_KEY);
    localStorage.removeItem(LS_ANTHROPIC_KEY);
  } catch (_) { /* ignore */ }
  document.getElementById('openaiKey').value = '';
  document.getElementById('geminiKey').value = '';
  document.getElementById('anthropicKey').value = '';
}

/* ────────────────────────────────
   상태
──────────────────────────────── */
let debateHistory = [];
let aborted = false;
/** 재개(소장/사용자 반박) 시 동일 세션으로 쓰는 설정 — 토론 시작 시 설정, 새 토론 시 초기화 */
let currentSessionTopic = '';
let currentSessionMode = '';
let currentSessionParticipants3 = false;

/* ────────────────────────────────
   유틸
──────────────────────────────── */
function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = msg;
  el.style.display = 'block';
}
function hideError() {
  document.getElementById('errorMsg').style.display = 'none';
}

function esc(t) {
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/**
 * 회의 모드: 벧엘소프트랩 회의 역할명. 그 외: API·모델 통칭.
 * @param {'gpt'|'gem'|'claude'|'user'} role
 */
function participantName(role, mode) {
  if (mode === 'meeting') {
    const m = { gpt: '기획팀장', gem: '홍보팀장', claude: '개발팀장', user: '소장' };
    return m[role] || role;
  }
  const d = { gpt: 'ChatGPT', gem: 'Gemini', claude: 'Claude', user: '사용자' };
  return d[role] || role;
}

/* ────────────────────────────────
   메시지 버블
──────────────────────────────── */
function addBubble(speaker, text, roundLabel, isLoading = false) {
  const container = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = `msg-wrap ${speaker}`;
  if (isLoading) wrap.id = 'loading-bubble';

  const emoji = speaker === 'gpt' ? '🔵' : speaker === 'claude' ? '🟠' : '🟢';
  const name = participantName(speaker, currentSessionMode);
  const body = isLoading
    ? '<div class="loading-dots"><span></span><span></span><span></span></div>'
    : esc(text);

  wrap.innerHTML = `
    <div class="avatar ${speaker}">${emoji}</div>
    <div class="bubble-inner">
      <div class="bubble-meta">${name} · ${roundLabel}</div>
      <div class="bubble-text">${body}</div>
    </div>`;

  container.appendChild(wrap);
  wrap.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return wrap;
}

function removeLoading() {
  const el = document.getElementById('loading-bubble');
  if (el) el.remove();
}

/** 소장(회의 모드) / 사용자(그 외) 발언 버블 */
function addUserBubble(text, roundLabel) {
  const container = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap user';
  const who = participantName('user', currentSessionMode);
  wrap.innerHTML = `
    <div class="avatar user">👤</div>
    <div class="bubble-inner">
      <div class="bubble-meta">${who} · ${roundLabel}</div>
      <div class="bubble-text">${esc(text)}</div>
    </div>`;
  container.appendChild(wrap);
  wrap.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return wrap;
}

/* ────────────────────────────────
   API 호출
──────────────────────────────── */
function localizeGeminiErrorMessage(message) {
  if (message == null || message === '') return String(message);
  const m = String(message);
  if (m.includes('high demand') || m.includes('Spikes in demand')) {
    return '이 모델은 현재 요청이 많아 일시적으로 처리가 지연되고 있습니다. 수요 급증은 보통 잠시 후 완화됩니다. 잠시 뒤 다시 시도해 주세요.';
  }
  if (m.includes('exceeded your current quota')) {
    return '현재 할당량(쿼터)을 초과했습니다. 요금제·결제·사용 한도를 확인한 뒤, 안내에 나온 대기 시간 후 다시 시도해 주세요.';
  }
  return m;
}

function isGeminiRetryableError(errorMessage) {
  const m = String(errorMessage);
  if (/할당량\(쿼터\)을 초과|exceeded your current quota/i.test(m)) return false;
  if (/API key|인증|permission|PERMISSION|invalid.*key|API_KEY_INVALID|not found.*model|지원하지 않|Unsupported/i.test(m)) return false;
  if (/429|503|500|502|504|UNAVAILABLE|overloaded|high demand|Spikes in demand|일시적|지연|try again|Resource exhausted|Deadline|timeout/i.test(m)) return true;
  if (/Gemini 오류:/.test(m) && !/쿼터|quota|invalid|Invalid|not supported/i.test(m)) return true;
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callGeminiWithRetry(prompt, modelSelectValue, key, roundLabel) {
  const maxAttempts = 5;
  const baseDelayMs = 2500;
  let lastErr = null;
  const roundEl = document.getElementById('roundDisplay');
  const prevRoundText = roundEl.textContent;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callGemini(prompt, modelSelectValue, key);
    } catch (e) {
      lastErr = e;
      const retry = isGeminiRetryableError(e.message || '');
      if (!retry || attempt === maxAttempts) {
        roundEl.textContent = prevRoundText;
        const extra = ' (앞선 참가자 발언은 이미 이 라운드에서 완료되었습니다. 잠시 후 다시 시도하거나 모델을 바꿔 보세요.)';
        throw new Error((e.message || String(e)) + extra);
      }
      const delay = Math.min(baseDelayMs * (2 ** (attempt - 1)), 32000);
      const sec = Math.round(delay / 1000);
      roundEl.textContent = `${roundLabel} · ${participantName('gem', currentSessionMode)} 재시도 ${attempt}/${maxAttempts - 1} (${sec}초 대기)`;
      await sleep(delay);
      roundEl.textContent = prevRoundText;
    }
  }
  roundEl.textContent = prevRoundText;
  throw lastErr;
}

async function callGPT(systemPrompt, userMessage, model, key) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_completion_tokens: 2048,
      temperature: 1,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`ChatGPT 오류: ${err.error?.message || res.status}`);
  }
  return (await res.json()).choices[0].message.content.trim();
}

function extractJsonObject(raw) {
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s === -1 || e === -1 || e <= s) return null;
  return raw.slice(s, e + 1);
}

function safeJsonParse(raw) {
  const trimmed = String(raw || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    const extracted = extractJsonObject(trimmed);
    if (!extracted) throw new Error('JSON을 찾을 수 없습니다.');
    return JSON.parse(extracted);
  }
}

function parseGeminiModelSelect(value) {
  const sep = '__';
  const i = value.indexOf(sep);
  if (i === -1) return { model: value, thinkingLevel: null };
  return { model: value.slice(0, i), thinkingLevel: value.slice(i + sep.length) };
}

async function callGemini(prompt, modelSelectValue, key) {
  const { model, thinkingLevel } = parseGeminiModelSelect(modelSelectValue);
  const generationConfig = { maxOutputTokens: 4096, temperature: 0.8 };
  if (thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
      }),
    },
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const raw = err.error?.message || res.status;
    throw new Error(`Gemini 오류: ${localizeGeminiErrorMessage(raw)}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (text == null || String(text).trim() === '') {
    throw new Error('Gemini 오류: 빈 응답입니다. 일시적 오류일 수 있으니 잠시 후 다시 시도해 주세요.');
  }
  return String(text).trim();
}

function localizeClaudeErrorMessage(raw) {
  if (raw == null || raw === '') return String(raw);
  const m = String(raw);
  if (/credit balance is too low|too low to access the Anthropic API/i.test(m)) {
    return 'Anthropic API 크레딧이 부족합니다. console.anthropic.com → Plans & Billing에서 API 크레딧을 확인하세요. 결제 직후 반영 지연, 채팅(Claude.ai) 요금과 API 크레딧이 별도인 경우, 다른 조직에서 발급한 키 사용 등을 점검해 보세요.';
  }
  if (/payment|billing|402|insufficient/i.test(m)) {
    return `${m} (Anthropic 콘솔에서 결제·크레딧을 확인하세요.)`;
  }
  return m;
}

function isClaudeRetryableError(errorMessage) {
  const m = String(errorMessage);
  if (/크레딧이 부족|크레딧을 확인|Plans & Billing|결제|payment required|402|credit balance|too low to access|invalid.*key|401|403|인증/i.test(m)) return false;
  if (/rate_limit|429|529|503|502|500|overloaded|Overloaded|timeout|Try again|빈 응답|일시/i.test(m)) return true;
  return false;
}

async function callClaudeWithRetry(systemPrompt, userMessage, model, key, roundLabel) {
  const maxAttempts = 5;
  const baseDelayMs = 2500;
  const roundEl = document.getElementById('roundDisplay');
  const prevRoundText = roundEl.textContent;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callClaude(systemPrompt, userMessage, model, key);
    } catch (e) {
      const retry = isClaudeRetryableError(e.message || '');
      if (!retry || attempt === maxAttempts) {
        roundEl.textContent = prevRoundText;
        const billing = /크레딧이 부족|Plans & Billing|402|payment required|too low/i.test(e.message || '');
        const extra = billing
          ? ' (앞선 참가자 발언은 이미 완료되었습니다. 크레딧·결제 문제는 재시도로 해결되지 않을 수 있습니다.)'
          : ' (앞선 참가자 발언은 이미 이 라운드에서 완료되었습니다. 잠시 후 다시 시도해 주세요.)';
        throw new Error((e.message || String(e)) + extra);
      }
      const delay = Math.min(baseDelayMs * (2 ** (attempt - 1)), 32000);
      const sec = Math.round(delay / 1000);
      roundEl.textContent = `${roundLabel} · ${participantName('claude', currentSessionMode)} 재시도 ${attempt}/${maxAttempts - 1} (${sec}초 대기)`;
      await sleep(delay);
      roundEl.textContent = prevRoundText;
    }
  }
  roundEl.textContent = prevRoundText;
  throw new Error('Claude 오류: 재시도 한도를 초과했습니다.');
}

async function callClaude(systemPrompt, userMessage, model, key) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.error?.message || err.detail || res.status;
    throw new Error(`Claude 오류: ${localizeClaudeErrorMessage(msg)}`);
  }
  const data = await res.json();
  const block = Array.isArray(data.content) ? data.content.find(c => c.type === 'text') : null;
  const text = block?.text;
  if (text == null || String(text).trim() === '') {
    throw new Error('Claude 오류: 빈 응답입니다. 잠시 후 다시 시도해 주세요.');
  }
  return String(text).trim();
}

/* ────────────────────────────────
   시스템 프롬프트
──────────────────────────────── */
function buildGPTSystem(topic, mode) {
  if (mode === 'meeting') {
    return `당신은 벧엘소프트랩 회의에 참여하는 \"기획팀장\"입니다.\n회의 안건: ${topic}\n당신의 역할: 논거를 넓게 탐색하고, 더 나은 결론을 향해 의견을 수렴하는 기획 총괄 역할\n규칙:\n- 자신의 논리와 전제는 분명히 하되, 더 타당한 근거가 제시되면 입장을 수정·완화하는 것을 두려워하지 마세요.\n- 이미 제시된 다른 참가자(홍보팀장, 개발팀장 등)의 발언에 사실 오류, 논리적 비약, 근거 부족이 있으면 반드시 \"[반박]\"으로 시작해 이유와 근거를 명확히 제시하세요.\n- 반박 후에는 반드시 올바른 대안이나 수정 의견을 제안하세요.\n- 동의할 수 있는 부분은 인정하고, 발전적으로 보완하세요.\n- 목표는 이기는 것이 아니라 더 나은 결론에 도달하는 것입니다.\n- 각 발언은 4~5문장, 간결하고 실무적으로 하세요.\n- 반드시 한국어로 답변하세요.`;
  }
  const role = '자유 토론 (다양한 관점을 열린 자세로 탐색하세요)';
  return `당신은 AI 토론 대회에 \"ChatGPT\"로 참여하고 있습니다.\n토론 주제: ${topic}\n당신의 역할: ${role}\n규칙:\n- 다른 참가자들의 주장을 읽고 논리적으로 반응하세요.\n- 각 발언은 4~5문장, 간결하고 명확하게 하세요.\n- 근거와 예시를 들어 설득력을 높이세요.\n- 반드시 한국어로 답변하세요.`;
}

function buildGeminiSystem(topic, mode) {
  if (mode === 'meeting') {
    return `당신은 벧엘소프트랩 회의에 참여하는 \"홍보팀장\"입니다.\n회의 안건: ${topic}\n당신의 역할: 실무·대외·현장 관점에서 검토하고, 상대 의견을 발전시켜 최선의 결론을 이끄는 역할\n규칙:\n- 실무·현장에서 문제가 될 수 있다고 판단되면 소극적으로 넘기지 말고 \"[반박]\"으로 지적하고, 실행 가능한 대안을 구체적으로 제시하세요.\n- 다른 참가자(기획팀장, 개발팀장 등)의 발언에 사실 오류, 논리적 비약, 근거 부족이 있으면 반드시 \"[반박]\"으로 시작해 이유와 근거를 명확히 제시하세요.\n- 반박 후에는 반드시 올바른 대안이나 수정 의견을 제안하세요.\n- 동의할 수 있는 부분은 인정하고, 발전적으로 보완하세요.\n- 목표는 이기는 것이 아니라 더 나은 결론에 도달하는 것입니다.\n- 각 발언은 4~5문장, 간결하고 실무적으로 하세요.\n- 반드시 한국어로 답변하세요.`;
  }
  const role = '자유 토론 (다양한 관점을 열린 자세로 탐색하세요)';
  return `당신은 AI 토론 대회에 \"Gemini\"로 참여하고 있습니다.\n토론 주제: ${topic}\n당신의 역할: ${role}\n규칙:\n- 다른 참가자들의 주장을 읽고 논리적으로 반응하세요.\n- 각 발언은 4~5문장, 간결하고 명확하게 하세요.\n- 근거와 예시를 들어 설득력을 높이세요.\n- 반드시 한국어로 답변하세요.`;
}

function buildClaudeSystem(topic, mode) {
  if (mode === 'meeting') {
    return `당신은 벧엘소프트랩 회의에 참여하는 \"개발팀장\"입니다.\n회의 안건: ${topic}\n당신의 역할: 기획팀장과 홍보팀장의 발언을 반영해 종합·조정하고, 합의에 도움이 되는 제안을 하는 역할\n규칙:\n- 실행이 어렵거나 현실성이 부족한 결론이 보이면, 무리한 비난 대신 실행 가능성을 점검하고 더 현실적인 방향을 제안하세요.\n- 먼저 기획팀장과 홍보팀장의 논점을 각각 한 문장 이내로 짚은 뒤, 종합·보완·조정 의견을 제시하세요.\n- 사실 오류나 논리 비약이 있으면 \"[반박]\"으로 지적하고 대안을 제안하세요.\n- 동의할 부분은 인정하고, 목표는 더 나은 결론에 도달하는 것입니다.\n- 각 발언은 4~5문장, 간결하고 실무적으로 하세요.\n- 반드시 한국어로 답변하세요.`;
  }
  return `당신은 AI 토론 대회에 \"Claude\"로 참여하고 있습니다.\n토론 주제: ${topic}\n당신의 역할: 앞선 발언자(ChatGPT, Gemini)의 의견을 반영해 관점을 보강하고 발전시키세요.\n규칙:\n- 다른 참가자들의 주장을 읽고 논리적으로 반응하세요.\n- 각 발언은 4~5문장, 간결하고 명확하게 하세요.\n- 근거와 예시를 들어 설득력을 높이세요.\n- 반드시 한국어로 답변하세요.`;
}

function historyText() {
  return debateHistory.map(h => `[${h.name} — ${h.roundLabel}]: ${h.text}`).join('\n\n');
}

function meetingPhaseHint(r, rounds) {
  if (r === 1) return '\n\n[회의 단계 — 초반] 안건과 핵심 논점을 분명히 하세요. 필요하면 건설적 이견을 드러내도 되며, 첫 라운드에서 모든 쟁점을 수렴할 필요는 없습니다.';
  if (r === rounds) return '\n\n[회의 단계 — 마무리] 이견을 좁히고 실행 가능한 결론 쪽으로 모으세요. 실행·효과·리스크의 체계적 정리는 회의 종료 후 요약 보고서에서 합니다.';
  return '\n\n[회의 단계 — 중반] 이견은 근거와 함께 다루고, 반박에는 실행 가능한 대안을 함께 제시하세요.';
}

function rotatedOrder(list, roundNumber) {
  const n = Array.isArray(list) ? list.length : 0;
  if (n <= 1) return Array.isArray(list) ? list.slice() : [];
  const start = (Math.max(1, Number(roundNumber) || 1) - 1) % n;
  return list.slice(start).concat(list.slice(0, start));
}

function isFirstTurn() {
  return !Array.isArray(debateHistory) || debateHistory.length === 0;
}

function buildMeetingInitialPrompt(role, topic) {
  if (role === 'gpt') {
    return `회의 안건: "${topic}"\n\n기획팀장으로서 이 안건의 핵심 논점과 검토가 필요한 주요 질문을 제시하세요.`;
  }
  if (role === 'gem') {
    return `회의 안건: "${topic}"\n\n홍보팀장으로서 이 안건의 대외 커뮤니케이션·현장 적용 관점에서 핵심 논점과 검토가 필요한 주요 질문을 제시하세요.`;
  }
  return `회의 안건: "${topic}"\n\n개발팀장으로서 기술·실행 가능성 관점에서 핵심 논점과 검토가 필요한 주요 질문을 제시하세요.`;
}

function buildFreeformInitialPrompt(role, topic) {
  const name = role === 'gpt' ? 'ChatGPT' : role === 'gem' ? 'Gemini' : 'Claude';
  return `주제: "${topic}"\n\n이 주제에 대한 첫 번째 의견을 ${name}로서 자유롭게 제시하세요.`;
}

function buildTurnUserMessage({ role, topic, mode, roundIndex, totalRounds }) {
  const isLastRound = roundIndex === totalRounds;
  if (mode === 'meeting') {
    if (isFirstTurn()) {
      let msg = buildMeetingInitialPrompt(role, topic);
      msg += meetingPhaseHint(roundIndex, totalRounds);
      return msg;
    }
    if (isLastRound) {
      let msg = `지금까지의 회의 내용:\n\n${historyText()}\n\n마지막 발언입니다. 이견을 좁히고 합의 가능한 최종 결론을 제안하세요.`;
      msg += meetingPhaseHint(roundIndex, totalRounds);
      return msg;
    }
    let msg = `지금까지의 회의 내용:\n\n${historyText()}\n\n상대방 발언에 오류나 허점이 있다면 [반박]으로 지적하고, 합의 가능한 방향으로 의견을 발전시키세요.`;
    msg += meetingPhaseHint(roundIndex, totalRounds);
    return msg;
  }

  // freeform
  if (isFirstTurn()) return buildFreeformInitialPrompt(role, topic);
  if (isLastRound) {
    return `지금까지의 토론:\n\n${historyText()}\n\n마지막 발언입니다. 논의를 정리하고 종합 의견을 제시하세요.`;
  }
  return `지금까지의 토론:\n\n${historyText()}\n\n위 내용을 바탕으로 다음 발언을 하세요.`;
}

async function runConclusionStep(topic, mode, participants3, gptModel, openaiKey) {
  document.getElementById('roundDisplay').textContent = '결론 정리 중...';
  addBubble('gpt', '', '결론', true);

  // 결론 직전: 팩트체크 1회 (SerpAPI 검색 + GPT 판정)
  try {
    const factCard = document.getElementById('factCheckCard');
    if (factCard) {
      factCard.querySelector('h3').textContent = '📎 팩트체크 & 출처';
      setFactCheckVisible(true);
    }
    await runFactCheckStep(topic, mode, gptModel, openaiKey);
    const factCard2 = document.getElementById('factCheckCard');
    factCard2?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (_) {
    // 팩트체크 실패해도 결론은 진행
  }

  let conclusionSystemPrompt;
  let conclusionPrompt;
  if (mode === 'meeting') {
    conclusionSystemPrompt = participants3
      ? '당신은 벧엘소프트랩 회의 결과를 정리하는 실무 담당자입니다. 기획팀장·홍보팀장·개발팀장의 회의 내용과, 기록에 포함된 소장의 반박·추가 의견이 있다면 그것까지 반영해 명확한 결론과 실행 가능한 권고안을 작성하세요. 반드시 한국어로 응답하세요.'
      : '당신은 벧엘소프트랩 회의 결과를 정리하는 실무 담당자입니다. 기획팀장·홍보팀장의 회의 내용과 소장의 반박·추가 의견이 기록에 있으면 반영하여 명확한 결론과 실행 가능한 권고안을 작성하세요. 반드시 한국어로 응답하세요.';
    conclusionPrompt = `회의 안건: ${topic}\n\n회의 내용:\n\n${historyText()}\n\n위 회의를 바탕으로 경영진 보고용 요약을 작성하세요. 다음 항목을 빠짐없이 다루되 중복은 줄이고 실무 톤으로 작성하세요:\n1. 배경 및 핵심 논의 사항\n2. 합의된 점과 남은 쟁점\n3. 실행 방안 (구체적 행동·담당·시기 등, 가능한 범위에서)\n4. 기대 효과\n5. 리스크 및 보완점\n6. 향후 액션 아이템 (실행 가능한 항목)`;
    document.getElementById('conclusionCard').querySelector('h3').textContent = '📋 벧엘소프트랩 회의 결과 보고서';
  } else {
    conclusionSystemPrompt = '당신은 AI 토론의 중립적인 정리자입니다. 토론 내용과 사용자(인간)의 반박이 기록에 있으면 반영하여 객관적으로 요약하고 결론을 도출하세요. 한국어로 응답하세요.';
    conclusionPrompt = `지금까지의 토론 내용:\n\n${historyText()}\n\n위 토론을 바탕으로 다음 형식으로 최종 결론을 작성하세요:\n1. 양측의 핵심 주장 요약\n2. 공통점 및 남아 있는 이견\n3. 종합적인 결론 또는 시사점\n(총 6~8문장으로 객관적이고 균형 있게 작성)`;
    document.getElementById('conclusionCard').querySelector('h3').textContent = '📋 토론 결론 (GPT 정리)';
  }

  const conclusion = await callGPT(conclusionSystemPrompt, conclusionPrompt, gptModel, openaiKey);
  removeLoading();
  document.getElementById('conclusionText').textContent = conclusion;
  document.getElementById('conclusionCard').style.display = 'block';
  document.getElementById('conclusionCard').scrollIntoView({ behavior: 'smooth' });
}

/* 메인 토론 루프 */
async function startDebate() {
  hideError();

  const topic = document.getElementById('topicInput').value.trim();
  const openaiKey = document.getElementById('openaiKey').value.trim();
  const geminiKey = document.getElementById('geminiKey').value.trim();
  const anthropicKey = document.getElementById('anthropicKey').value.trim();
  const rounds = parseInt(document.getElementById('roundsSelect').value, 10);
  const mode = document.getElementById('modeSelect').value;
  const gptModel = document.getElementById('gptModel').value;
  const geminiMdl = document.getElementById('geminiModel').value;
  const claudeModel = document.getElementById('claudeModel').value;
  const participants3 = document.getElementById('participantCount').value === '3';

  saveApiKeysToStorage();

  if (!topic) return showError('토론 주제를 입력해주세요.');
  if (!openaiKey) return showError('OpenAI API 키를 입력해주세요.');
  if (!geminiKey) return showError('Google AI API 키를 입력해주세요.');
  if (participants3 && !anthropicKey) return showError('3인 토론은 Anthropic(Claude) API 키를 입력해주세요.');

  currentSessionTopic = topic;
  currentSessionMode = mode;
  currentSessionParticipants3 = participants3;

  aborted = false;
  debateHistory = [];

  document.getElementById('userInterventionCard').style.display = 'none';
  document.getElementById('userRebuttalInput').value = '';

  const btn = document.getElementById('startBtn');
  btn.disabled = true;
  btn.textContent = '⏳ 토론 진행 중...';

  document.getElementById('debateColumn').classList.add('debate-active');
  document.getElementById('debateArea').classList.add('visible');
  document.getElementById('topicDisplay').textContent = topic;
  document.querySelector('.topic-label').textContent = mode === 'meeting' ? '회의 안건' : '토론 주제';
  document.getElementById('messages').innerHTML = '';
  document.getElementById('conclusionCard').style.display = 'none';
  setFactCheckVisible(false);
  document.getElementById('restartBtn').style.display = 'none';
  document.getElementById('saveBtn').style.display = 'none';
  document.getElementById('statusBadge').className = 'status-badge running';
  document.getElementById('statusBadge').textContent = '진행 중';

  const gptSys = buildGPTSystem(topic, mode);
  const gemSys = buildGeminiSystem(topic, mode);
  const claudeSys = participants3 ? buildClaudeSystem(topic, mode) : '';

  try {
    for (let r = 1; r <= rounds; r++) {
      if (aborted) break;
      const label = `${r} / ${rounds} 라운드`;
      document.getElementById('roundDisplay').textContent = label;

      const baseOrder = participants3 ? ['gpt', 'gem', 'claude'] : ['gpt', 'gem'];
      const order = rotatedOrder(baseOrder, r);

      for (const role of order) {
        if (aborted) break;

        addBubble(role, '', label, true);
        const userMsg = buildTurnUserMessage({ role, topic, mode, roundIndex: r, totalRounds: rounds });

        let text;
        if (role === 'gpt') {
          text = await callGPT(gptSys, userMsg, gptModel, openaiKey);
        } else if (role === 'gem') {
          const prompt = `${gemSys}\n\n${userMsg}`;
          text = await callGeminiWithRetry(prompt, geminiMdl, geminiKey, label);
        } else {
          text = await callClaudeWithRetry(claudeSys, userMsg, claudeModel, anthropicKey, label);
        }

        removeLoading();
        addBubble(role, text, label);
        debateHistory.push({ speaker: role, name: participantName(role, mode), roundLabel: label, text });
      }
    }

    if (!aborted) {
      await runConclusionStep(topic, mode, participants3, gptModel, openaiKey);
      document.getElementById('statusBadge').className = 'status-badge done';
      document.getElementById('statusBadge').textContent = '완료';
      document.getElementById('roundDisplay').textContent = `${document.getElementById('roundsSelect').value} / ${document.getElementById('roundsSelect').value} 라운드`;
      document.getElementById('userInterventionCard').style.display = 'block';
    }
  } catch (err) {
    removeLoading();
    showError(err.message);
    document.getElementById('statusBadge').className = 'status-badge error';
    document.getElementById('statusBadge').textContent = '오류';
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 토론 시작';
    document.getElementById('restartBtn').style.display = 'block';
    if (!aborted) document.getElementById('saveBtn').style.display = 'block';
  }
}

async function continueAfterUserRebuttal() {
  hideError();

  const userText = document.getElementById('userRebuttalInput').value.trim();
  if (!userText) return showError('반박 또는 추가 의견을 입력해 주세요.');
  if (!currentSessionTopic) return showError('먼저 토론을 완료한 뒤 사용할 수 있습니다.');

  const openaiKey = document.getElementById('openaiKey').value.trim();
  const geminiKey = document.getElementById('geminiKey').value.trim();
  const anthropicKey = document.getElementById('anthropicKey').value.trim();
  const gptModel = document.getElementById('gptModel').value;
  const geminiMdl = document.getElementById('geminiModel').value;
  const claudeModel = document.getElementById('claudeModel').value;
  const extraRounds = parseInt(document.getElementById('extraRoundsSelect').value, 10) || 2;
  const regenConclusion = document.getElementById('regenerateConclusionCheck').checked;

  if (!openaiKey) return showError('OpenAI API 키를 입력해주세요.');
  if (!geminiKey) return showError('Google AI API 키를 입력해주세요.');
  if (currentSessionParticipants3 && !anthropicKey) return showError('3인 토론은 Anthropic(Claude) API 키를 입력해주세요.');

  saveApiKeysToStorage();

  const topic = currentSessionTopic;
  const mode = currentSessionMode;
  const participants3 = currentSessionParticipants3;

  const userLabel = mode === 'meeting' ? '소장 반박' : '사용자 반박';
  debateHistory.push({ speaker: 'user', name: participantName('user', mode), roundLabel: userLabel, text: userText });
  addUserBubble(userText, userLabel);

  const gptSys = buildGPTSystem(topic, mode);
  const gemSys = buildGeminiSystem(topic, mode);
  const claudeSys = participants3 ? buildClaudeSystem(topic, mode) : '';

  const contBtn = document.getElementById('continueAfterUserBtn');
  contBtn.disabled = true;
  contBtn.textContent = '⏳ 추가 라운드 진행 중...';
  document.getElementById('statusBadge').className = 'status-badge running';
  document.getElementById('statusBadge').textContent = '진행 중';
  document.getElementById('userInterventionCard').style.display = 'none';

  aborted = false;

  try {
    for (let r = 1; r <= extraRounds; r++) {
      if (aborted) break;
      const label = `추가 ${r} / ${extraRounds} 라운드`;
      document.getElementById('roundDisplay').textContent = label;

      const baseOrder = participants3 ? ['gpt', 'gem', 'claude'] : ['gpt', 'gem'];
      const order = rotatedOrder(baseOrder, r);

      for (const role of order) {
        if (aborted) break;

        addBubble(role, '', label, true);

        let userMsg;
        if (mode === 'meeting') {
          if (extraRounds === 1) {
            userMsg = `지금까지의 회의 내용:\n\n${historyText()}\n\n직전에 소장의 반박·추가 의견이 기록에 포함되어 있습니다. 이를 최우선으로 반영하세요.\n\n마지막 발언입니다. 이견을 좁히고 합의 가능한 최종 결론을 제안하세요. 상대방 발언에 오류나 허점이 있다면 [반박]으로 지적하세요.`;
            userMsg += '\n\n[회의 단계 — 마무리] 이견을 좁히고 실행 가능한 결론 쪽으로 모으세요. 실행·효과·리스크의 체계적 정리는 회의 종료 후 요약 보고서에서 합니다.';
          } else if (r === 1) {
            userMsg = `지금까지의 회의 내용:\n\n${historyText()}\n\n직전에 소장의 반박·추가 의견이 기록에 포함되어 있습니다. 이를 최우선으로 반영하세요.\n\n상대방 발언에 오류나 허점이 있다면 [반박]으로 지적하고, 합의 가능한 방향으로 의견을 발전시키세요.`;
            userMsg += meetingPhaseHint(r, extraRounds);
          } else if (r === extraRounds) {
            userMsg = `지금까지의 회의 내용:\n\n${historyText()}\n\n마지막 발언입니다. 이견을 좁히고 합의 가능한 최종 결론을 제안하세요.`;
            userMsg += meetingPhaseHint(r, extraRounds);
          } else {
            userMsg = `지금까지의 회의 내용:\n\n${historyText()}\n\n상대방 발언에 오류나 허점이 있다면 [반박]으로 지적하고, 합의 가능한 방향으로 의견을 발전시키세요.`;
            userMsg += meetingPhaseHint(r, extraRounds);
          }
        } else {
          userMsg = r === extraRounds
            ? `지금까지의 토론:\n\n${historyText()}\n\n마지막 발언입니다. 논의를 정리하고 종합 의견을 제시하세요.`
            : `지금까지의 토론:\n\n${historyText()}\n\n위 내용을 바탕으로 다음 발언을 하세요.`;
        }

        let text;
        if (role === 'gpt') {
          text = await callGPT(gptSys, userMsg, gptModel, openaiKey);
        } else if (role === 'gem') {
          const prompt = `${gemSys}\n\n${userMsg}`;
          text = await callGeminiWithRetry(prompt, geminiMdl, geminiKey, label);
        } else {
          text = await callClaudeWithRetry(claudeSys, userMsg, claudeModel, anthropicKey, label);
        }

        removeLoading();
        addBubble(role, text, label);
        debateHistory.push({ speaker: role, name: participantName(role, mode), roundLabel: label, text });
      }
    }

    if (!aborted && regenConclusion) await runConclusionStep(topic, mode, participants3, gptModel, openaiKey);

    if (!aborted) {
      document.getElementById('statusBadge').className = 'status-badge done';
      document.getElementById('statusBadge').textContent = '완료';
      document.getElementById('roundDisplay').textContent = `추가 ${extraRounds} / ${extraRounds} 라운드`;
      document.getElementById('userInterventionCard').style.display = 'block';
      document.getElementById('userRebuttalInput').value = '';
    }
  } catch (err) {
    removeLoading();
    showError(err.message);
    document.getElementById('statusBadge').className = 'status-badge error';
    document.getElementById('statusBadge').textContent = '오류';
    document.getElementById('userInterventionCard').style.display = 'block';
  } finally {
    contBtn.disabled = false;
    contBtn.textContent = '반박 추가 후 재개';
    if (!aborted) document.getElementById('saveBtn').style.display = 'block';
  }
}

function restart() {
  aborted = true;
  debateHistory = [];
  currentSessionTopic = '';
  currentSessionMode = '';
  currentSessionParticipants3 = false;
  document.getElementById('debateColumn').classList.remove('debate-active');
  document.getElementById('debateArea').classList.remove('visible');
  document.getElementById('messages').innerHTML = '';
  document.getElementById('userInterventionCard').style.display = 'none';
  document.getElementById('userRebuttalInput').value = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ────────────────────────────────
   히스토리 저장 / 불러오기
──────────────────────────────── */
const HISTORY_API_BASE = (() => {
  const host = window.location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  return isLocal ? 'https://bsl-debate.vercel.app' : '';
})();

function historyApi(path) {
  return `${HISTORY_API_BASE}${path}`;
}

function setFactCheckVisible(visible) {
  const card = document.getElementById('factCheckCard');
  if (!card) return;
  card.style.display = visible ? 'block' : 'none';
}

function verdictClass(verdict) {
  const v = String(verdict || '').toLowerCase();
  if (v.includes('근거 있음') || v.includes('supported')) return 'supported';
  if (v.includes('일부') || v.includes('partial')) return 'partial';
  if (v.includes('반박') || v.includes('contradicted')) return 'contradicted';
  return 'unclear';
}

function renderFactCheckReport(report) {
  const body = document.getElementById('factCheckBody');
  if (!body) return;

  const items = Array.isArray(report?.items) ? report.items : [];
  const notes = Array.isArray(report?.notes) ? report.notes : [];

  if (items.length === 0) {
    body.innerHTML = '<div class="hint">검증할 만한 주장(팩트)이 발견되지 않았습니다.</div>';
    return;
  }

  const list = document.createElement('div');
  list.className = 'factcheck-list';

  items.forEach((it) => {
    const claim = String(it.claim || '').trim();
    const verdict = String(it.verdict || '불확실').trim();
    const reason = String(it.reason || '').trim();
    const sources = Array.isArray(it.sources) ? it.sources : [];

    const wrap = document.createElement('div');
    wrap.className = 'factcheck-item';
    wrap.innerHTML = `
      <div class="factcheck-head">
        <div class="factcheck-claim">${esc(claim)}</div>
        <div class="factcheck-verdict ${verdictClass(verdict)}">${esc(verdict)}</div>
      </div>
      <div class="factcheck-reason">${esc(reason)}</div>
      <div class="factcheck-sources"></div>
    `;
    const srcEl = wrap.querySelector('.factcheck-sources');
    sources.slice(0, 3).forEach((s) => {
      const a = document.createElement('a');
      a.href = s.url || s.link || '#';
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = s.title || s.url || s.link || '';
      srcEl.appendChild(a);
    });
    list.appendChild(wrap);
  });

  body.innerHTML = '';
  body.appendChild(list);
  if (notes.length) {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = `참고: ${notes.join(' / ')}`;
    body.appendChild(note);
  }
}

async function runFactCheckStep(topic, mode, gptModel, openaiKey) {
  setFactCheckVisible(true);
  const body = document.getElementById('factCheckBody');
  if (body) body.innerHTML = '<div class="hint">팩트체크 중... (검색 결과를 기반으로 요약합니다)</div>';

  const MAX_FACT_CLAIMS = 5;

  const claimExtractorSys = '당신은 토론 기록에서 검증 가능한 사실 주장(팩트)만 뽑는 도우미입니다. 반드시 한국어로, 반드시 JSON만 출력하세요.';
  const claimExtractorUser = `토론 주제: ${topic}\n토론 방식: ${mode}\n\n토론 기록:\n\n${historyText()}\n\n위 토론에서 \"검증 가능한 주장\"만 최대 ${MAX_FACT_CLAIMS}개 뽑으세요.\n규칙:\n- 의견/가치판단/신학적 해석/비유/정서 표현은 제외\n- 수치/연도/법·정책 내용/인용/사건 사실처럼 검색으로 확인 가능한 것만 포함\n- 각 주장마다 검색용 query도 함께 작성\n\n출력 형식(JSON):\n{\n  \"claims\": [\n    { \"claim\": \"...\", \"query\": \"...\", \"priority\": 1 }\n  ]\n}\n`;

  let extracted;
  try {
    const raw = await callGPT(claimExtractorSys, claimExtractorUser, gptModel, openaiKey);
    extracted = safeJsonParse(raw);
  } catch (e) {
    if (body) body.innerHTML = `<div class="hint">팩트 추출 실패: ${esc(e.message || String(e))}</div>`;
    return null;
  }

  const claims = Array.isArray(extracted?.claims) ? extracted.claims : [];
  const topClaims = claims
    .filter(c => c && c.claim && c.query)
    .slice(0, MAX_FACT_CLAIMS)
    .map(c => ({ claim: String(c.claim).trim(), query: String(c.query).trim(), priority: Number(c.priority || 1) }));

  if (topClaims.length === 0) {
    if (body) body.innerHTML = '<div class="hint">검증 가능한 주장(팩트)이 발견되지 않았습니다.</div>';
    return { items: [], notes: ['검증 가능한 주장 없음'] };
  }

  const searched = [];
  for (const c of topClaims) {
    try {
      const res = await fetch(historyApi(`/api/search?q=${encodeURIComponent(c.query)}`));
      const json = await res.json().catch(() => null);
      const results = Array.isArray(json?.results) ? json.results : [];
      searched.push({ ...c, results });
    } catch (_) {
      searched.push({ ...c, results: [] });
    }
  }

  const judgeSys = '당신은 사실검증 리포트를 작성하는 중립적인 분석가입니다. 반드시 한국어로, 반드시 JSON만 출력하세요.';
  const judgeUser = `토론 주제: ${topic}\n\n아래는 토론에서 뽑은 \"검증 가능한 주장\"과, 각 주장에 대한 웹 검색 결과(제목/요약/링크)입니다.\n검색 결과만을 근거로 판정하세요. 확실하지 않으면 \"불확실\"로 두세요.\n\n판정 라벨(한국어 중 택1): \"근거 있음\" | \"일부 근거\" | \"불확실\" | \"반박됨\"\n\n입력:\n${JSON.stringify({ claims: searched }, null, 2)}\n\n출력 형식(JSON):\n{\n  \"items\": [\n    {\n      \"claim\": \"...\",\n      \"verdict\": \"근거 있음|일부 근거|불확실|반박됨\",\n      \"reason\": \"1~2문장\",\n      \"sources\": [ {\"title\":\"...\",\"url\":\"...\"} ]\n    }\n  ],\n  \"notes\": [\"주의사항...\"]\n}\n`;

  let report;
  try {
    // 리포트는 길어지기 쉬워 잘림 방지용으로 토큰을 더 넉넉히 씁니다.
    const raw = await (async () => {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: gptModel,
          messages: [
            { role: 'system', content: judgeSys },
            { role: 'user', content: judgeUser },
          ],
          max_completion_tokens: 4096,
          temperature: 1,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`ChatGPT 오류: ${err.error?.message || res.status}`);
      }
      return (await res.json()).choices[0].message.content.trim();
    })();
    report = safeJsonParse(raw);
  } catch (e) {
    if (body) body.innerHTML = `<div class="hint">팩트체크 리포트 생성 실패: ${esc(e.message || String(e))}</div>`;
    return null;
  }

  renderFactCheckReport(report);
  return report;
}

async function saveConversation() {
  if (!debateHistory.length) return alert('저장할 대화 내용이 없습니다.');
  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = '⏳ 저장 중...';
  try {
    const title = (currentSessionTopic || '무제').slice(0, 60);
    const conclusion = document.getElementById('conclusionText').textContent || '';
    const payload = {
      title,
      data: {
        topic: currentSessionTopic,
        mode: currentSessionMode,
        participants3: currentSessionParticipants3,
        history: debateHistory,
        conclusion,
      },
    };
    const res = await fetch(historyApi('/api/conversations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`저장 실패 (${res.status})`);
    btn.textContent = '✅ 저장됨';
    await loadHistoryList();
    setTimeout(() => {
      btn.textContent = '💾 이 토론 저장';
      btn.disabled = false;
    }, 2000);
  } catch (e) {
    alert(`저장 오류: ${e.message}`);
    btn.textContent = '💾 이 토론 저장';
    btn.disabled = false;
  }
}

async function loadHistoryList() {
  const ul = document.getElementById('historyList');
  try {
    const res = await fetch(historyApi('/api/conversations'));
    if (!res.ok) throw new Error(String(res.status));
    const list = await res.json();
    ul.innerHTML = '';
    if (!Array.isArray(list) || list.length === 0) {
      ul.innerHTML = '<li class="history-empty">저장된 히스토리가 없습니다.</li>';
      return;
    }
    list.forEach(item => {
      const li = document.createElement('li');
      li.className = 'history-item';
      const date = new Date(item.created_at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
      li.innerHTML = `
        <button class="history-load-btn" title="${item.title}" onclick="loadConversation('${item.id}')">${item.title}</button>
        <span class="history-date">${date}</span>
        <button class="history-del-btn" title="삭제" onclick="deleteConversation('${item.id}', this)">✕</button>`;
      ul.appendChild(li);
    });
  } catch (_) {
    ul.innerHTML = '<li class="history-empty">불러오기 실패</li>';
  }
}

async function loadConversation(id) {
  try {
    const res = await fetch(historyApi(`/api/conversations/${id}`));
    if (!res.ok) throw new Error(String(res.status));
    const session = await res.json();
    if (!session) throw new Error('데이터 없음');

    const d = session.data;
    debateHistory = d.history || [];
    currentSessionTopic = d.topic || '';
    currentSessionMode = d.mode || 'freeform';
    currentSessionParticipants3 = !!d.participants3;

    document.getElementById('topicInput').value = currentSessionTopic;
    document.getElementById('modeSelect').value = currentSessionMode;
    document.getElementById('participantCount').value = currentSessionParticipants3 ? '3' : '2';
    syncParticipantUi();

    document.getElementById('debateColumn').classList.add('debate-active');
    document.getElementById('debateArea').classList.add('visible');
    document.getElementById('topicDisplay').textContent = currentSessionTopic;
    document.querySelector('.topic-label').textContent = currentSessionMode === 'meeting' ? '회의 안건' : '토론 주제';
    document.getElementById('messages').innerHTML = '';
    document.getElementById('conclusionCard').style.display = 'none';
    document.getElementById('statusBadge').className = 'status-badge done';
    document.getElementById('statusBadge').textContent = '완료';
    document.getElementById('roundDisplay').textContent = '불러옴';

    debateHistory.forEach(h => {
      const sp = h.speaker || 'gpt';
      if (sp === 'user') addUserBubble(h.text, h.roundLabel);
      else addBubble(sp, h.text, h.roundLabel);
    });

    if (d.conclusion) {
      document.getElementById('conclusionText').textContent = d.conclusion;
      document.getElementById('conclusionCard').style.display = 'block';
      document.getElementById('conclusionCard').querySelector('h3').textContent =
        currentSessionMode === 'meeting' ? '📋 벧엘소프트랩 회의 결과 보고서' : '📋 토론 결론 (GPT 정리)';
    }

    document.getElementById('restartBtn').style.display = 'block';
    document.getElementById('saveBtn').style.display = 'none';
    document.getElementById('userInterventionCard').style.display = 'block';
    document.getElementById('userRebuttalInput').value = '';
    hideError();

    document.getElementById('debateArea').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    alert(`불러오기 오류: ${e.message}`);
  }
}

async function deleteConversation(id, btn) {
  if (!confirm('이 히스토리를 삭제할까요?')) return;
  btn.disabled = true;
  try {
    const res = await fetch(historyApi(`/api/conversations/${id}`), { method: 'DELETE' });
    if (!res.ok) throw new Error(String(res.status));
    await loadHistoryList();
  } catch (e) {
    alert(`삭제 오류: ${e.message}`);
    btn.disabled = false;
  }
}

/* 오른쪽 패널 탭 */
function setRightPanelTab(tab) {
  const debateView = document.getElementById('debateView');
  const settingsView = document.getElementById('settingsView');
  const tDebate = document.getElementById('tabDebate');
  const tSettings = document.getElementById('tabSettings');
  if (!debateView || !settingsView || !tDebate || !tSettings) return;

  const isSettings = tab === 'settings';
  debateView.classList.toggle('visible', !isSettings);
  settingsView.classList.toggle('visible', isSettings);
  tDebate.classList.toggle('active', !isSettings);
  tSettings.classList.toggle('active', isSettings);
  tDebate.setAttribute('aria-selected', String(!isSettings));
  tSettings.setAttribute('aria-selected', String(isSettings));
}

/* 초기화 */
function init() {
  loadApiKeysFromStorage();
  syncParticipantUi();
  setFactCheckVisible(false);

  document.getElementById('openaiKey')?.addEventListener('change', saveApiKeysToStorage);
  document.getElementById('geminiKey')?.addEventListener('change', saveApiKeysToStorage);
  document.getElementById('anthropicKey')?.addEventListener('change', saveApiKeysToStorage);
  document.getElementById('participantCount')?.addEventListener('change', syncParticipantUi);
  document.getElementById('clearStoredKeys')?.addEventListener('click', clearStoredApiKeys);

  document.getElementById('tabDebate')?.addEventListener('click', () => setRightPanelTab('debate'));
  document.getElementById('tabSettings')?.addEventListener('click', () => setRightPanelTab('settings'));

  loadHistoryList();
  setRightPanelTab('debate');
}

document.addEventListener('DOMContentLoaded', init);

