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

// ---- 更多防御性 warning（⍺：仅提示不阻断，配置偏离合理形态时提醒） ----

// 语录组条数过少，避免反馈内容显得单薄
checks.push(makeCheck({
  id: 'quote-group-thin',
  gate: 'quotes',
  severity: 'warning',
  describe: '语录组条数 ≥3，避免反馈单调',
  run: () => {
    const thin = [];
    for (const [key, group] of Object.entries(spec.experience?.quotes ?? {})) {
      if (Array.isArray(group.quotes) && group.quotes.length >= 1 && group.quotes.length < 3) thin.push(`状态语录 ${key}(${group.quotes.length})`);
    }
    for (const it of spec.experience?.interactions ?? []) {
      if (Array.isArray(it.feedback) && it.feedback.length >= 1 && it.feedback.length < 3) thin.push(`互动反馈 ${it.id}(${it.feedback.length})`);
    }
    return { passed: thin.length === 0, detail: thin.length ? `条数偏少: ${thin.join('; ')}` : '语录组均 ≥3 条' };
  },
}));

// 互动时长 vs 一次完整动画周期：超过 3 轮循环通常意味着动画将重复多遍，确认是否有意
checks.push(makeCheck({
  id: 'interaction-duration-excess',
  gate: 'motion',
  severity: 'warning',
  describe: '互动时长不超过 3 个完整动画周期',
  run: () => {
    const excess = [];
    for (const interaction of spec.experience.interactions ?? []) {
      const state = stateById.get(interaction.stateId);
      if (!state) continue;
      const cycleMs = state.frames.length * (state.frameDurationMs ?? 0);
      if (cycleMs > 0 && interaction.durationMs > cycleMs * 3) {
        excess.push(`${interaction.id}: ${interaction.durationMs}ms ≈ ${(interaction.durationMs / cycleMs).toFixed(1)} 个周期`);
      }
    }
    return { passed: excess.length === 0, detail: excess.length ? `动画重复过多轮: ${excess.join('; ')}` : '时长在合理范围' };
  },
}));

// 非互动状态越级全通配（*）：普通状态仅在确实需要绝对打断权时才该越级
checks.push(makeCheck({
  id: 'caninterrupt-star-broadcast',
  gate: 'interrupt-matrix',
  severity: 'warning',
  describe: '非互动状态持有全通配(*) 的不超过 1 个（通常仅 notify）',
  run: () => {
    const interactionStateIds = new Set((spec.experience.interactions ?? []).map((it) => it.stateId));
    const wildcard = spec.states
      .filter((state) => !interactionStateIds.has(state.id) && (state.canInterrupt ?? []).includes('*'))
      .map((state) => state.id);
    return { passed: wildcard.length <= 1, detail: wildcard.length > 1 ? `普通状态越级全通配: ${wildcard.join(', ')}` : '全通配状态克制' };
  },
}));

// 打断名单包含自身 id：属冗余（自己不能打断自己成环），也应移除
checks.push(makeCheck({
  id: 'caninterrupt-self',
  gate: 'interrupt-matrix',
  severity: 'warning',
  describe: 'canInterrupt 名单不应包含自身 id（自引用成环/冗余）',
  run: () => {
    const selfies = spec.states.filter((state) => (state.canInterrupt ?? []).includes(state.id)).map((state) => state.id);
    return { passed: selfies.length === 0, detail: selfies.length ? `名单含自身: ${selfies.join(', ')}` : '无自引用' };
  },
}));

// 同组语录重复文本：去重后实际条数会缩水，内容可能单调
checks.push(makeCheck({
  id: 'quotes-duplicate-in-group',
  gate: 'quotes',
  severity: 'warning',
  describe: '同一语录组/互动反馈内不存在重复文本',
  run: () => {
    const duplicated = [];
    for (const [key, group] of Object.entries(spec.experience?.quotes ?? {})) {
      const items = Array.isArray(group.quotes) ? group.quotes : [];
      if (new Set(items).size !== items.length) duplicated.push(`状态语录 ${key}`);
    }
    for (const it of spec.experience?.interactions ?? []) {
      const items = Array.isArray(it.feedback) ? it.feedback : [];
      if (new Set(items).size !== items.length) duplicated.push(`互动反馈 ${it.id}`);
    }
    return { passed: duplicated.length === 0, detail: duplicated.length ? `存在重复文本: ${duplicated.join(', ')}` : '语录组内无重复' };
  },
}));

// 单帧时长过短：低于 ~80ms 时动画肉眼易闪烁
checks.push(makeCheck({
  id: 'frame-duration-flicker',
  gate: 'motion',
  severity: 'warning',
  describe: '帧时长(frameDurationMs) ≥ 80ms，避免动画闪烁',
  run: () => {
    const flicker = spec.states.filter((state) => (state.frameDurationMs ?? 0) > 0 && state.frameDurationMs < 80).map((state) => `${state.id}(${state.frameDurationMs}ms)`);
    return { passed: flicker.length === 0, detail: flicker.length ? `帧时长过短: ${flicker.join(', ')}` : '帧时长均在合理范围' };
  },
}));

// loop 状态单轮周期过短：单轮 <1.5s 的循环看起来急促、像卡顿
checks.push(makeCheck({
  id: 'loop-cycle-brisk',
  gate: 'motion',
  severity: 'warning',
  describe: 'loop 状态单轮动画周期 ≥1500ms，避免循环显得急促',
  run: () => {
    const brisk = spec.states
      .filter((state) => state.loop)
      .map((state) => { const cycle = state.frames.length * (state.frameDurationMs ?? 0); return { id: state.id, cycle }; })
      .filter(({ cycle }) => cycle > 0 && cycle < 1500)
      .map(({ id, cycle }) => `${id}(${cycle}ms)`);
    return { passed: brisk.length === 0, detail: brisk.length ? `循环偏急促: ${brisk.join(', ')}` : 'loop 周期均在合理范围' };
  },
}));

const ok = await runChecks({ name: 'Experience QA', reportFile: 'experience-report.json', checks });
if (!ok) process.exit(1);

console.log(`      (${spec.states.length} states, ${triggerOwners.size} triggers, ${spec.experience.interactions.length} interactions)`);