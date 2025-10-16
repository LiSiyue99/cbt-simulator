// 简易学生端前端逻辑（用于联调与验证功能，不替代你的正式前端）
// 默认 API 地址可通过 window.API_BASE 覆盖

(function () {
  const API_BASE = window.API_BASE || (location.hostname.includes('aiforcbt.online') ? 'https://api.aiforcbt.online' : 'http://localhost:3000');
  let token = localStorage.getItem('jwt') || '';
  let state = {
    email: '',
    roles: [],
    currentVisitorInstanceId: '',
    visitorInstanceIds: [],
    currentSessionId: '',
    homeworkSet: null,
  };

  const qs = (sel) => document.querySelector(sel);
  const $ = {
    userInfo: qs('#user-info'),
    login: qs('#login-section'),
    email: qs('#email-input'),
    code: qs('#code-input'),
    btnReq: qs('#btn-request-code'),
    btnVerify: qs('#btn-verify-code'),
    loginHint: qs('#login-hint'),

    visitor: qs('#visitor-section'),
    visitorSelect: qs('#visitor-select'),
    btnRefreshVisitor: qs('#btn-refresh-visitor'),
    btnResumeStart: qs('#btn-resume-or-start'),
    sessionLabel: qs('#session-label'),

    chat: qs('#chat-section'),
    chatHistory: qs('#chat-history'),
    chatInput: qs('#chat-input'),
    btnSend: qs('#btn-send'),
    btnFinalize: qs('#btn-finalize'),
    chatHint: qs('#chat-hint'),

    homework: qs('#homework-section'),
    homeworkFields: qs('#homework-fields'),
    btnHomeworkSubmit: qs('#btn-submit-homework'),
    homeworkHint: qs('#homework-hint'),

    sessions: qs('#sessions-section'),
    btnLoadSessions: qs('#btn-load-sessions'),
    sessionsList: qs('#sessions-list'),
  };

  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  async function api(path, { method = 'GET', body, headers = {} } = {}) {
    const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(API_BASE + path, opts);
    const txt = await res.text();
    let data;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = { error: 'bad_json', raw: txt }; }
    if (!res.ok) throw Object.assign(new Error((data && data.error) || res.statusText), { status: res.status, data });
    return data;
  }

  function renderChat(turns) {
    $.chatHistory.innerHTML = '';
    (turns || []).forEach((t) => {
      const div = document.createElement('div');
      div.className = 'message ' + (t.speaker === 'user' ? 'user' : 'ai');
      div.textContent = `${t.speaker === 'user' ? '我' : 'AI'}：${t.content}`;
      $.chatHistory.appendChild(div);
    });
    $.chatHistory.scrollTop = $.chatHistory.scrollHeight;
  }

  async function afterLogin() {
    hide($.login);
    show($.visitor);
    $.userInfo.textContent = `${state.email} 已登录`;
    await loadMeAndVisitors();
  }

  async function loadMeAndVisitors() {
    try {
      const me = await api('/me');
      state.roles = me.roles || (me.role ? [me.role] : []);
      state.visitorInstanceIds = me.visitorInstanceIds || [];
      state.currentVisitorInstanceId = me.currentVisitor?.instanceId || state.visitorInstanceIds[0] || '';
      $.visitorSelect.innerHTML = '';
      for (const vid of state.visitorInstanceIds) {
        const opt = document.createElement('option');
        opt.value = vid;
        opt.textContent = vid === state.currentVisitorInstanceId ? `${vid}（当前）` : vid;
        $.visitorSelect.appendChild(opt);
      }
      $.visitorSelect.value = state.currentVisitorInstanceId || '';
      show($.sessions);
    } catch (e) {
      $.loginHint.textContent = '读取用户信息失败：' + (e.data?.error || e.message);
    }
  }

  async function resumeOrStart() {
    const vid = $.visitorSelect.value || state.currentVisitorInstanceId;
    if (!vid) { $.chatHint.textContent = '没有可用访客实例'; return; }
    try {
      const last = await api(`/sessions/last?visitorInstanceId=${encodeURIComponent(vid)}`);
      if (last && !last.finalizedAt) {
        state.currentSessionId = last.id || last.sessionId || '';
        $.sessionLabel.textContent = `正在进行：第 ${last.sessionNumber} 次会话`;
      } else {
        const started = await api('/sessions/start', { method: 'POST', body: { visitorInstanceId: vid } });
        state.currentSessionId = started.sessionId;
        $.sessionLabel.textContent = `已开始：第 ${started.sessionNumber} 次会话`;
      }
      await loadSessionDetail();
      show($.chat);
      show($.homework);
    } catch (e) {
      $.chatHint.textContent = '开始/继续会话失败：' + (e.data?.message || e.data?.error || e.message);
    }
  }

  async function loadSessionDetail() {
    if (!state.currentSessionId) return;
    try {
      const s = await api(`/sessions/${state.currentSessionId}`);
      renderChat(s.chatHistory || []);
      await loadHomeworkForSession();
    } catch (e) {
      $.chatHint.textContent = '读取会话详情失败：' + (e.data?.error || e.message);
    }
  }

  async function sendMessage() {
    const content = $.chatInput.value.trim();
    if (!content) return;
    if (!state.currentSessionId) { $.chatHint.textContent = '尚未开始会话'; return; }
    try {
      // 先追加用户消息到界面（本地）
      const turnsNow = Array.from($.chatHistory.querySelectorAll('.message')).map(el => ({
        speaker: el.classList.contains('user') ? 'user' : 'ai',
        content: el.textContent.replace(/^我：|^AI：/, ''),
      }));
      turnsNow.push({ speaker: 'user', content });
      renderChat(turnsNow);

      const resp = await api(`/sessions/${state.currentSessionId}/messages`, { method: 'POST', body: { speaker: 'user', content } });
      const aiContent = (resp && typeof resp.content === 'string') ? resp.content : '';
      const ai = resp.aiResponse || { speaker: 'ai', content: aiContent };
      turnsNow.push({ speaker: 'ai', content: ai.content });
      renderChat(turnsNow);
      $.chatInput.value = '';
      $.chatHint.textContent = '';
    } catch (e) {
      $.chatHint.textContent = '发送失败：' + (e.data?.error || e.message);
    }
  }

  async function finalizeSession() {
    if (!state.currentSessionId) return;
    try {
      const out = await api(`/sessions/${state.currentSessionId}/finalize`, { method: 'POST', body: {} });
      $.chatHint.textContent = '已结束对话，系统将生成日记与活动';
      // 结束后尝试刷新详情
      setTimeout(loadSessionDetail, 1000);
    } catch (e) {
      $.chatHint.textContent = '结束失败：' + (e.data?.error || e.message);
    }
  }

  async function loadHomeworkForSession() {
    try {
      const data = await api(`/homework/sets/by-session?sessionId=${encodeURIComponent(state.currentSessionId)}`);
      const item = data.item;
      state.homeworkSet = item || null;
      $.homeworkFields.innerHTML = '';
      if (!item) {
        $.homeworkHint.textContent = '当前会话暂无作业';
        return;
      }
      $.homeworkHint.textContent = `作业窗口：${new Date(item.studentStartAt).toLocaleString()} - ${new Date(item.studentDeadline).toLocaleString()}`;
      const fields = (item.formFields || []);
      fields.forEach((f) => {
        const row = document.createElement('div');
        row.className = 'row';
        const label = document.createElement('label');
        label.textContent = f.label || f.key;
        const input = document.createElement(f.type === 'textarea' ? 'textarea' : 'input');
        input.dataset.key = f.key;
        input.placeholder = f.placeholder || '';
        row.appendChild(label);
        row.appendChild(input);
        $.homeworkFields.appendChild(row);
      });
    } catch (e) {
      $.homeworkHint.textContent = '读取作业失败：' + (e.data?.error || e.message);
    }
  }

  async function submitHomework() {
    if (!state.homeworkSet) { $.homeworkHint.textContent = '暂无作业'; return; }
    try {
      const formData = {};
      const inputs = $.homeworkFields.querySelectorAll('input,textarea');
      inputs.forEach((el) => { formData[el.dataset.key] = el.value; });
      const resp = await api('/homework/submissions', {
        method: 'POST',
        body: { sessionId: state.currentSessionId, homeworkSetId: state.homeworkSet.id, formData }
      });
      $.homeworkHint.textContent = '提交成功';
    } catch (e) {
      if (e.status === 409) $.homeworkHint.textContent = '重复提交：已存在该会话的作业';
      else $.homeworkHint.textContent = '提交失败：' + (e.data?.error || e.message);
    }
  }

  async function loadSessionsList() {
    const vid = $.visitorSelect.value || state.currentVisitorInstanceId;
    if (!vid) { return; }
    try {
      const res = await api(`/sessions/list?visitorInstanceId=${encodeURIComponent(vid)}&includePreview=true&page=1&pageSize=20`);
      $.sessionsList.innerHTML = '';
      (res.items || []).forEach((it) => {
        const li = document.createElement('li');
        const status = it.completed ? '已完成' : '进行中';
        const lastMsg = it.lastMessage ? `（最后：${it.lastMessage.speaker === 'user' ? '我' : 'AI'}：${it.lastMessage.content.slice(0, 24)}）` : '';
        li.textContent = `第${it.sessionNumber}次 · ${status} · ${new Date(it.createdAt).toLocaleString()} ${lastMsg}`;
        $.sessionsList.appendChild(li);
      });
    } catch (e) {
      $.chatHint.textContent = '读取历史失败：' + (e.data?.error || e.message);
    }
  }

  // 事件绑定
  $.btnReq.addEventListener('click', async () => {
    $.loginHint.textContent = '';
    const email = $.email.value.trim().toLowerCase();
    if (!email) { $.loginHint.textContent = '请输入邮箱'; return; }
    try {
      const data = await api('/auth/request-code', { method: 'POST', body: { email } });
      state.email = email;
      $.loginHint.textContent = data.code ? `开发环境验证码：${data.code}` : '验证码已发送（生产环境应发送邮件）';
    } catch (e) {
      $.loginHint.textContent = '发送验证码失败：' + (e.data?.error || e.message);
    }
  });

  $.btnVerify.addEventListener('click', async () => {
    $.loginHint.textContent = '';
    const email = (state.email || $.email.value.trim().toLowerCase());
    const code = $.code.value.trim();
    if (!email || !code) { $.loginHint.textContent = '请输入邮箱和验证码'; return; }
    try {
      const data = await api('/auth/verify-code', { method: 'POST', body: { email, code } });
      token = data.token;
      localStorage.setItem('jwt', token);
      await afterLogin();
    } catch (e) {
      $.loginHint.textContent = '登录失败：' + (e.data?.error || e.message);
    }
  });

  $.btnRefreshVisitor.addEventListener('click', loadMeAndVisitors);
  $.btnResumeStart.addEventListener('click', resumeOrStart);
  $.btnSend.addEventListener('click', sendMessage);
  $.btnFinalize.addEventListener('click', finalizeSession);
  $.btnHomeworkSubmit.addEventListener('click', submitHomework);
  $.btnLoadSessions.addEventListener('click', loadSessionsList);

  // 若本地已有 token，尝试自动登录态
  if (token) {
    state.email = '(token)';
    afterLogin().catch(() => { /* ignore */ });
  }
})();