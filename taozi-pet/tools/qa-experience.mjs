import { makeCheck, runChecks, loadSpec } from './qa-common.mjs';

const spec = await loadSpec();

const stateById = new Map(spec.states.map((state) => [state.id, state]));
const triggerOwners = new Map();
for (const state of spec.states) {
  for (const trigger of state.triggers ?? []) {
    if (!triggerOwners.has(trigger)) triggerOwners.set(trigger, state.id);
  }
}

const checks = [];

// ---- interrupt-matrix（canInterrupt 名单完整性） ----
checks.push(makeCheck({
  id: 'caninterrupt-id-exists',
  gate: 'interrupt-matrix',
  describe: 'canInterrupt 引用的每个状态 id 必须存在于 states 中',
  run: () => {
    const bad = [];
    for (const state of spec.states) {
      for (const target of state.canInterrupt ?? []) {
        if (target !== '*' && !stateById.has(target)) bad.push(`${state.id} -> ${target}`);
      }
    }
    return { passed: bad.length === 0, detail: bad.length ? `引用不存在状态: ${bad.join('; ')}` : '全部合法' };
  },
}));

checks.push(makeCheck({
  id: 'caninterrupt-live-lock',
  gate: 'interrupt-matrix',
  severity: 'warning',
  describe: 'no 无限循环（loop）+ 全通配（*）的永久卡死态',
  run: () => {
    const stuck = spec.states.filter((state) => state.loop && (state.canInterrupt ?? []).includes('*')).map((state) => state.id);
    return {
      passed: stuck.length === 0,
      detail: stuck.length ? `${stuck.join(', ')} 为 loop 且名单含 '*'：进入后无法被打断回 idle，建议有限时长或让出打断权` : '无卡死态',
    };
  },
}));

checks.push(makeCheck({
  id: 'caninterrupt-idle-redundant',
  gate: 'interrupt-matrix',
  severity: 'warning',
  describe: '名单含 idle 属冗余（idle 本就可被任意状态抢占）',
  run: () => {
    const redundant = spec.states.filter((state) => state.id !== 'idle' && (state.canInterrupt ?? []).includes('idle')).map((state) => state.id);
    return { passed: redundant.length === 0, detail: redundant.length ? `可移除 idle 的状态: ${redundant.join(', ')}` : '无冗余' };
  },
}));

checks.push(makeCheck({
  id: 'caninterrupt-covering',
  gate: 'interrupt-matrix',
  severity: 'warning',
  describe: '每个非 idle 状态都至少被一个其它状态可打断（防被遗忘孤立）',
  run: () => {
    const overlooked = spec.states
      .filter((state) => state.id !== 'idle')
      .filter((state) => !spec.states.some((other) => other.id !== state.id && ((other.canInterrupt ?? []).includes('*') || (other.canInterrupt ?? []).includes(state.id))))
      .map((state) => state.id);
    return { passed: overlooked.length === 0, detail: overlooked.length ? `无人可打断: ${overlooked.join(', ')}` : '所有状态均有 back-reach' };
  },
}));

// ---- interaction ----
checks.push(makeCheck({
  id: 'interaction-connected',
  gate: 'interaction',
  describe: '菜单动作的 trigger 与互动状态的 stateId 连通',
  run: () => {
    const broken = [];
    for (const interaction of spec.experience.interactions ?? []) {
      if (triggerOwners.get(`interaction:${interaction.id}`) !== interaction.stateId) broken.push(`${interaction.id}: trigger 与 stateId 未连通`);
    }
    return { passed: broken.length === 0, detail: broken.length ? broken.join('; ') : '全部连通' };
  },
}));

// ---- motion ----
checks.push(makeCheck({
  id: 'interaction-frames-min',
  gate: 'motion',
  describe: '每个互动状态的去重帧数 ≥ 6',
  run: () => {
    const weak = [];
    for (const interaction of spec.experience.interactions ?? []) {
      const state = stateById.get(interaction.stateId);
      if (state) {
        const unique = new Set(state.frames).size;
        if (unique < 6) weak.push(`${interaction.stateId}(${unique})`);
      }
    }
    return { passed: weak.length === 0, detail: weak.length ? `帧数不足: ${weak.join(', ')}` : '全部 ≥6' };
  },
}));

checks.push(makeCheck({
  id: 'motion-procedural',
  gate: 'motion',
  describe: 'breathing / squashStretch 至少启用一项',
  run: () => {
    const breathing = Boolean(spec.motion?.breathing?.enabled);
    const squash = Boolean(spec.motion?.squashStretch?.enabled);
    return { passed: breathing || squash, detail: `breathing:${breathing} squashStretch:${squash}` };
  },
}));

// ---- quotes（新增：语录一致性） ----
checks.push(makeCheck({
  id: 'quote-sync',
  gate: 'quotes',
  describe: '状态语录与互动反馈语录均非空（每组 ≥1 条）',
  run: () => {
    const emptyGroups = Object.entries(spec.experience?.quotes ?? {})
      .filter(([, group]) => !Array.isArray(group.quotes) || group.quotes.length === 0)
      .map(([key]) => key);
    const emptyFeedback = (spec.experience?.interactions ?? [])
      .filter((it) => !Array.isArray(it.feedback) || it.feedback.length === 0)
      .map((it) => it.id);
    const problems = [...emptyGroups.map((k) => `语录组 ${k}`), ...emptyFeedback.map((k) => `互动 ${k}`)];
    return { passed: problems.length === 0, detail: problems.length ? `空语录: ${problems.join(', ')}` : '语录组均非空' };
  },
}));

const ok = await runChecks({ name: 'Experience QA', reportFile: 'experience-report.json', checks });
if (!ok) process.exit(1);

console.log(`      (${spec.states.length} states, ${triggerOwners.size} triggers, ${spec.experience.interactions.length} interactions)`);